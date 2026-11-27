const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const Team = require('../models/Team');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const { invalidateTeamPoints } = require('../utils/teamPointsCache');
const { clearScoreboardCache } = require('../utils/redis');
const { getTeamRawScore } = require('../utils/teamScore');
const { loadScoreboard } = require('../utils/standings');
const { getViewer, isAdmin, getFreezeTime, getVisibility, allows, requireNotBanned } = require('../utils/access');
const { isBannedUser, isBannedTeam, isListedTeam } = require('../utils/scoringRules');
const { takeAttempt, tooMany } = require('../utils/attempts');
const { rescore } = require('../utils/rescore');
const { ensureCaptain } = require('../utils/teamMembership');
const { checkTeamChangesAllowed } = require('../middleware/eventState');
const { listUnlockedHints } = require('../utils/unlockedHints');

const MAX_TEAM_MEMBERS = 4;
const isTeamCaptain = (team, userId) => {
  const captainId = team.captain?._id || team.captain;
  return captainId?.toString() === userId.toString();
};
const sendTeamError = (res, error, fallback) => {
  if (error.code === 11000) {
    return res.status(409).json({ success: false, message: 'A team with that name already exists' });
  }
  return res.status(error.status || 500).json({
    success: false,
    message: error.status ? error.message : (process.env.NODE_ENV === 'development' ? error.message : fallback)
  });
};

const invalidateTeamCaches = async (teamId) => {
  if (teamId) await invalidateTeamPoints(teamId);
  await clearScoreboardCache();
};

// Create a team with the current user as captain.
router.post('/self', protect, requireNotBanned, checkTeamChangesAllowed, async (req, res) => {
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  try {
    const name = String(req.body.name || '').trim();
    const password = String(req.body.password || '');
    if (!name || name.length > 100) {
      throw Object.assign(new Error('Team name is required and must be at most 100 characters'), { status: 400 });
    }
    if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
      throw Object.assign(new Error('Team password must be at least 8 characters and no more than 72 bytes'), { status: 400 });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    let createdTeam;
    await session.withTransaction(async () => {
      const currentUser = await User.findOne({ _id: req.user._id, team: null }).session(session);
      if (!currentUser) {
        throw Object.assign(new Error('Leave your current team before creating another'), { status: 409 });
      }

      const nameKey = name.toLocaleLowerCase('en');
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const existingTeam = await Team.findOne({
        $or: [{ nameKey }, { name: { $regex: `^${escapedName}$`, $options: 'i' } }]
      }).session(session);
      if (existingTeam) {
        throw Object.assign(new Error('A team with that name already exists'), { status: 409 });
      }

      const [team] = await Team.create([{
        name,
        nameKey,
        passwordHash,
        members: [currentUser._id],
        captain: currentUser._id,
        createdBy: currentUser._id,
        maxMembers: MAX_TEAM_MEMBERS
      }], { session });

      const userUpdate = await User.updateOne(
        { _id: currentUser._id, team: null },
        { $set: { team: team._id } },
        { session }
      );
      if (!userUpdate.modifiedCount) {
        throw Object.assign(new Error('You have already joined a team'), { status: 409 });
      }
      createdTeam = team;
    });
    await session.endSession();
    await invalidateTeamCaches(createdTeam._id);
    return res.status(201).json({ success: true, data: createdTeam });
  } catch (error) {
    await session.endSession();
    return sendTeamError(res, error, 'Error creating team');
  }
});

// List teams that users can join by password.
router.get('/available', protect, async (req, res) => {
  try {
    const teams = await Team.find({ hidden: { $ne: true }, banned: { $ne: true } })
      .select('name members maxMembers')
      .sort({ name: 1 })
      .lean();
    return res.json({
      success: true,
      data: teams.map(team => ({
        _id: team._id,
        name: team.name,
        memberCount: team.members?.length || 0,
        maxMembers: Math.min(team.maxMembers || MAX_TEAM_MEMBERS, MAX_TEAM_MEMBERS)
      }))
    });
  } catch (error) {
    console.error('Error fetching joinable teams:', error);
    return res.status(500).json({ success: false, message: 'Error fetching teams' });
  }
});

