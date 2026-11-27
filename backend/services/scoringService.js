/**
 * CTFd-Exact Scoring Service
 * 
 * Implements CTFd's scoring algorithms with exact parity:
 * - Static scoring (fixed points)
 * - Linear dynamic scoring (arithmetic decay)
 * - Logarithmic dynamic scoring (exponential decay curve)
 * - Awards integration
 * - Proper tie-breaking rules
 */

const Challenge = require('../models/Challenge');
const Award = require('../models/Award');
const User = require('../models/User');
const Team = require('../models/Team');
const Submission = require('../models/Submission');
const mongoose = require('mongoose');
const { refreshUserPoints } = require('../utils/teamScore');
const { calculateChallengeValue, countsForValue } = require('../utils/scoringRules');

/**
 * Number of team solves that lower a challenge's value (excluding hidden/banned accounts)
 * @param {String} challengeId - Challenge ID
 * @param {Object} session - Optional MongoDB session
 * @returns {Promise<Number>} Solve count
 */
async function getValidSolveCount(challengeId, session = null) {
  const solves = await Submission.find({ challenge: challengeId, isCorrect: true, team: { $ne: null } })
    .select('user team')
    .session(session)
    .lean();
  if (!solves.length) return 0;

  const users = await User.find({ _id: { $in: solves.map(solve => solve.user) } })
    .select('role banned isBlocked hidden showInScoreboard').session(session).lean();
  const teams = await Team.find({ _id: { $in: solves.map(solve => solve.team) } })
    .select('banned isBlocked hidden').session(session).lean();
  const userById = new Map(users.map(user => [String(user._id), user]));
  const teamById = new Map(teams.map(team => [String(team._id), team]));

  return solves.filter(solve =>
    countsForValue(userById.get(String(solve.user)), teamById.get(String(solve.team)))
  ).length;
}

/**
 * Recalculate a dynamic challenge's value (CTFd-style).
 * Call this only after the solve has been committed: it runs in its own transaction.
 * Only updates challenge.points; scores are calculated dynamically via JOIN.
 * @param {String} challengeId - Challenge ID
 * @returns {Promise<Number>} New challenge value
 */
async function updateChallengeValue(challengeId) {
  const existing = await Challenge.findById(challengeId);
  if (!existing) {
    throw new Error('Challenge not found');
  }

  // Only update for dynamic challenges
  if (existing.function === 'static' || !existing.function) {
    return existing.points;
  }

  const session = await mongoose.startSession();
  let value = existing.points;
  let changed = false;
  let solverIds = [];
  try {
    await session.withTransaction(async () => {
      // Writing first locks the challenge, so the solve count read below stays current.
      const challenge = await Challenge.findByIdAndUpdate(
        challengeId,
        { $inc: { valueRevision: 1 } },
        { new: true, session }
      );
      if (!challenge) throw new Error('Challenge not found');

      const solveCount = await getValidSolveCount(challengeId, session);
      value = calculateChallengeValue(challenge, solveCount);
      changed = value !== challenge.points;
      solverIds = await Submission.distinct('user', { challenge: challengeId, isCorrect: true }).session(session);
      if (changed) {
        await Challenge.updateOne({ _id: challengeId }, { $set: { points: value } }, { session });
      }
    });
  } finally {
    await session.endSession();
  }

  // Every solver's score changes with the value.
  if (changed) {
    await refreshUserPoints(solverIds);
    console.log(`[CTFd Scoring] Challenge "${existing.title}" value is now ${value} pts`);
  }

  return value;
}

module.exports = {
  calculateChallengeValue,
  getValidSolveCount,
  updateChallengeValue
};
