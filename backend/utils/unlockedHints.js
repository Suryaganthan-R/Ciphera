const Unlock = require('../models/Unlock');

// Unlocked hints with challenge details. Pass ObjectIds: aggregation does not cast strings.
async function listUnlockedHints(match) {
  return Unlock.aggregate([
    { $match: { ...match, type: 'hints' } },
    { $lookup: { from: 'challenges', localField: 'challenge', foreignField: '_id', as: 'challengeData' } },
    { $unwind: '$challengeData' },
    { $sort: { date: -1, _id: -1 } },
    {
      $project: {
        _id: 0,
        userId: '$user',
        challengeId: '$challenge',
        challengeName: '$challengeData.title',
        challengeCategory: '$challengeData.category',
        hintIndex: '$target',
        cost: { $ifNull: [{ $arrayElemAt: ['$challengeData.hints.cost', '$target'] }, 0] },
        unlockedAt: '$date'
      }
    }
  ]);
}

module.exports = { listUnlockedHints };
