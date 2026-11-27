const express = require('express');
const router = express.Router();
const Award = require('../models/Award');
const User = require('../models/User');
const Team = require('../models/Team');
const { protect, authorize } = require('../middleware/auth');
const { clearScoreboardCache } = require('../utils/redis');
const { refreshUserPoints } = require('../utils/teamScore');

/**
 * @route   GET /api/awards
 * @desc    Get all awards (admin only)
 * @access  Private (Admin)
 */
router.get('/', protect, authorize('admin'), async (req, res) => {
  try {
    const awards = await Award.find()
      .populate('user', 'username email')
      .populate('team', 'teamName')
      .sort({ date: -1 });

    res.json({
      success: true,
      count: awards.length,
      data: awards
    });
  } catch (error) {
    console.error('Error fetching awards:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch awards'
    });
  }
});

/**
 * @route   GET /api/awards/user/:userId
 * @desc    Get awards for a specific user
 * @access  Private (User can see their own, admin can see all)
 */
router.get('/user/:userId', protect, async (req, res) => {
  try {
    const { userId } = req.params;

    // Check permission: user can only see their own awards, unless admin
    if (req.user.id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to view these awards'
      });
    }

    const awards = await Award.find({ user: userId })
      .sort({ date: -1 });

    res.json({
      success: true,
      count: awards.length,
      data: awards
    });
  } catch (error) {
    console.error('Error fetching user awards:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user awards'
    });
  }
});

/**
 * @route   GET /api/awards/team/:teamId
 * @desc    Get awards for a specific team
 * @access  Private (Team members can see their team awards, admin can see all)
 */
router.get('/team/:teamId', protect, async (req, res) => {
  try {
    const { teamId } = req.params;

    // Check permission: user must be in the team or be admin
    const user = await User.findById(req.user.id);
    if (user.team?.toString() !== teamId && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to view these awards'
      });
    }

    const awards = await Award.find({ team: teamId })
      .sort({ date: -1 });

    res.json({
      success: true,
      count: awards.length,
      data: awards
    });
  } catch (error) {
    console.error('Error fetching team awards:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch team awards'
    });
  }
});

/**
 * @route   POST /api/awards
 * @desc    Create a new award
 * @access  Private (Admin only)
 */
router.post('/', protect, authorize('admin'), async (req, res) => {
  try {
    const { userId, teamId, name, value, description, category, icon } = req.body;

    // Validate: Must have either user or team
    if (!userId && !teamId) {
      return res.status(400).json({
        success: false,
        error: 'Must specify either userId or teamId'
      });
    }

    if (userId && teamId) {
      return res.status(400).json({
        success: false,
        error: 'Cannot specify both userId and teamId'
      });
    }

    // Verify user/team exists
    let creditedTeam = null;
    if (userId) {
      const userExists = await User.findById(userId);
      if (!userExists) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }
      // The player's current team receives this award too, and keeps it
      creditedTeam = userExists.team || null;
    }

    if (teamId) {
      const teamExists = await Team.findById(teamId);
      if (!teamExists) {
        return res.status(404).json({
          success: false,
          error: 'Team not found'
        });
      }
    }

    if (!Number.isInteger(Number(value))) {
      return res.status(400).json({
        success: false,
        error: 'Award value must be a whole number'
      });
    }

    // Create award
    const award = await Award.create({
      user: userId || null,
      team: teamId || null,
      creditedTeam,
      name,
      value: parseInt(value),
      description: description || '',
      category: category || '',
      icon: icon || ''
    });

    await award.populate([
      { path: 'user', select: 'username email' },
      { path: 'team', select: 'teamName' }
    ]);

    if (userId) await refreshUserPoints([userId]);

    // Clear scoreboard cache
    await clearScoreboardCache();
    
    // Invalidate team points cache if the award affects a team
    if (teamId || creditedTeam) {
      const { invalidateTeamPoints } = require('../utils/teamPointsCache');
      await invalidateTeamPoints(teamId || creditedTeam);
    }

    res.status(201).json({
      success: true,
      data: award
    });
  } catch (error) {
    console.error('Error creating award:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create award'
    });
  }
});

/**
 * @route   PUT /api/awards/:id
 * @desc    Update an award
 * @access  Private (Admin only)
 */
router.put('/:id', protect, authorize('admin'), async (req, res) => {
  try {
    const { name, value, description, category, icon } = req.body;

    let award = await Award.findById(req.params.id);
    if (!award) {
      return res.status(404).json({
        success: false,
        error: 'Award not found'
      });
    }

    if (value !== undefined && !Number.isInteger(Number(value))) {
      return res.status(400).json({
        success: false,
        error: 'Award value must be a whole number'
      });
    }

    // Update fields
    if (name !== undefined) award.name = name;
    if (value !== undefined) award.value = parseInt(value);
    if (description !== undefined) award.description = description;
    if (category !== undefined) award.category = category;
    if (icon !== undefined) award.icon = icon;

    await award.save();
    // award.user is not populated yet, so this is the plain id
    if (award.user) await refreshUserPoints([award.user]);
    await award.populate([
      { path: 'user', select: 'username email' },
      { path: 'team', select: 'teamName' }
    ]);

    // Clear scoreboard cache
    await clearScoreboardCache();
    
    // Invalidate team points cache if the award affects a team
    const affectedTeam = award.team?._id || award.creditedTeam;
    if (affectedTeam) {
      const { invalidateTeamPoints } = require('../utils/teamPointsCache');
      await invalidateTeamPoints(affectedTeam);
    }

    res.json({
      success: true,
      data: award
    });
  } catch (error) {
    console.error('Error updating award:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update award'
    });
  }
});

/**
 * @route   DELETE /api/awards/:id
 * @desc    Delete an award
 * @access  Private (Admin only)
 */
router.delete('/:id', protect, authorize('admin'), async (req, res) => {
  try {
    const award = await Award.findById(req.params.id);
    if (!award) {
      return res.status(404).json({
        success: false,
        error: 'Award not found'
      });
    }
    
    // Store team ID before deletion for cache invalidation
    const teamId = award.team || award.creditedTeam;

    await award.deleteOne();
    if (award.user) await refreshUserPoints([award.user]);

    // Clear scoreboard cache
    await clearScoreboardCache();
    
    // Invalidate team points cache if award was for a team
    if (teamId) {
      const { invalidateTeamPoints } = require('../utils/teamPointsCache');
      await invalidateTeamPoints(teamId);
    }

    res.json({
      success: true,
      data: {}
    });
  } catch (error) {
    console.error('Error deleting award:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete award'
    });
  }
});

module.exports = router;
