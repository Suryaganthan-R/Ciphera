/**
 * Who is asking, and what they may see: freeze time, visibility settings, event start.
 */
const User = require('../models/User');
const EventState = require('../models/EventState');
const Configuration = require('../models/Configuration');
const { getEventState } = require('../middleware/eventState');
const { isBannedUser } = require('./scoringRules');

// Read from the database: the copy on req.user can be cached for several minutes.
const getViewer = async req => (req.user
  ? User.findById(req.user._id).select('role team banned isBlocked hidden').lean()
  : null);

const isAdmin = viewer => viewer?.role === 'admin';

// The freeze time once it has passed, otherwise null.
async function getFreezeTime() {
  const { freezeAt } = await EventState.getEventState();
  return freezeAt && freezeAt <= new Date() ? freezeAt : null;
}

async function getVisibility() {
  const config = await Configuration.findOne({ key: 'global' }).select('visibility').lean();
  return {
    challenge: config?.visibility?.challenge || 'private',
    account: config?.visibility?.account || 'private',
    score: config?.visibility?.score || 'private'
  };
}

// 'public': anyone. 'private': logged-in users. 'admins': admins only.
const allows = (setting, viewer) => (
  setting === 'public' || isAdmin(viewer) || (setting === 'private' && Boolean(viewer))
);

const hasEventStarted = async () => (await getEventState()).status !== 'not_started';

// Route guard: banned players cannot play or spend team points.
async function requireNotBanned(req, res, next) {
  try {
    const viewer = await getViewer(req);
    if (viewer && !isAdmin(viewer) && isBannedUser(viewer)) {
      return res.status(403).json({ success: false, isBlocked: true, message: 'Your account is blocked.' });
    }
    next();
  } catch (error) {
    console.error('[Access] Could not check the account:', error);
    res.status(500).json({ success: false, message: 'Could not check your account' });
  }
}

module.exports = { getViewer, isAdmin, getFreezeTime, getVisibility, allows, hasEventStarted, requireNotBanned };
