/**
 * Keeps team member lists and captains correct when accounts come and go.
 */
const Team = require('../models/Team');
const User = require('../models/User');

// Picks a member who can act as captain, preferring one who is not banned.
async function chooseCaptain(memberIds, session = null) {
  const members = await User.find({ _id: { $in: memberIds }, role: 'user' })
    .select('banned isBlocked').session(session).lean();
  const byId = new Map(members.map(member => [String(member._id), member]));
  const present = memberIds.filter(id => byId.has(String(id)));
  const active = present.find(id => {
    const member = byId.get(String(id));
    return !member.banned && !member.isBlocked;
  });
  return active || present[0] || null;
}

// Gives a team without a captain one of its members.
async function ensureCaptain(teamId, session = null) {
  const team = await Team.findById(teamId).select('members captain').session(session);
  if (!team || team.captain) return;
  const captain = await chooseCaptain(team.members, session);
  if (captain) await Team.updateOne({ _id: team._id }, { $set: { captain } }, { session });
}

// Frees a departed account's place. The team and the points it earned stay.
async function removeFromTeams(userId, session = null) {
  const teams = await Team.find({ $or: [{ members: userId }, { captain: userId }] })
    .select('members captain').session(session);
  for (const team of teams) {
    const members = team.members.filter(id => String(id) !== String(userId));
    const captain = String(team.captain) === String(userId)
      ? await chooseCaptain(members, session)
      : team.captain;
    await Team.updateOne({ _id: team._id }, { $set: { members, captain } }, { session });
  }
  return teams.map(team => team._id);
}

module.exports = { chooseCaptain, ensureCaptain, removeFromTeams };
