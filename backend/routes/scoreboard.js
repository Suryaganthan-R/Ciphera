const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { protect } = require('../middleware/auth');
const { getRedisClient } = require('../utils/redis');
const User = require('../models/User');
const Team = require('../models/Team');
const Submission = require('../models/Submission');
const Award = require('../models/Award');
const Challenge = require('../models/Challenge');
const EventState = require('../models/EventState');
const { aggregateTeamStandings: getSharedTeamStandings } = require('../utils/teamStandings');
const { getTeamSolveQuery } = require('../utils/teamScore');

const redisClient = getRedisClient();

// Cache TTL in seconds (CTFd uses 60s for scoreboard)
const CACHE_TTL = 60;
const GRAPH_CACHE_TTL = 300; // 5 minutes for graph

/**
 * Helper: Get current freeze time if any
 * In a real implementation, this would come from a config/settings model
 */
const getFreezeTime = async () => {
  try {
    const eventState = await EventState.getEventState();
    return eventState.freezeAt || null;
  } catch (error) {
    console.warn('[Scoreboard] Failed to read freeze time:', error.message);
    return null;
  }
};

/**
 * @route   GET /api/v1/scoreboard
 * @desc    Get full scoreboard (summary)
 * @access  Public (or Private based on settings)
 */
router.get('/', async (req, res) => {
  try {
    const type = req.query.type === 'users' ? 'users' : 'teams';
    const isAdmin = req.user && req.user.role === 'admin';

    // Cache Key
    const cacheKey = `scoreboard:${type}:${isAdmin ? 'admin' : 'public'}`;

    // Try Cache
    const cached = await redisClient.get(cacheKey);
    if (cached && !isAdmin) { // Admins always get fresh data or short cache? keeping consistent
      return res.json(JSON.parse(cached));
    }

    const freezeTime = await getFreezeTime();

    // Aggregation Pipeline
    let standings = [];
    if (type === 'teams') {
      standings = await aggregateTeamStandings(isAdmin, freezeTime);
    } else {
      standings = await aggregateUserStandings(isAdmin, freezeTime);
    }

    const response = {
      success: true,
      data: standings
    };

    // Cache result
    await redisClient.setex(cacheKey, CACHE_TTL, JSON.stringify(response));

    res.json(response);
  } catch (error) {
    console.error('Scoreboard Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

/**
 * @route   GET /api/v1/scoreboard/top/:count
 * @desc    Get detailed scoreboard for top N teams/users (includes detailed solve history)
 */
router.get('/top/:count', async (req, res) => {
  try {
    const rawCount = parseInt(req.params.count, 10);
    const count = Math.max(1, Math.min(Number.isNaN(rawCount) ? 10 : rawCount, 50));
    const type = req.query.type === 'users' ? 'users' : 'teams';
    const isAdmin = req.user && req.user.role === 'admin';

    // Use a different cache key for detailed view if needed, or just partial?
    // CTFd returns a dict: { "1": { id, name, score, solves: [...] }, "2": ... }

    const cacheKey = `scoreboard:top:${count}:${type}:${isAdmin ? 'admin' : 'public'}`;
    const cached = await redisClient.get(cacheKey);
    if (cached && !isAdmin) {
      return res.json(JSON.parse(cached));
    }

    const freezeTime = await getFreezeTime();

    // 1. Get Top N Standings First
    let topStandings = [];
    if (type === 'teams') {
      topStandings = await aggregateTeamStandings(isAdmin, freezeTime, count);
    } else {
      topStandings = await aggregateUserStandings(isAdmin, freezeTime, count);
    }

    // 2. For each top entry, fetch detailed solve history
    // This is N+1 but N is small (10-50). aggregated lookup is complex.
    const responseData = {};

    for (let i = 0; i < topStandings.length; i++) {
      const entry = topStandings[i];
      const rank = i + 1;

      // Fetch Solves
      const history = await getSolveHistory(entry.account_id, type, freezeTime);

      responseData[rank] = {
        id: entry.account_id,
        account_url: entry.account_url,
        name: entry.name,
        score: entry.score,
        bracket_id: entry.bracket_id || null,
        bracket_name: entry.bracket_name || null,
        solves: history
      };
    }

    const response = {
      success: true,
      data: responseData
    };

    await redisClient.setex(cacheKey, CACHE_TTL, JSON.stringify(response));
    res.json(response);

  } catch (error) {
    console.error('Scoreboard Top Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

/**
 * @route   GET /api/v1/scoreboard/graph
 * @desc    Get score graph data
 */
router.get('/graph', async (req, res) => {
  try {
    const type = req.query.type === 'users' ? 'users' : 'teams';
    const isAdmin = req.user && req.user.role === 'admin';

    const cacheKey = `scoreboard:graph:${type}:${isAdmin ? 'admin' : 'public'}`;
    const cached = await redisClient.get(cacheKey);
    if (cached && !isAdmin) {
      return res.json(JSON.parse(cached));
    }

    const freezeTime = await getFreezeTime();

    // 1. Get Top 10 Standings (CTFd graph is built from scoreboard detail/top data)
    let topStandings = [];
    if (type === 'teams') {
      topStandings = await aggregateTeamStandings(isAdmin, freezeTime, 10);
    } else {
      topStandings = await aggregateUserStandings(isAdmin, freezeTime, 10);
    }

    // 2. Return CTFd-style detail payload so frontend can compute cumulative lines
    const graphData = {};

    for (let i = 0; i < topStandings.length; i++) {
      const entry = topStandings[i];
      const rank = i + 1;

      const history = await getSolveHistory(entry.account_id, type, freezeTime);

      graphData[rank] = {
        id: entry.account_id,
        name: entry.name,
        score: entry.score,
        solves: history
      };
    }

    const response = {
      success: true,
      data: graphData
    };

    await redisClient.setex(cacheKey, GRAPH_CACHE_TTL, JSON.stringify(response));
    res.json(response);

  } catch (error) {
    console.error('Scoreboard Graph Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

/**
 * Helper: Aggregate User Standings (CTFd-style with dynamic scoring)
 * Returns: [{ account_id, name, score, date, rank }, ...]
 */
async function aggregateUserStandings(isAdmin, freezeTime, limit = null) {
  const matchStage = {
    isCorrect: true
  };

  if (freezeTime) {
    matchStage.submittedAt = { $lt: new Date(freezeTime) };
  }

  // CTFd-style: JOIN Submissions with Challenges to get current values
  // This automatically handles dynamic scoring retroactively
  const submissionAgg = await Submission.aggregate([
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
        _id: "$user",
        score: { $sum: "$challengeData.points" }, // Sum current challenge values
        lastSolve: { $max: "$submittedAt" }
      }
    }
  ]);

  // 2. Build User Map (Challenge points only - no awards)
  // CTFd-style user ranking includes solves + user awards
  const userMap = new Map();

  // Process Submissions
  for (const sub of submissionAgg) {
    userMap.set(sub._id.toString(), {
      score: sub.score,
      lastDate: new Date(sub.lastSolve)
    });
  }

  // Merge user awards into user map
  const userAwardMatch = {
    value: { $ne: 0 },
    user: { $exists: true, $ne: null }
  };

  if (freezeTime) {
    userAwardMatch.date = { $lt: new Date(freezeTime) };
  }

  const userAwardsAgg = await Award.aggregate([
    { $match: userAwardMatch },
    {
      $group: {
        _id: '$user',
        score: { $sum: '$value' },
        lastAward: { $max: '$date' }
      }
    }
  ]);

  for (const award of userAwardsAgg) {
    const uid = award._id.toString();
    const existing = userMap.get(uid) || { score: 0, lastDate: new Date(0) };
    existing.score += award.score;
    if (award.lastAward && new Date(award.lastAward) > existing.lastDate) {
      existing.lastDate = new Date(award.lastAward);
    }
    userMap.set(uid, existing);
  }

  // Filter Users (Hidden/Banned/Admin)
  const userQuery = { role: 'user' }; // Standard users only usually
  if (!isAdmin) {
    userQuery.hidden = { $ne: true };
    userQuery.banned = { $ne: true };
  }

  const users = await User.find(userQuery).select('_id username hidden banned').lean();

  const results = [];
  for (const user of users) {
    const uid = user._id.toString();
    const data = userMap.get(uid);

    if (data && data.score > 0) {
      results.push({
        account_id: uid,
        name: user.username,
        score: data.score,
        date: data.lastDate,
        account_url: `/users/${uid}`
      });
    }
  }

  // 4. Sort
  results.sort((a, b) => {
    // Score DESC
    if (b.score !== a.score) return b.score - a.score;
    // Date ASC (Earlier is better)
    if (a.date.getTime() !== b.date.getTime()) return a.date - b.date;
    // ID ASC (Tie breaker)
    return a.account_id.localeCompare(b.account_id);
  });

  if (limit) {
    return results.slice(0, limit);
  }

  // Add Rank
  return results.map((r, i) => ({ ...r, pos: i + 1 }));
}

/**
 * Helper: Aggregate Team Standings (CTFd-style with dynamic scoring)
 */
async function aggregateTeamStandings(isAdmin, freezeTime, limit = null) {
  return getSharedTeamStandings(isAdmin, freezeTime, limit);
}

/**
 * Helper: Get detailed solve history for graph/top view (CTFd-style with current values)
 */
async function getSolveHistory(accountId, mode, freezeTime) {
  const history = [];
  const isTeam = mode === 'teams';

  if (isTeam) {
    // Only solves earned for this team, including those by members who have since left
    const solveQuery = await getTeamSolveQuery(accountId);
    if (freezeTime) solveQuery.submittedAt = { $lt: new Date(freezeTime) };

    const solves = await Submission.find(solveQuery)
      .populate('challenge', 'points')
      .select('submittedAt challenge user')
      .lean();

    for (const s of solves) {
      if (!s.challenge || s.challenge.points === 0) continue;
      history.push({
        date: s.submittedAt,
        challenge_id: s.challenge._id,
        account_id: accountId,
        user_id: s.user,
        team_id: accountId,
        value: s.challenge.points
      });
    }
  } else {
    const solveQuery = {
      user: accountId,
      isCorrect: true
    };
    if (freezeTime) solveQuery.submittedAt = { $lt: new Date(freezeTime) };

    const solves = await Submission.find(solveQuery)
      .populate('challenge', 'points')
      .select('submittedAt challenge user team')
      .lean();

    for (const s of solves) {
      if (!s.challenge || s.challenge.points === 0) continue;
      history.push({
        date: s.submittedAt,
        challenge_id: s.challenge._id,
        account_id: accountId,
        user_id: s.user,
        team_id: s.team || null,
        value: s.challenge.points
      });
    }
  }

  // Awards
  const awardQuery = { value: { $ne: 0 } };
  if (isTeam) {
    // Awards given to the team, or to a player while they were in it
    awardQuery.$or = [{ team: accountId }, { creditedTeam: accountId }];

    if (freezeTime) awardQuery.date = { $lt: new Date(freezeTime) };

    const awards = await Award.find(awardQuery).select('value date user').lean();
    for (const a of awards) {
      history.push({
        date: a.date,
        challenge_id: null,
        account_id: accountId,
        user_id: a.user || null,
        team_id: accountId,
        value: a.value
      });
    }
  } else {
    awardQuery.user = accountId;
    if (freezeTime) awardQuery.date = { $lt: new Date(freezeTime) };

    const awards = await Award.find(awardQuery).select('value date user creditedTeam').lean();

    for (const a of awards) {
      history.push({
        date: a.date,
        challenge_id: null,
        account_id: accountId,
        user_id: a.user || accountId,
        team_id: a.creditedTeam || null,
        value: a.value
      });
    }
  }

  // CTFd-style: sort by date ascending
  history.sort((a, b) => new Date(a.date) - new Date(b.date));

  return history;
}

module.exports = router;
