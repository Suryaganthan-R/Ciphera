const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Challenge = require('../models/Challenge');
const Category = require('../models/Category');
const User = require('../models/User');
const Submission = require('../models/Submission');
const { protect, authorize, optionalProtect } = require('../middleware/auth');
const Unlock = require('../models/Unlock');
const Team = require('../models/Team');
const Award = require('../models/Award');
const { getViewer, isAdmin, getFreezeTime, getVisibility, hasEventStarted, requireNotBanned } = require('../utils/access');
const { getVisibleSolves } = require('../utils/standings');
const { PUBLIC_CHALLENGE_QUERY, isPublicChallenge, isBannedUser, isBannedTeam, validateScoring } = require('../utils/scoringRules');
const { takeAttempt, tooMany } = require('../utils/attempts');
const { checkEventNotEnded, getEventState } = require('../middleware/eventState');
const { sanitizeInput, validateInput } = require('../middleware/security');


const requestIp = require('request-ip');
const UAParser = require('ua-parser-js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const { getRedisClient } = require('../utils/redis');
const { clearScoreboardCache } = require('../utils/redis');
const monitoring = require('../utils/monitoring');
const scoringService = require('../services/scoringService');
const { hasSolved, getSolvedChallengeIds, getUserRawScore, refreshUserPoints } = require('../utils/teamScore');
const { 
  upload, 
  handleMulterError, 
  calculateSHA1, 
  deleteFile,
  deleteAllChallengeFiles 
} = require('../utils/fileUpload');
// Use centralized Redis for Challenge Rate Limiting
const redisClient = getRedisClient();

// Real-time logging function
const logActivity = (action, details = {}) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] CHALLENGE: ${action}`, details);
};

const config = require('../config');

// Helper function to validate MongoDB ObjectId
const isValidObjectId = (id) => {
  return id && /^[0-9a-fA-F]{24}$/.test(id);
};

const NOT_STARTED_MESSAGE = 'Challenges unlock when the event starts';

// Locked hint text never leaves the server until the hint is unlocked or free.
const viewHints = (hints, unlocked) => (hints || []).map((hint, index) => {
  const open = unlocked.has(index) || hint.cost === 0;
  return open
    ? { id: index, content: hint.content, cost: hint.cost, unlocked: true }
    : { id: index, cost: hint.cost, unlocked: false };
});

// Hint indexes unlocked by the viewer or their team, grouped by challenge.
const unlockedHintsFor = async (viewer, challengeIds) => {
  const byChallenge = new Map();
  if (!viewer) return byChallenge;
  const unlocks = await Unlock.find({
    challenge: { $in: challengeIds },
    type: 'hints',
    ...(viewer.team ? { $or: [{ user: viewer._id }, { team: viewer.team }] } : { user: viewer._id })
  }).select('challenge target').lean();
  unlocks.forEach(unlock => {
    const id = String(unlock.challenge);
    if (!byChallenge.has(id)) byChallenge.set(id, new Set());
    byChallenge.get(id).add(unlock.target);
  });
  return byChallenge;
};

// Replaces solvedBy with the solvers this viewer may see.
const showSolvers = async (challenges, viewer) => {
  const admin = isAdmin(viewer);
  const solves = await getVisibleSolves(challenges.map(challenge => challenge._id), {
    viewer,
    cutoff: admin ? null : await getFreezeTime(),
    includeHidden: admin
  });
  const solvers = new Map();
  solves.forEach(solve => {
    if (!solvers.has(solve.challengeId)) solvers.set(solve.challengeId, []);
    solvers.get(solve.challengeId).push(solve.userId);
  });
  challenges.forEach(challenge => {
    challenge.solvedBy = solvers.get(String(challenge._id)) || [];
  });
};

// Checks that apply to players before they can use one challenge.
const playerAccessError = async (challenge, viewer) => {
  if (isAdmin(viewer)) return null;
  if (!isPublicChallenge(challenge)) return { status: 404, message: 'Challenge not found' };
  if (!await hasEventStarted()) return { status: 403, message: NOT_STARTED_MESSAGE };
  return null;
};

// @route   GET /api/challenges
// @desc    Get all challenges with pagination (players: visible ones, once the event starts)
// @access  Private (Authentication required - Security fix for Penligent HIGH vulnerability)
router.get('/', protect, requireNotBanned, sanitizeInput, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const viewer = await getViewer(req);
    const admin = isAdmin(viewer);

    if (!admin && !await hasEventStarted()) {
      return res.json({
        success: true,
        notStarted: true,
        message: NOT_STARTED_MESSAGE,
        count: 0,
        total: 0,
        page,
        pages: 0,
        data: [],
        stats: { solved: 0, remaining: 0, total: 0 }
      });
    }

    const query = admin ? {} : PUBLIC_CHALLENGE_QUERY;
    const userSolvedIds = await getSolvedChallengeIds(viewer._id, viewer.team);

    const total = await Challenge.countDocuments(query);
    const challenges = await Challenge.find(query)
      .select('-flag -createdAt -updatedAt')
      .limit(limit)
      .skip(skip)
      .sort({ _id: -1 })
      .lean(); // Use lean for better performance

    await showSolvers(challenges, viewer);
    const unlocked = admin ? null : await unlockedHintsFor(viewer, challenges.map(c => c._id));

    // Add current value and solved status to each challenge
    const enrichedChallenges = challenges.map(challenge => {
      challenge.currentValue = challenge.points;
      challenge.isSolved = userSolvedIds.some(id => id.toString() === challenge._id.toString());
      if (!admin) {
        challenge.hints = viewHints(challenge.hints, unlocked.get(String(challenge._id)) || new Set());
      }
      return challenge;
    });

    // Calculate stats
    const solvedCount = enrichedChallenges.filter(c => c.isSolved).length;
    const remainingCount = enrichedChallenges.length - solvedCount;

    const response = {
      success: true,
      count: enrichedChallenges.length,
      total,
      page,
      pages: Math.ceil(total / limit),
      data: enrichedChallenges,
      stats: {
        solved: solvedCount,
        remaining: remainingCount,
        total: enrichedChallenges.length
      }
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching challenges:', error);
    // Only return error message in development or generic in production
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ? error.message : 'Error fetching challenges'
    });
  }
});

// @route   GET /api/challenges/:id/solves
// @desc    Get users/teams who solved a challenge with timestamps
// @access  Private
router.get('/:id/solves', protect, requireNotBanned, async (req, res) => {
  try {
    // Validate ObjectId format
    if (!isValidObjectId(req.params.id)) {
      return res.status(404).json({
        success: false,
        message: 'Challenge not found'
      });
    }

    const challenge = await Challenge.findById(req.params.id).lean();

    if (!challenge) {
      return res.status(404).json({
        success: false,
        message: 'Challenge not found'
      });
    }

    const viewer = await getViewer(req);
    const denied = await playerAccessError(challenge, viewer);
    if (denied) {
      return res.status(denied.status).json({ success: false, message: denied.message });
    }

    const solves = await getVisibleSolves([challenge._id], {
      viewer,
      cutoff: isAdmin(viewer) ? null : await getFreezeTime()
    });

    res.json({
      success: true,
      data: solves.map(solve => ({
        username: solve.username,
        team: solve.team,
        solvedAt: solve.solvedAt
      }))
    });
  } catch (error) {
    console.error('Error fetching solves:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching challenge solves'
    });
  }
});

// NOTE: Hint unlocking has been moved to /api/unlocks endpoint (CTFd-style)
// The old POST /api/challenges/:id/unlock-hint endpoint has been removed to prevent
// incorrect individual user.points deduction. Hint costs should be deducted from
// team scores via negative awards, NOT from individual user scores.
// Use POST /api/unlocks instead for hint unlocking.

// @route   GET /api/challenges/:id
// @desc    Get single challenge (CTFd-style with hint views)
// @access  Set by the challenge visibility setting
router.get('/:id', optionalProtect, requireNotBanned, async (req, res) => {
  try {
    // Validate ObjectId format
    if (!isValidObjectId(req.params.id)) {
      return res.status(404).json({
        success: false,
        message: 'Challenge not found'
      });
    }

    const viewer = await getViewer(req);
    if (!viewer && (await getVisibility()).challenge !== 'public') {
      return res.status(401).json({ success: false, message: 'Log in to view challenges' });
    }

    const challenge = await Challenge.findById(req.params.id).select('-flag -createdAt -updatedAt').lean();

    if (!challenge) {
      return res.status(404).json({
        success: false,
        message: 'Challenge not found'
      });
    }

    const denied = await playerAccessError(challenge, viewer);
    if (denied) {
      return res.status(denied.status).json({ success: false, message: denied.message });
    }

    if (viewer) {
      challenge.isSolved = await hasSolved(challenge._id, viewer._id, viewer.team);
    }
    await showSolvers([challenge], viewer);

    const unlocked = (await unlockedHintsFor(viewer, [challenge._id])).get(String(challenge._id)) || new Set();
    challenge.hints = viewHints(challenge.hints, unlocked);

    res.json({
      success: true,
      data: challenge,
      unlockedHints: [...unlocked] // Still include this for backward compatibility
    });
  } catch (error) {
    console.error('Error fetching challenge:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching challenge'
    });
  }
});

// @route   POST /api/challenges
// @desc    Create a challenge
// @access  Private/Admin
router.post('/', protect, authorize('admin'), async (req, res) => {
  try {
    console.log('Creating challenge with data:', req.body);

    const payload = { ...req.body };
    payload.category = String(payload.category || '').trim().toLowerCase();
    if (!await Category.exists({ id: payload.category })) {
      return res.status(400).json({
        success: false,
        message: 'Please select a valid category'
      });
    }

    // CTFd-style validation for dynamic challenge parameters
    if (payload.function === 'linear' || payload.function === 'logarithmic') {
      for (const attr of ['initial', 'minimum', 'decay']) {
        if (payload[attr] === undefined || payload[attr] === null || payload[attr] === '') {
          return res.status(400).json({
            success: false,
            message: `Missing '${attr}' but function is ${payload.function}`
          });
        }
      }

      // CTFd behavior: dynamic challenge current value starts at initial
      payload.points = Number(payload.initial);
    }

    const scoringError = validateScoring(payload);
    if (scoringError) {
      return res.status(400).json({ success: false, message: scoringError });
    }

    const challenge = await Challenge.create(payload);

    // Ensure dynamic challenge value is recalculated through CTFd formula pipeline
    if (challenge.function === 'linear' || challenge.function === 'logarithmic') {
      await scoringService.updateChallengeValue(challenge._id);
    }

    // Invalidate public challenges cache
    try {
      await redisClient.del('challenges:list:public');
    } catch (err) {
      console.error('Cache invalidation error:', err);
    }

    res.status(201).json({
      success: true,
      data: challenge
    });
  } catch (error) {
    console.error('Challenge creation error:', error);
    
    // Handle duplicate key error (MongoDB E11000)
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `A challenge with this ${field} already exists. Please use a different ${field}.`
      });
    }
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: Object.values(error.errors).map(e => e.message).join(', ')
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Error creating challenge'
    });
  }
});

// @route   POST /api/challenges/:id/submit
// @desc    Submit a flag for a challenge
// @access  Private
router.post('/:id/submit', protect, sanitizeInput, checkEventNotEnded, async (req, res) => {
  try {
    const { flag } = req.body;

    // Validate and sanitize flag input
    let submittedFlag;
    try {
      submittedFlag = validateInput.flag(flag);
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    // Validate ObjectId format
    if (!isValidObjectId(req.params.id)) {
      return res.status(404).json({
        success: false,
        message: 'Challenge not found'
      });
    }

    // Get challenge with flag
    const challenge = await Challenge.findById(req.params.id).select('+flag');
    if (!challenge) {
      return res.status(404).json({
        success: false,
        message: 'Challenge not found'
      });
    }

    // Get user with team
    const user = await User.findById(req.user._id).populate('team');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (isBannedUser(user)) {
      return res.status(403).json({
        success: false,
        message: `Your account is blocked. Reason: ${user.blockedReason || 'No reason provided'}`
      });
    }

    // Everything that bars a player is checked before the flag, so it cannot be probed.
    if (user.role !== 'admin') {
      if (!isPublicChallenge(challenge)) {
        return res.status(404).json({ success: false, message: 'Challenge not found' });
      }
      if (!user.team) {
        return res.status(403).json({
          success: false,
          message: 'Join or create a team before submitting flags'
        });
      }
      if (isBannedTeam(user.team)) {
        return res.status(403).json({ success: false, message: 'Your team is banned' });
      }
    }

    if (!user.canSubmitFlags) {
      return res.status(403).json({
        success: false,
        message: 'You are not allowed to submit flags'
      });
    }

    if (!challenge.submissionsAllowed) {
      return res.status(403).json({
        success: false,
        message: 'Submissions for this challenge are currently blocked'
      });
    }

    // Check if already solved by the user OR their current team
    const alreadySolved = await hasSolved(challenge._id, user._id, user.team?._id);

    // Say nothing about the submitted flag once the challenge is solved
    if (alreadySolved) {
      return res.status(400).json({
        success: false,
        message: 'This challenge has already been solved by you or your team'
      });
    }

    // Get IP and User Agent for tracking
    const clientIp = requestIp.getClientIp(req);
    const userAgent = req.get('User-Agent') || 'Unknown';

    // Limit wrong flags per team. Counted before checking so parallel guesses cannot slip past.
    const attempt = user.role === 'admin' ? null : await takeAttempt('flag', user.team._id);
    if (attempt && !attempt.allowed) {
      return tooMany(res, attempt.retryAfter, `Too many wrong flags. Try again in ${attempt.retryAfter} seconds.`);
    }

    // Check flag using constant-time comparison to prevent timing attacks
    const expectedFlag = challenge.flag.trim();
    const submittedBuffer = Buffer.from(submittedFlag, 'utf8');
    const expectedBuffer = Buffer.from(expectedFlag, 'utf8');

    // Ensure buffers are same length to prevent timing attacks
    const maxLength = Math.max(submittedBuffer.length, expectedBuffer.length);
    const paddedSubmitted = Buffer.alloc(maxLength);
    const paddedExpected = Buffer.alloc(maxLength);

    submittedBuffer.copy(paddedSubmitted);
    expectedBuffer.copy(paddedExpected);

    const isCorrect = crypto.timingSafeEqual(paddedSubmitted, paddedExpected) &&
      submittedFlag.length === expectedFlag.length;

    if (!isCorrect) {
      await Submission.create({
        user: req.user._id,
        team: user.team?._id || null,
        challenge: challenge._id,
        submittedFlag,
        isCorrect: false,
        ipAddress: clientIp,
        userAgent
      });

      // Rate limiting is handled by middleware
      // Optionally publish failed attempts for admin monitoring
      try {
        const failedEvent = {
          type: 'failed_attempt',
          user: req.user.username || 'Unknown',
          email: req.user.email,
          challenge: challenge.title,
          challengeId: challenge._id.toString(),
          points: challenge.points,
          submittedAt: new Date().toISOString(),
          ip: clientIp,
          status: 'incorrect',
          submittedFlag: submittedFlag
        };

        console.log('[Real-time] Publishing failed attempt:', failedEvent.user, '->', failedEvent.challenge);

        redisClient.publish('ctf:submissions:live', JSON.stringify(failedEvent))
          .then(subs => console.log(`[Real-time] Failed attempt sent to ${subs} subscriber(s)`))
          .catch(err => console.error('[Non-critical] Redis publish error:', err.message));
      } catch (e) {
        console.error('[Non-critical] Error preparing failed attempt event:', e.message);
      }

      return res.status(400).json({
        success: false,
        message: 'Incorrect flag'
      });
    }

    // Only wrong flags count against the limit
    if (attempt) await attempt.release();

    if (user.role === 'admin') {
      return res.json({
        success: true,
        message: 'correct',
        adminSolve: true,
        points: 0,
        timestamp: new Date().toISOString()
      });
    }

    // Check event state again before processing scoring (double-check for race conditions)
    const eventStateNow = await getEventState();
    if (!eventStateNow.isSubmissionAllowed) {
      const message = eventStateNow.status === 'ended'
        ? 'CTF event has ended.'
        : eventStateNow.status === 'not_started'
          ? 'CTF event has not started yet.'
          : 'CTF is paused by admin. Submissions are temporarily disabled.';

      return res.status(403).json({
        success: false,
        message
      });
    }



    // Use transaction for atomic operations to prevent race conditions
    const session = await mongoose.startSession();
    let solveTeamId = null;
    try {
      await session.withTransaction(async () => {
        // Final check inside transaction to prevent any scoring writes if submissions are disabled
        const eventStateInTransaction = await getEventState();
        if (!eventStateInTransaction.isSubmissionAllowed) {
          const message = eventStateInTransaction.status === 'ended'
            ? 'CTF event has ended.'
            : eventStateInTransaction.status === 'not_started'
              ? 'CTF event has not started yet.'
              : 'CTF is paused by admin.';
          throw Object.assign(new Error(message), { status: 403 });
        }

        // Writing to the player and team first makes simultaneous solves, hint unlocks and
        // team changes conflict, so MongoDB runs them one at a time.
        const solver = await User.findByIdAndUpdate(
          req.user._id,
          { $inc: { scoreRevision: 1 } },
          { new: true, session }
        );
        if (!solver) throw Object.assign(new Error('User not found'), { status: 404 });
        const team = solver.team
          ? await Team.findByIdAndUpdate(solver.team, { $inc: { scoreRevision: 1 } }, { new: true, session })
          : null;
        if (isBannedUser(solver)) throw Object.assign(new Error('Your account is blocked'), { status: 403 });
        if (!team) {
          throw Object.assign(new Error('Join or create a team before submitting flags'), { status: 403 });
        }
        if (isBannedTeam(team)) throw Object.assign(new Error('Your team is banned'), { status: 403 });
        solveTeamId = team._id;

        // Check again now that no other solve for this player or team can slip in
        if (await hasSolved(challenge._id, solver._id, solveTeamId, session)) {
          throw Object.assign(new Error('This challenge has already been solved by you or your team'), { status: 400 });
        }

        await new Submission({
          user: solver._id,
          team: solveTeamId,
          challenge: challenge._id,
          submittedFlag,
          isCorrect: true,
          ipAddress: clientIp,
          userAgent
        }).save({ session });

        // Include this solve in the player's stored score
        const score = await getUserRawScore(solver._id, session);

        await User.updateOne(
          { _id: solver._id },
          {
            $addToSet: {
              solvedChallenges: challenge._id,
              personallySolvedChallenges: {
                challengeId: challenge._id,
                challengeTitle: challenge.title,
                solvedAt: new Date()
              }
            },
            $set: { lastSolveTime: new Date(), points: Math.max(0, score) }
          },
          { session }
        );

        // Update challenge solvedBy array
        await Challenge.updateOne(
          { _id: challenge._id },
          { $addToSet: { solvedBy: solver._id } },
          { session }
        );

        if (team) {
          await Team.updateOne(
            { _id: team._id },
            { $addToSet: { solvedChallenges: challenge._id } },
            { session }
          );
        }
      });
    } catch (transactionError) {
      if (transactionError.status) {
        return res.status(transactionError.status).json({
          success: false,
          message: transactionError.message
        });
      }
      // The unique indexes rejected a second solve of the same challenge
      if (transactionError.code === 11000) {
        return res.status(400).json({
          success: false,
          message: 'This challenge has already been solved by you or your team'
        });
      }
      throw transactionError; // Re-throw other transaction errors
    } finally {
      await session.endSession();
    }

    // The solve is committed. Recalculate the dynamic value and clear cached scores.
    try {
      await scoringService.updateChallengeValue(challenge._id);
    } catch (valueError) {
      console.error('[Scoring] Could not update challenge value:', valueError.message);
    }
    if (solveTeamId) {
      const { invalidateTeamPoints } = require('../utils/teamPointsCache');
      await invalidateTeamPoints(solveTeamId);
    }
    await clearScoreboardCache();

    // Get current challenge value for response
    const updatedChallenge = await Challenge.findById(challenge._id);
    const currentValue = updatedChallenge.points;

    logActivity('FLAG_SUBMITTED_SUCCESS', {
      userId: req.user._id,
      challengeId: challenge._id,
      challengeTitle: challenge.title,
      points: currentValue
    });

    // Publish real-time submission event to admin monitoring
    // CRITICAL: This must NEVER block player submissions
    try {
      const submissionEvent = {
        type: 'submission',
        user: req.user.username || 'Unknown',
        email: req.user.email,
        challenge: challenge.title,
        challengeId: challenge._id.toString(),
        points: currentValue,
        submittedAt: new Date().toISOString(),
        ip: clientIp,
        submittedFlag: submittedFlag
      };

      console.log('[Real-time] Publishing submission event:', submissionEvent.user, '->', submissionEvent.challenge);

      // Fire and forget - don't await, catch errors to prevent blocking
      redisClient.publish('ctf:submissions:live', JSON.stringify(submissionEvent))
        .then(subscribers => {
          console.log(`[Real-time] Event published to ${subscribers} subscriber(s)`);
        })
        .catch(err => {
          // Log error but don't affect player submission
          console.error('[Non-critical] Redis publish error:', err.message);
        });
    } catch (e) {
      // Catch any errors - monitoring failure must not affect players
      console.error('[Non-critical] Error preparing submission event:', e.message);
    }

    res.json({
      success: true,
      message: 'correct',
      points: currentValue,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Challenge submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @route   DELETE /api/challenges/:id
// @desc    Delete a challenge
// @access  Private/Admin
router.delete('/:id', protect, authorize('admin'), async (req, res) => {
  try {
    // Validate ObjectId format
    if (!isValidObjectId(req.params.id)) {
      return res.status(404).json({
        success: false,
        message: 'Challenge not found'
      });
    }

    const challenge = await Challenge.findById(req.params.id);

    if (!challenge) {
      return res.status(404).json({
        success: false,
        message: 'Challenge not found'
      });
    }

    // Refund hint costs paid on this challenge
    const hintCosts = {
      category: 'hints',
      $or: [
        { challenge: challenge._id },
        // Costs recorded before awards were linked to challenges
        { challenge: null, name: `Hint Unlock: ${challenge.title}`.slice(0, 80) }
      ]
    };
    const refunded = await Award.find(hintCosts).select('user').lean();
    const solverIds = await Submission.distinct('user', { challenge: challenge._id, isCorrect: true });

    await challenge.deleteOne();
    await Award.deleteMany(hintCosts);
    await Unlock.deleteMany({ challenge: challenge._id });

    // Its points and hint costs no longer count for anyone
    await refreshUserPoints([...solverIds, ...refunded.map(award => award.user)]);
    await clearScoreboardCache();

    // Invalidate public challenges cache
    try {
      await redisClient.del('challenges:list:public');
    } catch (err) {
      console.error('Cache invalidation error:', err);
    }

    res.json({
      success: true,
      message: 'Challenge deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting challenge:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting challenge'
    });
  }
});

// @route   PUT /api/challenges/:id
// @desc    Update a challenge
// @access  Private/Admin
router.put('/:id', protect, authorize('admin'), async (req, res) => {
  try {
    console.log('Update challenge request:', {
      id: req.params.id,
      body: req.body
    });

    // Validate ObjectId format
    if (!isValidObjectId(req.params.id)) {
      return res.status(404).json({
        success: false,
        message: 'Challenge not found'
      });
    }

    const challenge = await Challenge.findById(req.params.id);

    if (!challenge) {
      return res.status(404).json({
        success: false,
        message: 'Challenge not found'
      });
    }

    // If isVisible is being updated, log the change
    if (req.body.hasOwnProperty('isVisible')) {
      console.log('Updating visibility:', {
        challengeId: challenge._id,
        oldVisibility: challenge.isVisible,
        newVisibility: req.body.isVisible
      });
    }

    const updateData = { ...req.body };
    if (Object.prototype.hasOwnProperty.call(updateData, 'category')) {
      updateData.category = String(updateData.category || '').trim().toLowerCase();
      if (!await Category.exists({ id: updateData.category })) {
        return res.status(400).json({
          success: false,
          message: 'Please select a valid category'
        });
      }
    }

    const incomingFunction = updateData.function !== undefined ? updateData.function : challenge.function;
    const isDynamicFunction = incomingFunction === 'linear' || incomingFunction === 'logarithmic';

    // CTFd-style: moving to dynamic requires all dynamic parameters
    if (isDynamicFunction) {
      const nextInitial = updateData.initial !== undefined ? updateData.initial : challenge.initial;
      const nextMinimum = updateData.minimum !== undefined ? updateData.minimum : challenge.minimum;
      const nextDecay = updateData.decay !== undefined ? updateData.decay : challenge.decay;

      if (nextInitial === undefined || nextInitial === null || nextInitial === '') {
        return res.status(400).json({ success: false, message: `Missing 'initial' but function is ${incomingFunction}` });
      }
      if (nextMinimum === undefined || nextMinimum === null || nextMinimum === '') {
        return res.status(400).json({ success: false, message: `Missing 'minimum' but function is ${incomingFunction}` });
      }
      if (nextDecay === undefined || nextDecay === null || nextDecay === '') {
        return res.status(400).json({ success: false, message: `Missing 'decay' but function is ${incomingFunction}` });
      }

      // CTFd-style: manual value/points override should be ignored for dynamic updates
      delete updateData.points;
    }

    // Check the settings as they will be after this update
    const scoringFields = ['points', 'function', 'initial', 'minimum', 'decay', 'hints'];
    if (scoringFields.some(field => updateData[field] !== undefined)) {
      const scoringError = validateScoring({ ...challenge.toObject(), ...updateData });
      if (scoringError) {
        return res.status(400).json({ success: false, message: scoringError });
      }
    }

    const updatedChallenge = await Challenge.findByIdAndUpdate(
      req.params.id,
      updateData,
      {
        new: true,
        runValidators: true
      }
    );

    // Recalculate dynamic value from formula after update (CTFd behavior)
    if (updatedChallenge.function === 'linear' || updatedChallenge.function === 'logarithmic') {
      updatedChallenge.points = await scoringService.updateChallengeValue(updatedChallenge._id);
    } else if (updatedChallenge.points !== challenge.points) {
      await refreshUserPoints(updatedChallenge.solvedBy);
    }
    await clearScoreboardCache();

    console.log('Challenge updated successfully:', {
      challengeId: updatedChallenge._id,
      isVisible: updatedChallenge.isVisible
    });

    // Invalidate public challenges cache
    try {
      await redisClient.del('challenges:list:public');
    } catch (err) {
      console.error('Cache invalidation error:', err);
    }

    res.json({
      success: true,
      data: updatedChallenge
    });
  } catch (error) {
    console.error('Error updating challenge:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating challenge'
    });
  }
});

// ==================== FILE UPLOAD ROUTES ====================

// Upload files to a challenge (Admin only)
router.post(
  '/:challengeId/files',
  protect,
  authorize('admin'),
  upload.array('files', 10), // Max 10 files
  handleMulterError,
  async (req, res) => {
    try {
      const { challengeId } = req.params;

      if (!isValidObjectId(challengeId)) {
        // Clean up uploaded files for invalid challenge ID
        if (req.files) {
          for (const file of req.files) {
            await deleteFile(file.path).catch(console.error);
          }
        }
        return res.status(400).json({
          success: false,
          message: 'Invalid challenge ID'
        });
      }

      const challenge = await Challenge.findById(challengeId);

      if (!challenge) {
        // Clean up uploaded files if challenge not found
        if (req.files) {
          for (const file of req.files) {
            await deleteFile(file.path).catch(console.error);
          }
        }
        return res.status(404).json({
          success: false,
          message: 'Challenge not found'
        });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No files uploaded'
        });
      }

      // Process uploaded files
      const fileMetadata = [];
      
      for (const file of req.files) {
        try {
          // Calculate SHA-1 hash
          const sha1sum = await calculateSHA1(file.path);

          fileMetadata.push({
            filename: file.filename,
            originalName: file.originalname,
            path: `/uploads/challenges/${challengeId}/${file.filename}`,
            size: file.size,
            mimetype: file.mimetype,
            sha1sum: sha1sum,
            uploadedAt: new Date()
          });

          logActivity('FILE_UPLOADED', {
            challengeId,
            filename: file.originalname,
            size: file.size,
            admin: req.user.username
          });
        } catch (error) {
          console.error('Error processing file:', error);
          // Clean up file if processing failed
          await deleteFile(file.path).catch(console.error);
        }
      }

      // Add files to challenge
      challenge.files = challenge.files || [];
      challenge.files.push(...fileMetadata);
      await challenge.save();

      res.status(200).json({
        success: true,
        message: `${fileMetadata.length} file(s) uploaded successfully`,
        data: {
          files: fileMetadata
        }
      });
    } catch (error) {
      console.error('Error uploading files:', error);
      
      // Clean up uploaded files on error
      if (req.files) {
        for (const file of req.files) {
          await deleteFile(file.path).catch(console.error);
        }
      }
      
      res.status(500).json({
        success: false,
        message: 'Error uploading files'
      });
    }
  }
);

// Get files for a challenge (Admin only)
router.get(
  '/:challengeId/files',
  protect,
  authorize('admin'),
  async (req, res) => {
    try {
      const { challengeId } = req.params;

      if (!isValidObjectId(challengeId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid challenge ID'
        });
      }

      const challenge = await Challenge.findById(challengeId);

      if (!challenge) {
        return res.status(404).json({
          success: false,
          message: 'Challenge not found'
        });
      }

      res.status(200).json({
        success: true,
        data: {
          files: challenge.files || []
        }
      });
    } catch (error) {
      console.error('Error fetching files:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching files'
      });
    }
  }
);

// Delete a specific file from a challenge (Admin only)
router.delete(
  '/:challengeId/files/:filename',
  protect,
  authorize('admin'),
  async (req, res) => {
    try {
      const { challengeId } = req.params;
      const filename = decodeURIComponent(req.params.filename || '');

      if (!isValidObjectId(challengeId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid challenge ID'
        });
      }

      const challenge = await Challenge.findById(challengeId);

      if (!challenge) {
        return res.status(404).json({
          success: false,
          message: 'Challenge not found'
        });
      }

      // Find file in challenge
      const fileIndex = challenge.files.findIndex(f => f.filename === filename);

      if (fileIndex === -1) {
        return res.status(404).json({
          success: false,
          message: 'File not found'
        });
      }

      const file = challenge.files[fileIndex];
      const normalizedPath = (file.path || '').replace(/^\/+/, '');
      const filePath = path.join(__dirname, '..', normalizedPath);

      // Delete physical file
      await deleteFile(filePath);

      // Remove from database
      challenge.files.splice(fileIndex, 1);
      await challenge.save();

      logActivity('FILE_DELETED', {
        challengeId,
        filename: file.originalName,
        admin: req.user.username
      });

      res.status(200).json({
        success: true,
        message: 'File deleted successfully'
      });
    } catch (error) {
      console.error('Error deleting file:', error);
      res.status(500).json({
        success: false,
        message: 'Error deleting file'
      });
    }
  }
);

// Download challenge file (Authenticated users only)
router.get(
  '/:challengeId/download/:filename',
  protect,
  requireNotBanned,
  async (req, res) => {
    try {
      const { challengeId } = req.params;
      const filename = decodeURIComponent(req.params.filename || '');

      if (!isValidObjectId(challengeId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid challenge ID'
        });
      }

      const challenge = await Challenge.findById(challengeId);

      if (!challenge) {
        return res.status(404).json({
          success: false,
          message: 'Challenge not found'
        });
      }

      // Players: visible challenges only, once the event has started
      const denied = await playerAccessError(challenge, await getViewer(req));
      if (denied) {
        return res.status(denied.status).json({ success: false, message: denied.message });
      }

      // Find file
      const file = challenge.files.find(f => f.filename === filename);

      if (!file) {
        return res.status(404).json({
          success: false,
          message: 'File not found'
        });
      }

      const normalizedPath = (file.path || '').replace(/^\/+/, '');
      const filePath = path.join(__dirname, '..', normalizedPath);

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({
          success: false,
          message: 'File not found on server'
        });
      }

      // Log download
      logActivity('FILE_DOWNLOADED', {
        challengeId,
        filename: file.originalName,
        user: req.user.username,
        ip: requestIp.getClientIp(req)
      });

      // Set headers to force download and prevent execution
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${file.originalName}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Length', file.size);

      // Stream file to response
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);

      fileStream.on('error', (error) => {
        console.error('Error streaming file:', error);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: 'Error downloading file'
          });
        }
      });
    } catch (error) {
      console.error('Error downloading file:', error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: 'Error downloading file'
        });
      }
    }
  }
);

module.exports = router;