router.post('/join', protect, requireNotBanned, checkTeamChangesAllowed, async (req, res) => {
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  let attempt = null;
  try {
    const inviteCode = String(req.body.inviteCode || '').trim();
    const teamId = req.body.teamId;
    const password = String(req.body.password || '');
    if (!inviteCode && !teamId) {
      throw Object.assign(new Error('Select a team or use an invitation link'), { status: 400 });
    }
    if (!inviteCode && !mongoose.Types.ObjectId.isValid(teamId)) {
      throw Object.assign(new Error('Invalid team selection'), { status: 400 });
    }

    // Limit password guessing
    attempt = inviteCode ? null : await takeAttempt('teamPassword', req.user._id);
    if (attempt && !attempt.allowed) {
      await session.endSession();
      return tooMany(res, attempt.retryAfter, 'Too many wrong team passwords. Please wait a few minutes.');
    }

    let joinedTeam;
    await session.withTransaction(async () => {
      const currentUser = await User.findById(req.user._id).session(session);
      if (!currentUser) throw Object.assign(new Error('User not found'), { status: 404 });
      if (currentUser.team) throw Object.assign(new Error('You can only belong to one team'), { status: 409 });

      let teamQuery = inviteCode ? { inviteCode } : { _id: teamId };
      let team = await Team.findOne(teamQuery).select('+passwordHash +inviteCode').session(session);
      if (!team || team.hidden || isBannedTeam(team)) {
        throw Object.assign(new Error('Team not found or unavailable'), { status: 404 });
      }
      if (!inviteCode) {
        if (!team.passwordHash || !await bcrypt.compare(password, team.passwordHash)) {
          throw Object.assign(new Error('Incorrect team password'), { status: 401 });
        }
      }

      const userClaim = await User.updateOne(
        { _id: currentUser._id, team: null },
        { $set: { team: team._id } },
        { session }
      );
      if (!userClaim.modifiedCount) {
        throw Object.assign(new Error('You can only belong to one team'), { status: 409 });
      }

      team = await Team.findOneAndUpdate(
        {
          _id: team._id,
          members: { $ne: currentUser._id },
          $expr: { $lt: [{ $size: { $ifNull: ['$members', []] } }, MAX_TEAM_MEMBERS] }
        },
        { $addToSet: { members: currentUser._id } },
        { new: true, session }
      );
      if (!team) {
        throw Object.assign(new Error('This team is full or you are already a member'), { status: 409 });
      }
      await ensureCaptain(team._id, session);
      joinedTeam = team;
    });
    await session.endSession();
    if (attempt) await attempt.release();
    await invalidateTeamCaches(joinedTeam._id);
    return res.json({ success: true, data: joinedTeam });
  } catch (error) {
    await session.endSession();
    // For example a full team: the password was not what failed
    if (attempt && error.status !== 401) await attempt.release();
    return sendTeamError(res, error, 'Error joining team');
  }
});

router.put('/my/team/password', protect, requireNotBanned, async (req, res) => {
  try {
    const password = String(req.body.password || '');
    if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ success: false, message: 'Team password must be at least 8 characters and no more than 72 bytes' });
    }
    const user = await User.findById(req.user._id).select('team');
    const team = user?.team ? await Team.findById(user.team) : null;
    if (!team) return res.status(404).json({ success: false, message: 'You are not in a team' });
    if (!isTeamCaptain(team, req.user._id)) {
      return res.status(403).json({ success: false, message: 'Only the captain can change the team password' });
    }
    team.passwordHash = await bcrypt.hash(password, 12);
    await team.save();
    return res.json({ success: true, message: 'Team password updated' });
  } catch (error) {
    console.error('Error changing team password:', error);
    return res.status(500).json({ success: false, message: 'Error changing team password' });
  }
});

