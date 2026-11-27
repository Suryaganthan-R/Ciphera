/**
 * Admin score adjustments: mark a challenge as solved or unsolved for a team.
 * Team scores are calculated from submissions, so changing the solve changes the score.
 */
const mongoose = require('mongoose');
const Team = require('../models/Team');
const User = require('../models/User');
const Challenge = require('../models/Challenge');
const Submission = require('../models/Submission');
const scoringService = require('./scoringService');
const { getTeamRawScore, getVoidUserIds, refreshUserPoints } = require('../utils/teamScore');
const { isBannedUser } = require('../utils/scoringRules');
const { listUnlockedHints } = require('../utils/unlockedHints');
const { invalidateTeamPoints } = require('../utils/teamPointsCache');
const { getRedisClient, clearScoreboardCache } = require('../utils/redis');

const ADMIN_SOLVE_MARKER = 'Marked solved by admin';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const assertId = (id, label) => {
  if (!/^[0-9a-fA-F]{24}$/.test(String(id || ''))) throw httpError(400, `Invalid ${label}`);
};
const containsId = (list, id) => (list || []).some(item => String(item) === String(id));

async function getTeamScoreDetails(teamId) {
  assertId(teamId, 'team');
  const team = await Team.findById(teamId).select('name captain solvedChallenges').lean();
  if (!team) throw httpError(404, 'Team not found');

  const members = await User.find({ team: team._id })
    .select('username role banned isBlocked').sort({ username: 1 }).lean();
  // All solves recorded for the team, including void ones so the admin can clear them
  const voided = new Set((await getVoidUserIds()).map(String));
  const pointsFrom = (item, challenge) => (voided.has(String(item.user)) ? 0 : challenge.points);
  const submissions = await Submission.find({ team: team._id, isCorrect: true })
    .select('user challenge submittedAt submittedFlag')
    .sort({ submittedAt: 1 })
    .lean();
  const challenges = await Challenge.find().select('title category points').sort({ title: 1 }).lean();
  const hints = await listUnlockedHints({ team: team._id });
  const rawScore = await getTeamRawScore(team._id);

  // Solvers may have left the team since
  const solvers = await User.find({ _id: { $in: submissions.map(item => item.user) } }).select('username').lean();
  const usernames = new Map(solvers.map(user => [String(user._id), user.username]));
  const solved = [];
  const unsolved = [];
  const memberTotals = new Map();

  challenges.forEach(challenge => {
    const solves = submissions.filter(item => String(item.challenge) === String(challenge._id));
    const summary = { challengeId: challenge._id, title: challenge.title, category: challenge.category };

    solves.forEach(item => {
      const totals = memberTotals.get(String(item.user)) || { points: 0, solved: 0 };
      totals.points += pointsFrom(item, challenge);
      totals.solved += 1;
      memberTotals.set(String(item.user), totals);
    });

    if (!solves.length) {
      unsolved.push({ ...summary, points: challenge.points });
    }
    // Also list stale entries on the team record so the admin can clear them.
    if (solves.length || containsId(team.solvedChallenges, challenge._id)) {
      solved.push({
        ...summary,
        points: solves.reduce((sum, item) => sum + pointsFrom(item, challenge), 0),
        solvedBy: solves.map(item => usernames.get(String(item.user)) || 'Deleted user'),
        solvedAt: solves[0]?.submittedAt || null,
        addedByAdmin: solves.some(item => item.submittedFlag === ADMIN_SOLVE_MARKER)
      });
    }
  });

  return {
    team: { _id: team._id, name: team.name },
    score: Math.max(0, rawScore),
    pointsOwed: Math.max(0, -rawScore),
    hintsUnlocked: hints.length,
    members: members.map(member => ({
      _id: member._id,
      username: member.username,
      isCaptain: String(member._id) === String(team.captain),
      canBeCredited: member.role === 'user' && !isBannedUser(member),
      points: memberTotals.get(String(member._id))?.points || 0,
      solved: memberTotals.get(String(member._id))?.solved || 0,
      hints: hints.filter(hint => String(hint.userId) === String(member._id)).length
    })),
    solved,
    unsolved
  };
}

// Runs after the transaction commits: derived values and caches.
async function refreshAfterChange(teamId, challengeId, memberIds) {
  try {
    if (await Challenge.exists({ _id: challengeId })) {
      await scoringService.updateChallengeValue(challengeId);
    }
  } catch (error) {
    console.error('[TeamSolve] Could not update challenge value:', error.message);
  }

  await refreshUserPoints(memberIds);

  await invalidateTeamPoints(teamId);
  await clearScoreboardCache();
  try {
    if (memberIds.length) await getRedisClient().del(...memberIds.map(id => `user:${id}`));
  } catch (error) {
    console.error('[TeamSolve] Could not clear user cache:', error.message);
  }
}

