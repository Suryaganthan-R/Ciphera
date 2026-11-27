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

/**
 * Calculate current value of a challenge based on solve count
 * Uses CTFd-exact formulas with solve_count-1 adjustment
 * @param {Object} challenge - Challenge document
 * @param {Number} solveCount - Number of solves (excluding hidden/banned users)
 * @returns {Number} Current point value
 */
function calculateChallengeValue(challenge, solveCount = null) {
  // Static challenges always return base points
  if (challenge.function === 'static' || !challenge.function) {
    return challenge.points;
  }

  // For dynamic challenges
  const initial = challenge.initial ?? challenge.points;
  const minimum = challenge.minimum ?? challenge.points; // 0 is a valid minimum
  let decay = challenge.decay || 0;

  // If solveCount not provided, use challenge's solvedBy length
  if (solveCount === null) {
    solveCount = challenge.solvedBy?.length || 0;
  }

  // CTFd-exact: First solver gets max points (solve_count - 1)
  const adjustedSolveCount = solveCount > 0 ? solveCount - 1 : 0;

  let value;

  if (challenge.function === 'linear') {
    // CTFd Linear: value = initial - (decay * (solve_count - 1))
    value = initial - (decay * adjustedSolveCount);
  } else if (challenge.function === 'logarithmic') {
    // CTFd Logarithmic: value = (((minimum - initial) / (decay^2)) * ((solve_count-1)^2)) + initial
    if (decay === 0) {
      decay = 1; // Prevent division by zero
    }
    value = (((minimum - initial) / Math.pow(decay, 2)) * Math.pow(adjustedSolveCount, 2)) + initial;
  } else {
    value = challenge.points; // Fallback
  }

  // Ensure value doesn't go below minimum
  value = Math.max(minimum, value);

  return Math.ceil(value); // CTFd uses ceiling
}

/**
 * Get solve count for a challenge (excluding hidden/banned users)
 * @param {String} challengeId - Challenge ID
 * @param {Object} session - Optional MongoDB session
 * @returns {Promise<Number>} Solve count
 */
async function getValidSolveCount(challengeId, session = null) {
  const challenge = await Challenge.findById(challengeId)
    .populate({ path: 'solvedBy', select: 'hidden banned role' })
    .session(session);

  if (!challenge) return 0;

  // Count only non-hidden, non-banned users
  const validSolves = challenge.solvedBy?.filter(user =>
    user.role === 'user' && !user.hidden && !user.banned
  ).length || 0;

  return validSolves;
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
      solverIds = challenge.solvedBy || [];
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