router.post('/my/team/invite', protect, requireNotBanned, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('team');
    const team = user?.team ? await Team.findById(user.team).select('+inviteCode') : null;
    if (!team) return res.status(404).json({ success: false, message: 'You are not in a team' });
    if (!isTeamCaptain(team, req.user._id)) {
      return res.status(403).json({ success: false, message: 'Only the captain can create an invite link' });
    }
    if (!team.inviteCode) {
      team.inviteCode = require('crypto').randomBytes(24).toString('base64url');
      await team.save();
    }
    return res.json({ success: true, inviteCode: team.inviteCode });
  } catch (error) {
    console.error('Error creating team invite:', error);
    return res.status(500).json({ success: false, message: 'Error creating invite link' });
  }
});

router.delete('/my/team/membership', protect, requireNotBanned, checkTeamChangesAllowed, async (req, res) => {
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  try {
    let teamId;
    await session.withTransaction(async () => {
      const user = await User.findById(req.user._id).session(session);
      if (!user?.team) throw Object.assign(new Error('You are not in a team'), { status: 404 });
      const team = await Team.findById(user.team).session(session);
      if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
      if (isTeamCaptain(team, req.user._id)) {
        throw Object.assign(new Error('The captain must disband the team instead of leaving'), { status: 403 });
      }
      team.members = team.members.filter(memberId => memberId.toString() !== req.user._id.toString());
      await team.save({ session });
      user.team = null;
      await user.save({ session });
      teamId = team._id;
    });
    await session.endSession();
    await invalidateTeamCaches(teamId);
    return res.json({ success: true, message: 'You left the team' });
  } catch (error) {
    await session.endSession();
    return sendTeamError(res, error, 'Error leaving team');
  }
});

router.delete('/my/team', protect, requireNotBanned, checkTeamChangesAllowed, async (req, res) => {
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  try {
    let teamId;
    await session.withTransaction(async () => {
      const user = await User.findById(req.user._id).session(session);
      if (!user?.team) throw Object.assign(new Error('You are not in a team'), { status: 404 });
      const team = await Team.findById(user.team).session(session);
      if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
      if (!isTeamCaptain(team, req.user._id)) {
        throw Object.assign(new Error('Only the captain can disband the team'), { status: 403 });
      }
      await User.updateMany({ team: team._id }, { $unset: { team: 1 } }, { session });
      await Team.deleteOne({ _id: team._id }, { session });
      teamId = team._id;
    });
    await session.endSession();
    await invalidateTeamCaches(teamId);
    return res.json({ success: true, message: 'Team disbanded' });
  } catch (error) {
    await session.endSession();
    return sendTeamError(res, error, 'Error disbanding team');
  }
});

