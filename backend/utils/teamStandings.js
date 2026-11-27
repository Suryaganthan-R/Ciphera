const Team = require('../models/Team');
const Submission = require('../models/Submission');
const Award = require('../models/Award');
const { getNonPlayerIds } = require('./teamScore');

const compareTeamStandings = (a, b) => {
  if (b.score !== a.score) return b.score - a.score;
  const aDate = new Date(a.date || 0).getTime();
  const bDate = new Date(b.date || 0).getTime();
  if (aDate !== bDate) return aDate - bDate;
  return String(a.account_id).localeCompare(String(b.account_id));
};

async function aggregateTeamStandings(isAdmin = false, freezeTime = null, limit = null) {
  // Solves count for the team recorded on them, not the solver's current team.
  const matchStage = {
    isCorrect: true,
    team: { $type: 'objectId' },
    user: { $nin: await getNonPlayerIds() }
  };
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
      $group: {
        _id: '$team',
        score: { $sum: '$challengeData.points' },
        lastSolve: { $max: '$submittedAt' }
      }
    }
  ]);

  const awardMatch = {
    value: { $ne: 0 },
    $or: [{ team: { $type: 'objectId' } }, { creditedTeam: { $type: 'objectId' } }]
  };
  if (freezeTime) awardMatch.date = { $lt: new Date(freezeTime) };
  const teamAwards = await Award.aggregate([
    { $match: awardMatch },
    {
      $group: {
        _id: { $ifNull: ['$team', '$creditedTeam'] },
        score: { $sum: '$value' },
        lastAward: { $max: '$date' }
      }
    }
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
  teamAwards.forEach(row => merge(row._id, row.score, row.lastAward));

  const teamQuery = { banned: { $ne: true } };
  if (!isAdmin) teamQuery.hidden = { $ne: true };
  const teams = await Team.find(teamQuery).select('_id name').lean();
  const results = teams.map(team => {
    const standing = scoreByTeam.get(team._id.toString()) || { score: 0, date: new Date(0) };
    return {
      account_id: team._id.toString(),
      name: team.name,
      score: Math.max(0, standing.score),
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
