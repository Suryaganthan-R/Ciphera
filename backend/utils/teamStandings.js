const Team = require('../models/Team');
const Submission = require('../models/Submission');
const Award = require('../models/Award');

const compareTeamStandings = (a, b) => {
  if (b.score !== a.score) return b.score - a.score;
  const aDate = new Date(a.date || 0).getTime();
  const bDate = new Date(b.date || 0).getTime();
  if (aDate !== bDate) return aDate - bDate;
  return String(a.account_id).localeCompare(String(b.account_id));
};

async function aggregateTeamStandings(isAdmin = false, freezeTime = null, limit = null) {
  const matchStage = { isCorrect: true };
  if (freezeTime) matchStage.submittedAt = { $lt: new Date(freezeTime) };

  const teamSolves = await Submission.aggregate([
    { $match: matchStage },
    {
      $lookup: {
        from: 'challenges',
        localField: 'challenge',
        foreignField: '_id',
        as: 'challengeData'
      }
    },
    { $unwind: '$challengeData' },
    { $match: { 'challengeData.points': { $ne: 0 } } },
    {
      $lookup: {
        from: 'users',
        localField: 'user',
        foreignField: '_id',
        as: 'userInfo'
      }
    },
    { $unwind: '$userInfo' },
    { $match: { 'userInfo.team': { $exists: true, $ne: null } } },
    {
      $group: {
        _id: '$userInfo.team',
        score: { $sum: '$challengeData.points' },
        lastSolve: { $max: '$submittedAt' }
      }
    }
  ]);

  const teamAwardMatch = { value: { $ne: 0 }, team: { $exists: true, $ne: null } };
  if (freezeTime) teamAwardMatch.date = { $lt: new Date(freezeTime) };
  const directAwards = await Award.aggregate([
    { $match: teamAwardMatch },
    { $group: { _id: '$team', score: { $sum: '$value' }, lastAward: { $max: '$date' } } }
  ]);

  const userAwardMatch = { value: { $ne: 0 }, user: { $exists: true, $ne: null } };
  if (freezeTime) userAwardMatch.date = { $lt: new Date(freezeTime) };
  const memberAwards = await Award.aggregate([
    { $match: userAwardMatch },
    {
      $lookup: {
        from: 'users',
        localField: 'user',
        foreignField: '_id',
        as: 'userInfo'
      }
    },
    { $unwind: '$userInfo' },
    { $match: { 'userInfo.team': { $exists: true, $ne: null } } },
    { $group: { _id: '$userInfo.team', score: { $sum: '$value' }, lastAward: { $max: '$date' } } }
  ]);

  const scoreByTeam = new Map();
  const merge = (teamId, score, date, isSolve = false) => {
    const key = teamId.toString();
    const row = scoreByTeam.get(key) || { score: 0, date: new Date(0) };
    row.score += Number(score) || 0;
    if (isSolve && date) {
      const nextDate = new Date(date);
      if (nextDate > row.date) row.date = nextDate;
    }
    scoreByTeam.set(key, row);
  };

  teamSolves.forEach(row => merge(row._id, row.score, row.lastSolve, true));
  directAwards.forEach(row => merge(row._id, row.score, row.lastAward));
  memberAwards.forEach(row => merge(row._id, row.score, row.lastAward));

  const teamQuery = { banned: { $ne: true } };
  if (!isAdmin) teamQuery.hidden = { $ne: true };
  const teams = await Team.find(teamQuery).select('_id name').lean();
  const results = teams.map(team => {
    const standing = scoreByTeam.get(team._id.toString()) || { score: 0, date: new Date(0) };
    return {
      account_id: team._id.toString(),
      name: team.name,
      score: standing.score,
      date: standing.date,
      account_url: `/teams/${team._id}`
    };
  });

  results.sort(compareTeamStandings);
  if (limit) return results.slice(0, limit);
  return results.map((row, index) => ({ ...row, pos: index + 1 }));
}

async function getTeamStanding(teamId) {
  const standings = await aggregateTeamStandings(true);
  return standings.find(row => row.account_id === teamId.toString()) || null;
}

module.exports = { aggregateTeamStandings, compareTeamStandings, getTeamStanding };
