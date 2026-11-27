/**
 * One-time update of existing data to the new scoring rules.
 *
 *   node scripts/migrateTeamScoring.js           # preview, changes nothing
 *   node scripts/migrateTeamScoring.js --apply   # write the changes
 *
 * Older solves do not record which team they were made for. Each one is given the
 * solver's CURRENT team. If a team then has the same challenge twice, only the earliest
 * solve counts for the team; the others stay on the player's own score.
 * Running it again is safe: it only fills in records that have not been updated yet.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const User = require('../models/User');
const Team = require('../models/Team');
const Challenge = require('../models/Challenge');
const Submission = require('../models/Submission');
const Award = require('../models/Award');
const scoringService = require('../services/scoringService');
const { refreshUserPoints } = require('../utils/teamScore');

const apply = process.argv.includes('--apply');
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/ctf-platform';
const key = value => String(value);

async function main() {
  // Indexes are created below, after duplicates have been resolved
  mongoose.set('autoIndex', false);
  await mongoose.connect(MONGODB_URI);

  const users = await User.find().select('username team role').lean();
  const teams = await Team.find().select('name').lean();
  const challenges = await Challenge.find().select('title points').lean();
  const userById = new Map(users.map(user => [key(user._id), user]));
  const teamIds = new Set(teams.map(team => key(team._id)));
  const challengeById = new Map(challenges.map(challenge => [key(challenge._id), challenge]));

  const currentTeam = userId => {
    const team = userById.get(key(userId))?.team;
    return team && teamIds.has(key(team)) ? team : null;
  };
  const isPlayer = userId => (userById.get(key(userId))?.role || 'user') === 'user';
  const pointsOf = challengeId => challengeById.get(key(challengeId))?.points || 0;

  // ---------- plan solves and attempts ----------
  const assigned = await Submission.find({ isCorrect: true, team: { $type: 'objectId' } })
    .select('team challenge')
    .lean();
  const claimed = new Set(assigned.map(item => `${item.team}:${item.challenge}`));
  const legacy = await Submission.find({ team: { $exists: false } })
    .select('user challenge isCorrect submittedAt')
    .sort({ submittedAt: 1, _id: 1 })
    .lean();

  const duplicates = [];
  const planned = legacy.map(item => {
    let team = currentTeam(item.user);
    if (item.isCorrect && team) {
      const claim = `${team}:${item.challenge}`;
      if (!isPlayer(item.user)) {
        team = null;
      } else if (claimed.has(claim)) {
        duplicates.push({ ...item, team });
        team = null;
      } else {
        claimed.add(claim);
      }
    }
    return { ...item, newTeam: team };
  });

  const legacyAwards = await Award.find({ creditedTeam: { $exists: false } }).select('user team value').lean();
  const plannedAwards = legacyAwards.map(award => ({
    ...award,
    creditedTeam: award.user ? currentTeam(award.user) : null
  }));

  // ---------- report ----------
  const allCorrect = await Submission.find({ isCorrect: true }).select('user challenge team').lean();
  const allAwards = await Award.find().select('user team creditedTeam value').lean();
  const plannedTeam = new Map(planned.map(item => [key(item._id), item.newTeam]));
  const plannedCredit = new Map(plannedAwards.map(award => [key(award._id), award.creditedTeam]));

  console.log(`Solves and attempts to update: ${legacy.length}`);
  console.log(`Awards to update: ${legacyAwards.length}`);
  console.log(`Duplicate team solves to stop counting: ${duplicates.length}`);
  duplicates.forEach(item => {
    const team = teams.find(entry => key(entry._id) === key(item.team));
    console.log(`  - ${team?.name}: "${challengeById.get(key(item.challenge))?.title || 'deleted challenge'}" `
      + `also solved by ${userById.get(key(item.user))?.username || 'unknown'}`);
  });

  console.log('\nTeam scores (old rules -> new rules):');
  teams.forEach(team => {
    const members = new Set(users.filter(user => key(user.team) === key(team._id)).map(user => key(user._id)));
    let before = 0;
    let after = 0;
    allCorrect.forEach(solve => {
      if (!isPlayer(solve.user)) return;
      if (members.has(key(solve.user))) before += pointsOf(solve.challenge);
      const solveTeam = plannedTeam.has(key(solve._id)) ? plannedTeam.get(key(solve._id)) : solve.team;
      if (solveTeam && key(solveTeam) === key(team._id)) after += pointsOf(solve.challenge);
    });
    allAwards.forEach(award => {
      const credit = plannedCredit.has(key(award._id)) ? plannedCredit.get(key(award._id)) : award.creditedTeam;
      if (key(award.team) === key(team._id) || members.has(key(award.user))) before += award.value || 0;
      if (key(award.team) === key(team._id) || (credit && key(credit) === key(team._id))) after += award.value || 0;
    });
    console.log(`  ${team.name}: ${Math.max(0, before)} -> ${Math.max(0, after)}`);
  });

  if (!apply) {
    console.log('\nPreview only. Nothing was changed. Run again with --apply to save.');
    return;
  }

  // ---------- apply ----------
  if (planned.length) {
    await Submission.bulkWrite(planned.map(item => ({
      updateOne: {
        filter: { _id: item._id, team: { $exists: false } },
        update: { $set: { team: item.newTeam } }
      }
    })));
  }
  if (plannedAwards.length) {
    await Award.bulkWrite(plannedAwards.map(award => ({
      updateOne: {
        filter: { _id: award._id, creditedTeam: { $exists: false } },
        update: { $set: { creditedTeam: award.creditedTeam } }
      }
    })));
  }

  await Submission.createIndexes();
  await Award.createIndexes();

  // Rebuild stored solve lists, which used to include teammates' solves
  for (const user of users) {
    const solved = await Submission.distinct('challenge', { user: user._id, isCorrect: true });
    await User.updateOne({ _id: user._id }, { $set: { solvedChallenges: solved } });
  }
  for (const team of teams) {
    const solved = await Submission.distinct('challenge', { team: team._id, isCorrect: true });
    await Team.updateOne({ _id: team._id }, { $set: { solvedChallenges: solved } });
  }
  for (const challenge of challenges) {
    await scoringService.updateChallengeValue(challenge._id);
  }
  await refreshUserPoints(users.map(user => user._id));

  console.log('\nMigration applied.');
}

main()
  .catch(error => {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
