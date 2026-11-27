/**
 * Brings existing data in line with the CTF scoring rules. Run after deploying.
 *
 *   node scripts/applyCtfRules.js           # preview, changes nothing
 *   node scripts/applyCtfRules.js --apply   # write the changes
 *
 * - Links old hint costs to their challenge, so deleting it refunds them.
 * - Restores players left off the scoreboard although they are neither hidden nor banned.
 * - Recalculates dynamic challenge values and stored player points.
 * It also lists accounts and challenges that need an admin's attention.
 * Running it again is safe.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const User = require('../models/User');
const Team = require('../models/Team');
const Challenge = require('../models/Challenge');
const Award = require('../models/Award');
require('../models/Submission');
require('../models/RateLimit');
const scoringService = require('../services/scoringService');
const { refreshUserPoints } = require('../utils/teamScore');
const { loadScoreboard } = require('../utils/standings');
const { isBannedUser, validateScoring } = require('../utils/scoringRules');

const apply = process.argv.includes('--apply');
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/ctf-platform';
const names = list => (list.length ? list.join(', ') : 'none');

async function printStandings(title) {
  const board = await loadScoreboard();
  const rows = board.teamStandings();
  console.log(`\n${title}`);
  if (!rows.length) console.log('  No team has points.');
  rows.forEach(row => console.log(`  ${row.pos}. ${row.name}: ${row.score}`));
}

async function main() {
  await mongoose.connect(MONGODB_URI);

  const challenges = await Challenge.find().lean();
  const users = await User.find().select('username role team banned isBlocked hidden showInScoreboard').lean();
  const teamIds = new Set((await Team.find().select('_id').lean()).map(team => String(team._id)));
  const players = users.filter(user => user.role === 'user');

  // Old hint costs are named after the challenge
  const unlinked = await Award.find({ category: 'hints', challenge: null }).select('name').lean();
  const links = unlinked.map(award => ({
    award,
    challenge: challenges.find(item => `Hint Unlock: ${item.title}`.slice(0, 80) === award.name)
  }));
  const linkable = links.filter(link => link.challenge);

  const restore = players.filter(user => user.showInScoreboard === false && !user.hidden && !isBannedUser(user));
  const teamless = players.filter(user => !isBannedUser(user) && !teamIds.has(String(user.team)));
  const invalid = challenges
    .map(challenge => ({ title: challenge.title, error: validateScoring(challenge) }))
    .filter(item => item.error);

  console.log(`Hint costs to link to a challenge: ${linkable.length}`);
  if (links.length > linkable.length) {
    console.log(`Hint costs with no matching challenge (left as they are): ${links.length - linkable.length}`);
  }
  console.log(`Players to show on the scoreboard again: ${names(restore.map(user => user.username))}`);
  console.log(`Players without a team (they cannot submit flags): ${names(teamless.map(user => user.username))}`);
  console.log(`Challenges with invalid point settings: ${names(invalid.map(item => `${item.title} (${item.error})`))}`);

  if (!apply) {
    await printStandings('Team scoreboard under the new rules, before recalculating dynamic values:');
    console.log('\nPreview only. Nothing was changed. Run again with --apply to save.');
    return;
  }

  if (linkable.length) {
    await Award.bulkWrite(linkable.map(({ award, challenge }) => ({
      updateOne: { filter: { _id: award._id }, update: { $set: { challenge: challenge._id } } }
    })));
  }
  if (restore.length) {
    await User.updateMany({ _id: { $in: restore.map(user => user._id) } }, { $set: { showInScoreboard: true } });
  }
  for (const challenge of challenges) {
    await scoringService.updateChallengeValue(challenge._id);
  }
  await refreshUserPoints(users.map(user => user._id));

  await printStandings('Team scoreboard:');
  console.log('\nRules applied.');
}

main()
  .catch(error => {
    console.error('Update failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
