/**
 * Repairs data left behind by earlier mistakes.
 *
 *   node scripts/repairData.js           # preview, changes nothing
 *   node scripts/repairData.js --apply   # write the changes
 *
 * - Frees team places still held by deleted users and replaces missing captains.
 * - Erases mistyped passwords saved in the login logs.
 * Running it again is safe.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Team = require('../models/Team');
const User = require('../models/User');
const LoginLog = require('../models/LoginLog');
const { chooseCaptain } = require('../utils/teamMembership');

const apply = process.argv.includes('--apply');
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/ctf-platform';

async function main() {
  await mongoose.connect(MONGODB_URI);

  const userIds = new Set((await User.find().select('_id').lean()).map(user => String(user._id)));
  const teams = await Team.find().select('name members captain').lean();
  let repaired = 0;

  for (const team of teams) {
    const members = (team.members || []).filter(id => userIds.has(String(id)));
    const removed = (team.members || []).length - members.length;
    const hasCaptain = members.some(id => String(id) === String(team.captain));
    const captain = hasCaptain ? team.captain : await chooseCaptain(members);
    if (!removed && String(captain || '') === String(team.captain || '')) continue;

    repaired += 1;
    console.log(`  ${team.name}: ${removed} deleted member(s) to remove${hasCaptain ? '' : ', captain to be replaced'}`);
    if (apply) await Team.updateOne({ _id: team._id }, { $set: { members, captain } });
  }
  console.log(`Teams needing repair: ${repaired}`);

  // These fields are no longer part of the model, so use the collection directly
  const saved = { $or: [{ failedPassword: { $exists: true } }, { passwordExpiresAt: { $exists: true } }] };
  console.log(`Login log entries holding a saved password: ${await LoginLog.collection.countDocuments(saved)}`);
  if (apply) {
    await LoginLog.collection.updateMany(saved, { $unset: { failedPassword: '', passwordExpiresAt: '' } });
    console.log('\nRepairs applied.');
  } else {
    console.log('\nPreview only. Nothing was changed. Run again with --apply to save.');
  }
}

main()
  .catch(error => {
    console.error('Repair failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
