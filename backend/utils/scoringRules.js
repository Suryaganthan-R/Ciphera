/**
 * Scoring rules with no database access, shared by every part that ranks or counts solves.
 */

// A banned or blocked account loses its effect on scores until it is restored.
const isBannedUser = user => Boolean(user && (user.banned || user.isBlocked));

// Solves and awards of these accounts score nothing: admins and banned players.
// A deleted account (no record) keeps the points it earned for its team.
const isVoidUser = user => Boolean(user && (user.role !== 'user' || isBannedUser(user)));

// Players shown on rankings and solve lists.
const isListedUser = user => Boolean(
  user && !isVoidUser(user) && !user.hidden && user.showInScoreboard !== false
);

const isBannedTeam = team => Boolean(team && (team.banned || team.isBlocked));

// Teams shown on rankings and solve lists.
const isListedTeam = team => Boolean(team && !isBannedTeam(team) && !team.hidden);

// Whether a team solve lowers a dynamic challenge's value.
const countsForValue = (user, team) => isListedTeam(team) && (!user || isListedUser(user));

// Mongo filter and document check for challenges players may see.
const PUBLIC_CHALLENGE_QUERY = { isVisible: { $ne: false }, state: { $nin: ['hidden', 'locked'] } };
const isPublicChallenge = challenge => Boolean(
  challenge && challenge.isVisible !== false && !['hidden', 'locked'].includes(challenge.state)
);

/**
 * Current value of a challenge for a number of solves (CTFd formulas).
 */
function calculateChallengeValue(challenge, solveCount = null) {
  // Static challenges always return base points
  if (challenge.function === 'static' || !challenge.function) {
    return challenge.points;
  }

  const initial = challenge.initial ?? challenge.points;
  const minimum = challenge.minimum ?? challenge.points; // 0 is a valid minimum
  let decay = challenge.decay || 0;

  if (solveCount === null) {
    solveCount = challenge.solvedBy?.length || 0;
  }

  // CTFd: the first solver gets the starting value
  const adjustedSolveCount = solveCount > 0 ? solveCount - 1 : 0;

  let value;
  if (challenge.function === 'linear') {
    value = initial - (decay * adjustedSolveCount);
  } else if (challenge.function === 'logarithmic') {
    if (decay === 0) decay = 1; // Prevent division by zero
    value = (((minimum - initial) / Math.pow(decay, 2)) * Math.pow(adjustedSolveCount, 2)) + initial;
  } else {
    value = challenge.points;
  }

  return Math.ceil(Math.max(minimum, value));
}

const isWholeNumber = value => value !== '' && value !== null && Number.isInteger(Number(value));

// Returns an error message for unusable point settings, or null.
function validateScoring(challenge) {
  const dynamic = challenge.function === 'linear' || challenge.function === 'logarithmic';
  if (challenge.function && !dynamic && challenge.function !== 'static') {
    return 'Scoring function must be static, linear or logarithmic';
  }
  if (dynamic) {
    if (!isWholeNumber(challenge.initial) || Number(challenge.initial) < 1) {
      return 'Initial points must be a whole number above 0';
    }
    if (!isWholeNumber(challenge.minimum) || Number(challenge.minimum) < 0) {
      return 'Minimum points must be a whole number, 0 or more';
    }
    if (Number(challenge.minimum) > Number(challenge.initial)) {
      return 'Minimum points cannot be higher than initial points';
    }
    if (!isWholeNumber(challenge.decay) || Number(challenge.decay) < 1) {
      return 'Decay must be a whole number above 0';
    }
  } else if (!isWholeNumber(challenge.points) || Number(challenge.points) < 0) {
    return 'Points must be a whole number, 0 or more';
  }
  const badHint = (challenge.hints || []).some(hint => {
    const cost = hint?.cost === '' ? 0 : hint?.cost ?? 0; // an empty field means free
    return !isWholeNumber(cost) || Number(cost) < 0;
  });
  return badHint ? 'Hint costs must be whole numbers, 0 or more' : null;
}

// Higher score first; on a tie, whoever reached that score first.
const compareStandings = (a, b) => (
  b.score - a.score
  || new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()
  || String(a.account_id).localeCompare(String(b.account_id))
);

module.exports = {
  isBannedUser,
  isVoidUser,
  isListedUser,
  isBannedTeam,
  isListedTeam,
  countsForValue,
  PUBLIC_CHALLENGE_QUERY,
  isPublicChallenge,
  calculateChallengeValue,
  validateScoring,
  compareStandings
};
