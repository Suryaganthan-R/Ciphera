/**
 * Rules for the names players choose.
 */
const User = require('../models/User');

const MIN_LENGTH = 3;
const MAX_LENGTH = 30;
const RULES = `Use ${MIN_LENGTH} to ${MAX_LENGTH} letters, numbers, underscores or hyphens, with no spaces`;

// Returns { username } when usable, otherwise { error }.
function checkUsername(value) {
  const username = typeof value === 'string' ? value.trim() : '';
  const usable = username.length >= MIN_LENGTH
    && username.length <= MAX_LENGTH
    && /^[a-zA-Z0-9_-]+$/.test(username);
  return usable ? { username } : { error: RULES };
}

// Ignores capital letters, so one player cannot pose as another. The rules above leave
// no characters with a special meaning in the pattern.
async function isUsernameTaken(username, exceptUserId = null) {
  return Boolean(await User.exists({
    username: { $regex: `^${username}$`, $options: 'i' },
    ...(exceptUserId ? { _id: { $ne: exceptUserId } } : {})
  }));
}

module.exports = { checkUsername, isUsernameTaken, USERNAME_TAKEN: 'That username is already taken' };