// Locking the team makes concurrent solves and hint unlocks wait for each other.
const lockTeam = async (teamId, session) => {
  const team = await Team.findByIdAndUpdate(teamId, { $inc: { scoreRevision: 1 } }, { new: true, session });
  if (!team) throw httpError(404, 'Team not found');
  return team;
};

async function markSolved(teamId, challengeId, { userId, ipAddress } = {}) {
  assertId(teamId, 'team');
  assertId(challengeId, 'challenge');
  if (userId) assertId(userId, 'member');

  const session = await mongoose.startSession();
  let memberIds = [];
  try {
    await session.withTransaction(async () => {
      const team = await lockTeam(teamId, session);
      const challenge = await Challenge.findById(challengeId).session(session);
      if (!challenge) throw httpError(404, 'Challenge not found');

      const members = await User.find({ team: team._id })
        .select('_id role banned isBlocked').session(session).lean();
      const players = members.filter(member => member.role === 'user' && !isBannedUser(member));
      const existing = await Submission.exists({
        team: team._id,
        challenge: challenge._id,
        isCorrect: true
      }).session(session);
      if (existing) {
        throw httpError(409, 'This team already has a solve for that challenge. Mark it unsolved first to replace it.');
      }

      // A player has one solve per challenge, so prefer someone who has none yet.
      const ownSolves = await Submission.find({
        user: { $in: players.map(player => player._id) },
        challenge: challenge._id,
        isCorrect: true
      }).session(session);
      const solveOf = player => ownSolves.find(item => String(item.user) === String(player._id));
      const captain = players.find(player => String(player._id) === String(team.captain));
      const credited = userId
        ? players.find(player => String(player._id) === String(userId))
        : [captain, ...players].find(player => player && !solveOf(player)) || captain || players[0];
      if (!credited) {
        throw httpError(400, userId
          ? 'The selected member cannot be credited with this solve'
          : 'This team has no player who can be credited with the solve');
      }

      const solvedAt = new Date();
      const prior = solveOf(credited);
      if (prior) {
        if (prior.team && await Team.exists({ _id: prior.team }).session(session)) {
          throw httpError(409, 'That member\'s solve already counts for another team. Credit a different member.');
        }
        // Made without a team (or for a deleted one): move it to this team
        await Submission.updateOne({ _id: prior._id }, { $set: { team: team._id } }, { session });
      } else {
        await Submission.create([{
          user: credited._id,
          team: team._id,
          challenge: challenge._id,
          submittedFlag: ADMIN_SOLVE_MARKER,
          isCorrect: true,
          submittedAt: solvedAt,
          ipAddress,
          userAgent: 'admin-adjustment'
        }], { session });
      }

      memberIds = [credited._id];
      await User.updateOne(
        { _id: credited._id },
        { $addToSet: { solvedChallenges: challenge._id }, $inc: { scoreRevision: 1 } },
        { session }
      );
      await User.updateOne(
        { _id: credited._id, 'personallySolvedChallenges.challengeId': { $ne: challenge._id } },
        {
          $push: { personallySolvedChallenges: { challengeId: challenge._id, challengeTitle: challenge.title, solvedAt } },
          $set: { lastSolveTime: solvedAt }
        },
        { session }
      );
      await Team.updateOne({ _id: team._id }, { $addToSet: { solvedChallenges: challenge._id } }, { session });
      await Challenge.updateOne({ _id: challenge._id }, { $addToSet: { solvedBy: credited._id } }, { session });
    });
  } finally {
    await session.endSession();
  }

  await refreshAfterChange(teamId, challengeId, memberIds);
  return getTeamScoreDetails(teamId);
}

async function markUnsolved(teamId, challengeId) {
  assertId(teamId, 'team');
  assertId(challengeId, 'challenge');

  const session = await mongoose.startSession();
  let memberIds = [];
  try {
    await session.withTransaction(async () => {
      const team = await lockTeam(teamId, session);
      const solves = await Submission.find({ team: team._id, challenge: challengeId, isCorrect: true })
        .select('user')
        .session(session)
        .lean();
      if (!solves.length && !containsId(team.solvedChallenges, challengeId)) {
        throw httpError(404, 'This team has not solved that challenge');
      }
      memberIds = solves.map(solve => solve.user);

      await Submission.deleteMany({ _id: { $in: solves.map(solve => solve._id) } }, { session });
      await Team.updateOne({ _id: team._id }, { $pull: { solvedChallenges: challengeId } }, { session });
      await User.updateMany(
        { _id: { $in: memberIds } },
        {
          $pull: { solvedChallenges: challengeId, personallySolvedChallenges: { challengeId } },
          $inc: { scoreRevision: 1 }
        },
        { session }
      );
      await Challenge.updateOne({ _id: challengeId }, { $pull: { solvedBy: { $in: memberIds } } }, { session });
    });
  } finally {
    await session.endSession();
  }

  await refreshAfterChange(teamId, challengeId, memberIds);
  return getTeamScoreDetails(teamId);
}

module.exports = { getTeamScoreDetails, markSolved, markUnsolved };
