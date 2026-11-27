/**
 * Scoring rules shared by flag submission, scoreboards, hint unlocking and admin tools.
 *
 * - A solve belongs to the player who submitted it and to the team they were in then
 *   (Submission.team). It never moves when the player changes teams.
 * - A team scores each challenge at most once.
 * - A player scores their own solves, whichever team they were in.
 * - Awards (including hint costs) work the same way: Award.team or Award.creditedTeam
 *   names the team, Award.user names the player.
 */
const mongoose = require('mongoose');
const Submission = require('../models/Submission');
const Award = require('../models/Award');
const User = require('../models/User');

// Aggregations do not cast strings to ObjectIds.
const toId = value => new mongoose.Types.ObjectId(String(value?._id || value));

// Admin accounts never score.
async function getNonPlayerIds(session = null) {
  const users = await User.find({ role: { $ne: 'user' } }).select('_id').session(session).lean();
  return users.map(user => user._id);
}

// Matches the correct solves that count for a team.
async function getTeamSolveQuery(teamId, session = null) {
  return { team: toId(teamId), isCorrect: true, user: { $nin: await getNonPlayerIds(session) } };
}

const sumSolvePoints = async (match, session) => {
  const [row] = await Submission.aggregate([
    { $match: match },
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

// Raw scores can be negative when an admin removes points that were already spent on hints.
// Check balances against the raw value and display it clamped to zero.
async function getTeamRawScore(teamId, session = null) {
  const solvePoints = await sumSolvePoints(await getTeamSolveQuery(teamId, session), session);
  const awardPoints = await sumAwardPoints(
    { $or: [{ team: toId(teamId) }, { creditedTeam: toId(teamId) }] },
    session
  );
  return solvePoints + awardPoints;
}

async function getUserRawScore(userId, session = null) {
  const solvePoints = await sumSolvePoints({ user: toId(userId), isCorrect: true }, session);
  const awardPoints = await sumAwardPoints({ user: toId(userId) }, session);
  return solvePoints + awardPoints;
}

// A challenge is closed to a player once they or their current team have solved it.
const solverScope = (userId, teamId) => (teamId
  ? { $or: [{ user: toId(userId) }, { team: toId(teamId) }] }
  : { user: toId(userId) });

async function hasSolved(challengeId, userId, teamId = null, session = null) {
  const solve = await Submission.exists({
    challenge: challengeId,
    isCorrect: true,
    ...solverScope(userId, teamId)
  }).session(session);
  return Boolean(solve);
}

async function getSolvedChallengeIds(userId, teamId = null) {
  return Submission.distinct('challenge', { isCorrect: true, ...solverScope(userId, teamId) });
}

// User.points is a stored copy of the player's score, used by profile and admin lists.
// Works in bulk because a dynamic value change affects every solver at once.
async function refreshUserPoints(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(id => String(id?._id || id)))].map(toId);
  if (!ids.length) return;

  const solves = await Submission.aggregate([
    { $match: { user: { $in: ids }, isCorrect: true } },
    { $lookup: { from: 'challenges', localField: 'challenge', foreignField: '_id', as: 'challengeData' } },
    { $unwind: '$challengeData' },
    { $group: { _id: '$user', total: { $sum: '$challengeData.points' } } }
  ]);
  const awards = await Award.aggregate([
    { $match: { user: { $in: ids } } },
    { $group: { _id: '$user', total: { $sum: '$value' } } }
  ]);

  const scores = new Map(ids.map(id => [String(id), 0]));
  [...solves, ...awards].forEach(row => scores.set(String(row._id), scores.get(String(row._id)) + row.total));

  await User.bulkWrite(ids.map(id => ({
    updateOne: { filter: { _id: id }, update: { $set: { points: Math.max(0, scores.get(String(id))) } } }
  })));
}

module.exports = {
  getNonPlayerIds,
  getTeamSolveQuery,
  getTeamRawScore,
  getUserRawScore,
  hasSolved,
  getSolvedChallengeIds,
  refreshUserPoints
};
