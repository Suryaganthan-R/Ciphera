/**
 * The single source of rankings. Scoreboards, graphs, team pages, profiles and solve lists
 * all read from here, so they always agree.
 *
 * `cutoff` is the scoreboard freeze time: only solves and awards before it are included,
 * and dynamic challenges are valued as they were then.
 */
const Challenge = require('../models/Challenge');
const User = require('../models/User');
const Team = require('../models/Team');
const Submission = require('../models/Submission');
const Award = require('../models/Award');
const rules = require('./scoringRules');

const key = value => (value ? String(value._id || value) : '');
const byId = list => new Map(list.map(item => [key(item._id), item]));

const group = (entries, field) => {
  const groups = new Map();
  entries.forEach(entry => {
    const id = entry[field];
    if (!id) return;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(entry);
  });
  return groups;
};

// Total, and when it last changed (used to break ties).
const summarize = entries => entries.reduce((total, entry) => {
  total.score += entry.value;
  if (entry.value !== 0 && entry.date > total.date) total.date = entry.date;
  return total;
}, { score: 0, date: new Date(0) });

const rank = rows => rows
  .filter(row => row.score > 0)
  .sort(rules.compareStandings)
  .map((row, index) => ({ ...row, pos: index + 1 }));

// Requests arriving while the same data is being loaded share it, so a burst of
// players does not repeat the same database work.
const loading = new Map();

function shareLoad(id, load) {
  if (!loading.has(id)) {
    loading.set(id, load().finally(() => loading.delete(id)));
  }
  return loading.get(id);
}

const loadScoreboard = ({ cutoff = null } = {}) => shareLoad(
  `board:${cutoff ? new Date(cutoff).toISOString() : 'live'}`,
  () => buildScoreboard(cutoff)
);

async function buildScoreboard(cutoff) {
  const before = field => (cutoff ? { [field]: { $lt: new Date(cutoff) } } : {});
  const [challenges, users, teams, solves, awards] = await Promise.all([
    Challenge.find().select('points function initial minimum decay').lean(),
    User.find().select('username role team banned isBlocked hidden showInScoreboard').lean(),
    Team.find().select('name banned isBlocked hidden').lean(),
    Submission.find({ isCorrect: true, ...before('submittedAt') }).select('user team challenge submittedAt').lean(),
    Award.find(before('date')).select('user team creditedTeam value date').lean()
  ]);
  const userById = byId(users);
  const teamById = byId(teams);

  // Live values are stored on the challenge. Frozen dynamic values are recalculated.
  const solveCounts = new Map();
  if (cutoff) {
    solves.forEach(solve => {
      if (rules.countsForValue(userById.get(key(solve.user)), teamById.get(key(solve.team)))) {
        const id = key(solve.challenge);
        solveCounts.set(id, (solveCounts.get(id) || 0) + 1);
      }
    });
  }
  const values = new Map(challenges.map(challenge => {
    const dynamic = challenge.function === 'linear' || challenge.function === 'logarithmic';
    const value = cutoff && dynamic
      ? rules.calculateChallengeValue(challenge, solveCounts.get(key(challenge._id)) || 0)
      : challenge.points;
    return [key(challenge._id), value];
  }));

  const entries = [];
  solves.forEach(solve => {
    if (!values.has(key(solve.challenge))) return; // the challenge was deleted
    if (rules.isVoidUser(userById.get(key(solve.user)))) return;
    entries.push({
      userId: key(solve.user),
      teamId: key(solve.team),
      challengeId: key(solve.challenge),
      value: values.get(key(solve.challenge)),
      date: new Date(solve.submittedAt)
    });
  });
  awards.forEach(award => {
    if (award.user && rules.isVoidUser(userById.get(key(award.user)))) return;
    entries.push({
      userId: key(award.user),
      teamId: key(award.team || award.creditedTeam),
      challengeId: null,
      value: award.value || 0,
      date: new Date(award.date)
    });
  });

  const entriesByTeam = group(entries, 'teamId');
  const entriesByUser = group(entries, 'userId');

  const teamEntries = teamId => entriesByTeam.get(key(teamId)) || [];
  const userEntries = userId => entriesByUser.get(key(userId)) || [];
  // Entries that may appear on the public player ranking: not those earned for a banned or
  // hidden team. Players keep what they earned for a team that was later deleted.
  const listedUserEntries = userId => userEntries(userId).filter(entry => {
    const team = teamById.get(entry.teamId);
    return !team || rules.isListedTeam(team);
  });

  const teamStandings = () => rank(teams.filter(rules.isListedTeam).map(team => ({
    account_id: key(team._id),
    name: team.name,
    ...summarize(teamEntries(team._id)),
    account_url: `/teams/${team._id}`
  })));

  const userStandings = () => rank(users.filter(rules.isListedUser).map(user => ({
    account_id: key(user._id),
    name: user.username,
    ...summarize(listedUserEntries(user._id)),
    account_url: `/users/${user._id}`
  })));

  return { values, userById, teamById, teamEntries, userEntries, listedUserEntries, teamStandings, userStandings, summarize };
}

async function loadSolves(challengeIds) {
  const solves = await Submission.find({ challenge: { $in: challengeIds }, isCorrect: true })
    .select('user team challenge submittedAt')
    .sort({ submittedAt: 1 })
    .lean();
  const [users, teams] = await Promise.all([
    User.find({ _id: { $in: solves.map(solve => solve.user) } })
      .select('username role banned isBlocked hidden showInScoreboard').lean(),
    Team.find({ _id: { $in: solves.map(solve => solve.team).filter(Boolean) } })
      .select('name banned isBlocked hidden').lean()
  ]);
  return { solves, userById: byId(users), teamById: byId(teams) };
}

/**
 * Who solved each challenge, as the viewer may see it. Banned and hidden accounts are
 * left out. During a freeze, only the viewer's own and their team's later solves show.
 */
async function getVisibleSolves(challengeIds, { cutoff = null, viewer = null, includeHidden = false } = {}) {
  const { solves, userById, teamById } = await shareLoad(
    `solves:${challengeIds.join(',')}`,
    () => loadSolves(challengeIds)
  );
  const isOwn = solve => viewer
    && (key(solve.user) === key(viewer._id) || (solve.team && key(solve.team) === key(viewer.team)));

  return solves.filter(solve => {
    const user = userById.get(key(solve.user));
    if (!user || rules.isVoidUser(user)) return false;
    const team = teamById.get(key(solve.team));
    if (!includeHidden && !isOwn(solve)) {
      if (!rules.isListedUser(user) || (team && !rules.isListedTeam(team))) return false;
    }
    return !cutoff || solve.submittedAt < new Date(cutoff) || isOwn(solve);
  }).map(solve => ({
    challengeId: key(solve.challenge),
    userId: solve.user,
    username: userById.get(key(solve.user)).username,
    team: teamById.get(key(solve.team))?.name || 'No Team',
    solvedAt: solve.submittedAt
  }));
}

module.exports = { loadScoreboard, getVisibleSolves };
