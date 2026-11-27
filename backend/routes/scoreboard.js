const express = require('express');
const router = express.Router();
const { optionalProtect } = require('../middleware/auth');
const { getRedisClient } = require('../utils/redis');
const { loadScoreboard } = require('../utils/standings');
const { getViewer, isAdmin, getFreezeTime, getVisibility, allows } = require('../utils/access');

const redisClient = getRedisClient();

// Cache TTL in seconds (CTFd uses 60s for scoreboard)
const CACHE_TTL = 60;

const accountType = req => (req.query.type === 'users' ? 'users' : 'teams');

/**
 * Applies score visibility and the freeze, and caches the public view.
 * Admins always get live data.
 */
const scoreboardRoute = (cacheName, build) => async (req, res) => {
  try {
    const viewer = await getViewer(req);
    const visibility = await getVisibility();
    if (!allows(visibility.score, viewer)) {
      return res.status(403).json({
        success: false,
        scoresHidden: true,
        message: 'Scores are hidden by the organisers'
      });
    }

    const admin = isAdmin(viewer);
    const cacheKey = `scoreboard:${cacheName(req)}`;
    if (!admin) {
      const cached = await redisClient.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    }

    const freezeTime = admin ? null : await getFreezeTime();
    const board = await loadScoreboard({ cutoff: freezeTime });
    const response = { success: true, frozen: Boolean(freezeTime), data: build(req, board) };

    if (!admin) await redisClient.setex(cacheKey, CACHE_TTL, JSON.stringify(response));
    res.json(response);
  } catch (error) {
    console.error('Scoreboard Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const standingsFor = (type, board) => (type === 'users' ? board.userStandings() : board.teamStandings());

// Top accounts with every score change, keyed by place (used for the graph)
const topWithHistory = (type, count, board) => {
  const data = {};
  standingsFor(type, board).slice(0, count).forEach((row, index) => {
    const entries = type === 'users'
      ? board.listedUserEntries(row.account_id)
      : board.teamEntries(row.account_id);
    data[index + 1] = {
      id: row.account_id,
      account_url: row.account_url,
      name: row.name,
      score: row.score,
      bracket_id: null,
      bracket_name: null,
      solves: entries
        .filter(entry => entry.value !== 0)
        .sort((a, b) => a.date - b.date)
        .map(entry => ({
          date: entry.date,
          challenge_id: entry.challengeId,
          account_id: row.account_id,
          user_id: entry.userId || null,
          team_id: entry.teamId || null,
          value: entry.value
        }))
    };
  });
  return data;
};

const topCount = req => {
  const raw = parseInt(req.params.count, 10);
  return Math.max(1, Math.min(Number.isNaN(raw) ? 10 : raw, 50));
};

/**
 * @route   GET /api/v1/scoreboard
 * @desc    Get full scoreboard (summary)
 * @access  Set by the score visibility setting
 */
router.get('/', optionalProtect, scoreboardRoute(
  req => accountType(req),
  (req, board) => standingsFor(accountType(req), board)
));

/**
 * @route   GET /api/v1/scoreboard/top/:count
 * @desc    Get detailed scoreboard for top N teams/users (includes score history)
 */
router.get('/top/:count', optionalProtect, scoreboardRoute(
  req => `top:${topCount(req)}:${accountType(req)}`,
  (req, board) => topWithHistory(accountType(req), topCount(req), board)
));

/**
 * @route   GET /api/v1/scoreboard/graph
 * @desc    Get score graph data
 */
router.get('/graph', optionalProtect, scoreboardRoute(
  req => `graph:${accountType(req)}`,
  (req, board) => topWithHistory(accountType(req), 10, board)
));

module.exports = router;
