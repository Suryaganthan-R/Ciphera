/**
 * Score and solve lookups shared by hint unlocking, team pages and admin tools.
 * Scores follow the scoreboard: solves by current members plus awards.
 */
const Submission = require('../models/Submission');
const Award = require('../models/Award');
const User = require('../models/User');

const sumSolvePoints = async (userIds, session) => {
  const [row] = await Submission.aggregate([
    { $match: { user: { $in: userIds }, isCorrect: true } },
    { $lookup: { from: 'challenges', localField: 'challenge', foreignField: '_id', as: 'challengeData' } },
    { $unwind: '$challengeData' },
    { $group: { _id: null, total: { $sum: '$challengeData.points' } } }
  ]).session(session);
  return row?.total || 0;
};

const sumAwardPoints = async (match, session) => {
  const [row] = await Award.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$value' } } }
  ]).session(session);
  return row?.total || 0;
};

// Raw scores can be negative when hint costs exceed the points still held.
// Check balances against the raw value and display it clamped to zero.
async function getTeamRawScore(teamId, session = null) {
  const members = await User.find({ team: teamId }).select('_id role').session(session).lean();
  const solverIds = members.filter(member => member.role === 'user').map(member => member._id);
  const solvePoints = await sumSolvePoints(solverIds, session);
  const awardPoints = await sumAwardPoints(
    { $or: [{ team: teamId }, { user: { $in: members.map(member => member._id) } }] },
    session
  );
  return solvePoints + awardPoints;
}

async function getUserRawScore(userId, session = null) {
  const solvePoints = await sumSolvePoints([userId], session);
  const awardPoints = await sumAwardPoints({ user: userId }, session);
  return solvePoints + awardPoints;
}

// True when the user, or any member of their team, has already solved the challenge.
async function hasSolved(challengeId, user, team = null, session = null) {
  const includes = list => (list || []).some(id => String(id) === String(challengeId));
  if (includes(user.solvedChallenges) || includes(team?.solvedChallenges)) return true;

  let userIds = [user._id];
  if (team) {
    const members = await User.find({ team: team._id }).select('_id').session(session).lean();
    userIds = members.map(member => member._id);
  }
  const solve = await Submission.exists({ user: { $in: userIds }, challenge: challengeId, isCorrect: true })
    .session(session);
  return Boolean(solve);
}

module.exports = { getTeamRawScore, getUserRawScore, hasSolved };
