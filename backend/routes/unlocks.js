const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Award = require('../models/Award');
const { getTeamRawScore, getUserRawScore, hasSolved } = require('../utils/teamScore');
const { invalidateTeamPoints } = require('../utils/teamPointsCache');
const { clearScoreboardCache } = require('../utils/redis');
const Unlock = require('../models/Unlock');
const User = require('../models/User');
const Team = require('../models/Team');
const Challenge = require('../models/Challenge');
const { protect } = require('../middleware/auth');
const { checkEventNotEnded } = require('../middleware/eventState');

/**
 * CTFd-style Unlocks API
 * POST /api/unlocks - Create an unlock (unlock a hint)
 * GET /api/unlocks - Get user's unlocks (admin only)
 */

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(String(id || ''));

// @route   GET /api/unlocks/balance
// @desc    Points available for hints, and whether a challenge is already solved
// @access  Private
router.get('/balance', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('team');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const team = user.team ? await Team.findById(user.team).select('_id') : null;
    const score = team ? await getTeamRawScore(team._id) : await getUserRawScore(user._id);
    const solved = isObjectId(req.query.challenge)
      ? await hasSolved(req.query.challenge, user._id, team?._id)
      : false;

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      data: { scope: team ? 'team' : 'individual', available: Math.max(0, score), solved }
    });
  } catch (error) {
    console.error('[Unlock] Balance error:', error);
    res.status(500).json({ success: false, message: 'Error fetching available points' });
  }
});

// @route   POST /api/unlocks
// @desc    Unlock a hint by spending points (CTFd-style)
// @access  Private
router.post('/', protect, checkEventNotEnded, async (req, res) => {
  const { type, challenge: challengeId } = req.body;
  const target = Number(req.body.target);
  const reject = (status, field, message) =>
    res.status(status).json({ success: false, message, errors: { [field]: message } });

  if (type !== 'hints') {
    return reject(400, 'type', 'Only hints are supported for unlocking');
  }
  if ([undefined, null, ''].includes(req.body.target) || !Number.isInteger(target) || target < 0) {
    return reject(400, 'target', 'Invalid target (hint index)');
  }
  if (!isObjectId(challengeId)) {
    return reject(400, 'challenge', 'A valid challenge ID is required');
  }

  let session;
  try {
    const challenge = await Challenge.findById(challengeId);
    if (!challenge) {
      return reject(404, 'challenge', 'Challenge not found');
    }
    const hint = challenge.hints?.[target];
    if (!hint) {
      return reject(404, 'target', 'Hint not found');
    }
    const cost = Math.max(0, Number(hint.cost) || 0);

    let unlock;
    let teamId = null;
    session = await mongoose.startSession();

    await session.withTransaction(async () => {
      // These writes make simultaneous unlocks and solves conflict, so MongoDB retries
      // one of them against the updated balance and solve list.
      const user = await User.findByIdAndUpdate(
        req.user._id,
        { $inc: { scoreRevision: 1 } },
        { new: true, session }
      );
      if (!user) throw httpError(404, 'User not found');
      const team = user.team
        ? await Team.findByIdAndUpdate(user.team, { $inc: { scoreRevision: 1 } }, { new: true, session })
        : null;
      teamId = team?._id || null;

      if (await hasSolved(challenge._id, user._id, team?._id, session)) {
        throw httpError(400, 'This challenge is already solved, so its hints can no longer be unlocked.');
      }

      const existingUnlock = await Unlock.findOne({
        challenge: challenge._id,
        target,
        type: 'hints',
        ...(team ? { $or: [{ user: user._id }, { team: team._id }] } : { user: user._id })
      }).session(session);
      if (existingUnlock) throw httpError(400, "You've already unlocked this target");

      let score = 0;
      if (cost > 0) {
        score = team ? await getTeamRawScore(team._id, session) : await getUserRawScore(user._id, session);
        if (score < cost) {
          throw httpError(400, `Not enough points to unlock this hint. It costs ${cost} points and you have ${Math.max(0, score)}.`);
        }
      }

      [unlock] = await Unlock.create([{
        user: user._id,
        team: teamId,
        challenge: challenge._id,
        target,
        type: 'hints'
      }], { session });

      if (cost > 0) {
        await Award.create([{
          team: teamId,
          user: team ? null : user._id,
          name: `Hint Unlock: ${challenge.title}`.slice(0, 80),
          description: `Hint #${target + 1} unlocked by ${user.username}`,
          value: -cost,
          category: 'hints',
          icon: 'hint'
        }], { session });

        if (!team) {
          await User.updateOne({ _id: user._id }, { $set: { points: score - cost } }, { session });
        }
      }
    });

    if (teamId) await invalidateTeamPoints(teamId);
    await clearScoreboardCache();

    res.json({
      success: true,
      data: {
        id: unlock._id,
        user_id: unlock.user,
        team_id: unlock.team,
        target: unlock.target,
        type: unlock.type,
        date: unlock.date
      }
    });
  } catch (error) {
    if (error.code === 11000) {
      return reject(400, 'target', "You've already unlocked this target");
    }
    if (error.status) {
      return reject(error.status, 'target', error.message);
    }
    console.error('[Unlock] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (session) await session.endSession();
  }
});

// @route   GET /api/unlocks
// @desc    Get all unlocks for current user
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const user = await User.findById(userId).populate('team');

    const query = { type: 'hints' };

    if (user.team) {
      query.$or = [
        { user: userId },
        { team: user.team._id }
      ];
    } else {
      query.user = userId;
    }

    const unlocks = await Unlock.find(query)
      .populate('challenge', 'title category')
      .sort({ date: -1 });

    res.json({
      success: true,
      data: unlocks.map(unlock => ({
        id: unlock._id,
        target: unlock.target,
        type: unlock.type,
        date: unlock.date,
        challenge: unlock.challenge
      }))
    });
  } catch (error) {
    console.error('[Unlock] Get error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

module.exports = router;