// @route   POST /api/teams
// @desc    Create a new team (Admin only)
// @access  Private/Admin
router.post('/', protect, authorize('admin'), async (req, res) => {
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  try {
    const { name, description, members = [], captain, password, hidden, banned, verified } = req.body;
    const normalizedName = String(name || '').trim();
    const teamPassword = String(password || '');
    const memberIds = Array.isArray(members) ? members.map(memberId => memberId.toString()) : [];

    if (!normalizedName || normalizedName.length > 100) {
      throw Object.assign(new Error('Team name is required and must be at most 100 characters'), { status: 400 });
    }
    if (teamPassword.length < 8 || Buffer.byteLength(teamPassword, 'utf8') > 72) {
      throw Object.assign(new Error('Team password must be at least 8 characters and no more than 72 bytes'), { status: 400 });
    }
    if (!memberIds.length || memberIds.length > MAX_TEAM_MEMBERS || new Set(memberIds).size !== memberIds.length) {
      throw Object.assign(new Error(`Select between 1 and ${MAX_TEAM_MEMBERS} unique team members`), { status: 400 });
    }
    if (!captain || !memberIds.includes(captain.toString())) {
      throw Object.assign(new Error('Captain must be a selected team member'), { status: 400 });
    }

    const [passwordHash, nameKey] = await Promise.all([
      bcrypt.hash(teamPassword, 12),
      Promise.resolve(normalizedName.toLocaleLowerCase('en'))
    ]);
    let team;
    await session.withTransaction(async () => {
      const escapedName = normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const existingTeam = await Team.findOne({
        $or: [{ nameKey }, { name: { $regex: `^${escapedName}$`, $options: 'i' } }]
      }).session(session);
      if (existingTeam) throw Object.assign(new Error('A team with that name already exists'), { status: 409 });

      const validMembers = await User.find({
        _id: { $in: memberIds }, role: 'user', team: null
      }).select('_id').session(session);
      if (validMembers.length !== memberIds.length) {
        throw Object.assign(new Error('One or more selected users are invalid or already in a team'), { status: 409 });
      }

      const [createdTeam] = await Team.create([{
        name: normalizedName,
        nameKey,
        passwordHash,
        description,
        members: memberIds,
        captain,
        maxMembers: MAX_TEAM_MEMBERS,
        hidden: !!hidden,
        banned: !!banned,
        verified: !!verified,
        createdBy: req.user._id || req.user.id
      }], { session });
      const assignment = await User.updateMany(
        { _id: { $in: memberIds }, team: null },
        { $set: { team: createdTeam._id } },
        { session }
      );
      if (assignment.matchedCount !== memberIds.length) {
        throw Object.assign(new Error('A selected user joined another team while this team was being created'), { status: 409 });
      }
      team = createdTeam;
    });

    await session.endSession();
    const populatedTeam = await team.populate('members createdBy captain');
    await invalidateTeamCaches(team._id);
    return res.status(201).json({ success: true, data: populatedTeam });
  } catch (error) {
    await session.endSession();
    console.error('Team creation error:', error);
    res.status(error.status || (error.code === 11000 ? 409 : 500)).json({
      success: false,
      message: error.status || error.code === 11000 || process.env.NODE_ENV === 'development'
        ? error.message || 'A team with that name already exists'
        : 'Error creating team'
    });
  }
});

// @route   GET /api/teams/my/team
// @desc    Get current user's team
// @access  Private
router.get('/my/team', protect, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const user = await User.findById(req.user._id).select('team');

    if (!user || !user.team) {
      return res.status(404).json({
        success: false,
        message: 'You are not part of any team'
      });
    }

    await Team.updateOne(
      { _id: user.team },
      { $addToSet: { members: req.user._id } }
    );

    const team = await Team.findById(user.team)
      .select('+inviteCode')
      .populate('members', 'username email points solvedChallenges')
      .populate('captain', 'username email points solvedChallenges')
      .populate('createdBy', 'username');

    if (!team) {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    res.json({
      success: true,
      data: team
    });
  } catch (error) {
    console.error('Error fetching user team:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching team'
    });
  }
});

// @route   GET /api/teams
// @desc    Get all teams with pagination
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const search = req.query.q || '';

    const query = search ? { name: { $regex: search, $options: 'i' } } : {};

    const total = await Team.countDocuments(query);
    
    // Check if user is admin
    const isAdmin = req.user.role === 'admin';
    const view = (req.query.view || '').toString().trim();

    if (!allows((await getVisibility()).account, req.user)) {
      return res.status(403).json({ success: false, message: 'Team pages are hidden by the organisers' });
    }

    // CTFd-style: hidden/banned are available only in admin view
    if (!(isAdmin && view === 'admin')) {
      query.hidden = { $ne: true };
      query.banned = { $ne: true };
      query.isBlocked = { $ne: true };
    }
    
    // Scores come from the scoreboard, which applies visibility and the freeze
    const memberFields = isAdmin ? 'username email points' : 'username';
    const captainFields = isAdmin ? 'username email points' : 'username';
    
    const teams = await Team.find(query)
      .populate('members', memberFields)
      .populate('captain', captainFields)
      .populate('createdBy', 'username')
      .sort({ points: -1 })
      .limit(limit)
      .skip(skip);

    // The stored points field is not maintained, so the admin list shows the calculated score.
    const data = isAdmin && view === 'admin'
      ? await Promise.all(teams.map(async team => ({
        ...team.toJSON(),
        points: Math.max(0, await getTeamRawScore(team._id))
      })))
      : teams.map(team => {
        const safe = team.toJSON();
        if (!isAdmin) {
          delete safe.points;
          delete safe.solvedChallenges;
        }
        return safe;
      });

    res.json({
      success: true,
      count: teams.length,
      total,
      page,
      pages: Math.ceil(total / limit),
      data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching teams'
    });
  }
});

