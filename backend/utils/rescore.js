/**
 * Call after anything that changes which solves count: bans, hiding, deletions, role changes.
 */
const Challenge = require('../models/Challenge');
const User = require('../models/User');
const scoringService = require('../services/scoringService');
const { refreshUserPoints } = require('./teamScore');
const { clearScoreboardCache } = require('./redis');

async function rescore() {
  try {
    const dynamic = await Challenge.find({ function: { $in: ['linear', 'logarithmic'] } }).select('_id').lean();
    for (const challenge of dynamic) {
      await scoringService.updateChallengeValue(challenge._id);
    }
    const users = await User.find().select('_id').lean();
    await refreshUserPoints(users.map(user => user._id));
    await clearScoreboardCache();
  } catch (error) {
    // The change itself is saved; values are recalculated again on the next solve.
    console.error('[Scoring] Could not recalculate scores:', error.message);
  }
}

module.exports = { rescore };
