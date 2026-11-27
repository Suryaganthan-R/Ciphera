/**
 * Limits repeated failures (wrong flags, wrong passwords).
 *
 * Every try is counted before it is checked, so simultaneous requests cannot slip past.
 * Call release() after a success: only failures use up the allowance.
 */
const RateLimit = require('../models/RateLimit');

const setting = (name, fallback) => Number.parseInt(process.env[name], 10) || fallback;

const LIMITS = {
  // Per team (CTFd default is 10 wrong flags a minute)
  flag: { limit: setting('WRONG_FLAGS_PER_MINUTE', 10), seconds: 60 },
  // Per email and address
  login: { limit: setting('LOGIN_FAILURES_PER_5_MINUTES', 10), seconds: 300 },
  // Per email from any address
  loginAccount: { limit: setting('LOGIN_ACCOUNT_FAILURES_PER_5_MINUTES', 100), seconds: 300 },
  // Successful username changes per player
  username: { limit: setting('USERNAME_CHANGES_PER_HOUR', 5), seconds: 3600 },
  teamPassword: { limit: setting('TEAM_PASSWORD_FAILURES_PER_5_MINUTES', 10), seconds: 300 }
};

async function increment(id, expiresAt) {
  const update = () => RateLimit.findOneAndUpdate(
    { _id: id },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
    { upsert: true, new: true }
  );
  try {
    return await update();
  } catch (error) {
    if (error.code !== 11000) throw error; // two requests created the counter together
    return update();
  }
}

async function takeAttempt(type, subject) {
  const { limit, seconds } = LIMITS[type];
  const window = Math.floor(Date.now() / (seconds * 1000));
  const end = (window + 1) * seconds * 1000;
  const id = `${type}:${subject}:${window}`;
  const record = await increment(id, new Date(end + 60000));

  return {
    allowed: record.count <= limit,
    retryAfter: Math.max(1, Math.ceil((end - Date.now()) / 1000)),
    release: () => RateLimit.updateOne({ _id: id }, { $inc: { count: -1 } })
  };
}

const tooMany = (res, retryAfter, message) => {
  res.set('Retry-After', String(retryAfter));
  return res.status(429).json({ success: false, message, error: message, retryAfter });
};

module.exports = { takeAttempt, tooMany, LIMITS };