// @route   GET /api/teams/:id
// @desc    Get single team
// @access  Private
router.get('/:id', protect, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const viewer = await getViewer(req);
    const admin = isAdmin(viewer);

    // Hide emails from other players
    const memberFields = admin ? 'username email banned isBlocked' : 'username banned isBlocked';

    const team = await Team.findById(req.params.id)
      .select('+inviteCode')
      .populate('members', memberFields)
      .populate('createdBy', 'username');

    if (!team) {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    const own = String(viewer.team) === String(team._id);

    // CTFd-style visibility rule: hidden and banned teams are seen by admins and members
    if (!admin && !own && !isListedTeam(team)) {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    const visibility = await getVisibility();
    if (!own && !allows(visibility.account, viewer)) {
      return res.status(403).json({ success: false, message: 'Team pages are hidden by the organisers' });
    }

    // A team sees its own live score; others see it as of the freeze
    const freezeTime = admin ? null : await getFreezeTime();
    const cutoff = own ? null : freezeTime;
    const showScores = own || allows(visibility.score, viewer);

    const board = await loadScoreboard({ cutoff });
    // Rank is the team's place on the scoreboard the viewer sees
    const publicBoard = cutoff === freezeTime ? board : await loadScoreboard({ cutoff: freezeTime });
    const rank = allows(visibility.score, viewer)
      ? publicBoard.teamStandings().find(row => row.account_id === String(team._id))?.pos || null
      : null;

    const entries = showScores ? board.teamEntries(team._id) : [];
    const solves = entries.filter(entry => entry.challengeId);
    const score = showScores ? Math.max(0, board.summarize(entries).score) : null;

    // Hints paid for by this team, including any unlocked by members who have since left
    const teamHints = showScores
      ? (await listUnlockedHints({ team: team._id }))
        .filter(hint => !cutoff || hint.unlockedAt < cutoff)
      : [];
    const hintsByUser = new Map();
    teamHints.forEach(hint => {
      const userId = hint.userId.toString();
      hintsByUser.set(userId, [...(hintsByUser.get(userId) || []), hint]);
    });

    // Each member's solves that count for this team
    const updatedMembers = team.members.map(member => {
      const memberId = member._id.toString();
      const own = solves.filter(entry => entry.userId === memberId);

      return {
        _id: member._id,
        username: member.username,
        email: member.email,
        isBanned: isBannedUser(member),
        points: showScores ? own.reduce((sum, entry) => sum + entry.value, 0) : null,
        personallySolvedCount: own.length,
        personallySolvedChallenges: own.map(entry => entry.challengeId),
        unlockedHints: hintsByUser.get(memberId) || []
      };
    });

    const memberIdSet = new Set(updatedMembers.map(member => member._id.toString()));
    const formerIds = [...hintsByUser.keys()].filter(userId => !memberIdSet.has(userId));
    const formerUsers = formerIds.length
      ? await User.find({ _id: { $in: formerIds } }).select('username').lean()
      : [];
    const formerMemberHints = formerIds.map(userId => ({
      _id: userId,
      username: formerUsers.find(user => user._id.toString() === userId)?.username || 'Unknown',
      unlockedHints: hintsByUser.get(userId)
    }));

    // Build response with calculated values
    const teamData = {
      _id: team._id,
      name: team.name,
      description: team.description,
      captain: updatedMembers.find(member => member._id.toString() === String(team.captain)) || null,
      members: updatedMembers,
      hintsUnlocked: teamHints.length,
      formerMemberHints,
      totalPoints: score,
      points: score,
      rank,
      scoresHidden: !showScores,
      frozen: Boolean(cutoff),
      inviteCode: isTeamCaptain(team, req.user._id) ? team.inviteCode : undefined,
      maxMembers: MAX_TEAM_MEMBERS,
      isCaptain: isTeamCaptain(team, req.user._id),
      // Challenges solved for this team, including by members who have since left
      solvedChallenges: showScores ? new Set(solves.map(entry => entry.challengeId)).size : null
    };

    res.json({
      success: true,
      data: teamData
    });
  } catch (error) {
    console.error('Error fetching team:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching team'
    });
  }
});

// @route   PUT /api/teams/:id
// @desc    Update team (Admin only)
// @access  Private/Admin
router.put('/:id', protect, authorize('admin'), async (req, res) => {
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  try {
    const { name, description, members, hidden, banned, verified, captain } = req.body;

    if (members !== undefined && (!Array.isArray(members) || members.length > MAX_TEAM_MEMBERS || members.length === 0)) {
      await session.endSession();
      return res.status(400).json({
        success: false,
        message: `A team must have between 1 and ${MAX_TEAM_MEMBERS} members`
      });
    }

    let team;
    await session.withTransaction(async () => {
      team = await Team.findById(req.params.id).session(session);
      if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });

      const nextMembers = members === undefined ? team.members.map(memberId => memberId.toString()) : members.map(memberId => memberId.toString());
      if (new Set(nextMembers).size !== nextMembers.length) {
        throw Object.assign(new Error('Team members must be unique'), { status: 400 });
      }
      const nextCaptain = captain === undefined ? team.captain?.toString() : captain?.toString();
      if (!nextCaptain || !nextMembers.includes(nextCaptain)) {
        throw Object.assign(new Error('Captain must be a team member'), { status: 400 });
      }

      if (members !== undefined) {
        const availableMembers = await User.find({
          _id: { $in: nextMembers },
          $or: [{ team: null }, { team: team._id }]
        }).select('_id').session(session);
        if (availableMembers.length !== nextMembers.length) {
          throw Object.assign(new Error('A selected user is already in another team or does not exist'), { status: 409 });
        }
        await User.updateMany(
          { team: team._id, _id: { $nin: nextMembers } },
          { $set: { team: null } },
          { session }
        );
        const assignment = await User.updateMany(
          { _id: { $in: nextMembers }, $or: [{ team: null }, { team: team._id }] },
          { $set: { team: team._id } },
          { session }
        );
        if (assignment.matchedCount !== nextMembers.length) {
          throw Object.assign(new Error('A selected user joined another team while this update was being saved'), { status: 409 });
        }
        team.members = nextMembers;
      }

      if (name !== undefined) team.name = String(name).trim();
      if (description !== undefined) team.description = description;
      team.captain = nextCaptain;
      if (hidden !== undefined) team.hidden = !!hidden;
      if (verified !== undefined) team.verified = !!verified;
      if (banned !== undefined) {
        team.banned = !!banned;
        team.isBlocked = !!banned;
        team.blockedReason = banned ? 'Banned by admin' : null;
        team.blockedAt = banned ? new Date() : null;
      }
      await team.save({ session });
    });
    await session.endSession();
    await team.populate('members createdBy');
    await invalidateTeamCaches(team._id);
    await rescore(); // banning or hiding a team changes dynamic values

    res.json({
      success: true,
      data: team
    });
  } catch (error) {
    await session.endSession();
    res.status(error.status || (error.code === 11000 ? 409 : 500)).json({
      success: false,
      message: error.status || error.code === 11000 || process.env.NODE_ENV === 'development'
        ? error.message || 'A team with that name already exists'
        : 'Error updating team'
    });
  }
});

// @route   DELETE /api/teams/:id
// @desc    Delete team (Admin only)
// @access  Private/Admin
router.delete('/:id', protect, authorize('admin'), async (req, res) => {
  try {
    const team = await Team.findById(req.params.id);

    if (!team) {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    await User.updateMany(
      { team: req.params.id },
      { $unset: { team: 1 } }
    );

    await Team.findByIdAndDelete(req.params.id);
    await invalidateTeamCaches(req.params.id);
    await rescore();

    res.json({
      success: true,
      message: 'Team deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting team'
    });
  }
});

// @route   POST /api/teams/:id/members/:userId
// @desc    Add member to team (Admin only)
// @access  Private/Admin
router.post('/:id/members/:userId', protect, authorize('admin'), async (req, res) => {
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  try {
    let team;
    await session.withTransaction(async () => {
      const currentTeam = await Team.findById(req.params.id).session(session);
      if (!currentTeam) throw Object.assign(new Error('Team not found'), { status: 404 });
      const user = await User.findOne({ _id: req.params.userId, team: null }).session(session);
      if (!user) throw Object.assign(new Error('User not found or already in a team'), { status: 409 });
      const updatedTeam = await Team.findOneAndUpdate(
        {
          _id: currentTeam._id,
          members: { $ne: user._id },
          $expr: { $lt: [{ $size: { $ifNull: ['$members', []] } }, MAX_TEAM_MEMBERS] }
        },
        { $addToSet: { members: user._id } },
        { new: true, session }
      );
      if (!updatedTeam) throw Object.assign(new Error('Team is full or user is already a member'), { status: 409 });
      const assigned = await User.updateOne({ _id: user._id, team: null }, { $set: { team: currentTeam._id } }, { session });
      if (!assigned.modifiedCount) throw Object.assign(new Error('User is already in a team'), { status: 409 });
      await ensureCaptain(updatedTeam._id, session);
      team = updatedTeam;
    });
    await session.endSession();
    await team.populate('members createdBy');
    await invalidateTeamCaches(team._id);

    res.json({
      success: true,
      data: team
    });
  } catch (error) {
    await session.endSession();
    res.status(error.status || 500).json({
      success: false,
      message: error.status || process.env.NODE_ENV === 'development'
        ? error.message
        : 'Error adding member to team'
    });
  }
});

// @route   DELETE /api/teams/:id/members/:userId
// @desc    Remove member from team (Admin only)
// @access  Private/Admin
router.delete('/:id/members/:userId', protect, authorize('admin'), async (req, res) => {
  const mongoose = require('mongoose');
  const session = await mongoose.startSession();
  try {
    let team;
    await session.withTransaction(async () => {
      team = await Team.findById(req.params.id).session(session);
      if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
      if (!team.members.some(memberId => memberId.toString() === req.params.userId)) {
        throw Object.assign(new Error('User is not a member of this team'), { status: 404 });
      }
      if (isTeamCaptain(team, req.params.userId)) {
        throw Object.assign(new Error('Assign a new captain before removing the current captain'), { status: 409 });
      }
      team.members = team.members.filter(memberId => memberId.toString() !== req.params.userId);
      await team.save({ session });
      const result = await User.updateOne(
        { _id: req.params.userId, team: team._id },
        { $set: { team: null } },
        { session }
      );
      if (!result.matchedCount) throw Object.assign(new Error('User is no longer assigned to this team'), { status: 409 });
    });
    await session.endSession();
    await team.populate('members createdBy');
    await invalidateTeamCaches(team._id);

    res.json({
      success: true,
      data: team
    });
  } catch (error) {
    await session.endSession();
    res.status(error.status || 500).json({
      success: false,
      message: error.status ? error.message : 'Error removing member from team'
    });
  }
});

module.exports = router;
