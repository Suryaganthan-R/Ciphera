const express = require('express');
const { listUnlockedHints } = require('../utils/unlockedHints');
const { getUserRawScore, getSolvedChallengeIds } = require('../utils/teamScore');
const Challenge = require('../models/Challenge');
const Submission = require('../models/Submission');
const { loadScoreboard } = require('../utils/standings');
const { getViewer, isAdmin: isAdminViewer, getFreezeTime, getVisibility, allows } = require('../utils/access');
const { isListedUser } = require('../utils/scoringRules');
const { takeAttempt, tooMany } = require('../utils/attempts');
const { rescore } = require('../utils/rescore');
const { ensureCaptain, removeFromTeams } = require('../utils/teamMembership');
const router = express.Router();
const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');
const Team = require('../models/Team');
const Configuration = require('../models/Configuration');
const LoginLog = require('../models/LoginLog');
const { protect, authorize } = require('../middleware/auth');

const {
  sanitizeInput,
  validateInput,
  enhancedValidation
} = require('../middleware/security');

const { sendOTPEmail } = require('../utils/email');
const requestIp = require('request-ip');
const UAParser = require('ua-parser-js');
const moment = require('moment-timezone');
const { OAuth2Client } = require('google-auth-library');
const googleOAuthClient = new OAuth2Client();

// Real-time logging function
const logActivity = (action, details = {}) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] AUTH: ${action}`, details);
};
const crypto = require('crypto');
const { getRedisClient } = require('../utils/redis');
// Use centralized Redis client for scoreboard caching
const redisClient = getRedisClient();
const SUPERADMIN_EMAIL = 'mistermanuniq@gmail.com';
const isSuperadmin = (user) => user.email?.toLowerCase() === SUPERADMIN_EMAIL;

// Helper function to get real IP address using request-ip
const getRealIP = (req) => {
  const clientIp = requestIp.getClientIp(req);
  // Clean up IPv6 mapped IPv4 addresses
  if (clientIp && clientIp.startsWith('::ffff:')) {
    return clientIp.substring(7);
  }
  return clientIp || 'Unknown';
};

// Helper function to parse user agent
const parseUserAgent = (userAgentString) => {
  if (!userAgentString) return 'Unknown';

  const parser = new UAParser(userAgentString);
  const result = parser.getResult();

  const browser = result.browser.name ? `${result.browser.name} ${result.browser.version}` : 'Unknown Browser';
  const os = result.os.name ? `${result.os.name} ${result.os.version}` : 'Unknown OS';
  const device = result.device.type ? result.device.type : 'desktop';

  return `${browser} on ${os} (${device})`;
};

// Helper function to create login log
const createLoginLog = async (user, req, status, failureReason = null) => {
  try {
    // Only create log if user exists (has valid _id)
    if (user && user._id) {
      // Get real IP address using request-ip library
      const realIP = getRealIP(req);

      // Parse user agent for better readability
      const rawUserAgent = req.get('User-Agent') || 'Unknown';
      const parsedUserAgent = parseUserAgent(rawUserAgent);

      // Create timestamp in Indian Standard Time (IST)
      const istTime = moment().tz('Asia/Kolkata').toDate();

      const logData = {
        user: user._id,
        email: user.email,
        username: user.username,
        ipAddress: realIP,
        userAgent: parsedUserAgent,
        loginTime: istTime,
        status,
        failureReason
      };

      const loginLog = await LoginLog.create(logData);

      console.log(`Login log created: ${user.username} - ${status} - IP: ${realIP} - Agent: ${parsedUserAgent}`);
      return loginLog;
    }
  } catch (error) {
    console.error('Error creating login log:', error);
  }
};

// Generate JWT Token (fully env-driven)
const generateToken = (id) => {
  try {
    console.log('[JWT Debug] process.env.JWT_SECRET:', process.env.JWT_SECRET ? 'EXISTS' : 'MISSING');
    console.log('[JWT Debug] config.jwt.secret:', config.jwt.secret ? 'EXISTS' : 'MISSING');
    console.log('[JWT Debug] config.jwt:', JSON.stringify(config.jwt));
    
    if (!config.jwt.secret) {
      throw new Error('JWT_SECRET is not defined in environment variables');
    }
    return jwt.sign({ id }, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn
    });
  } catch (error) {
    console.error('[JWT Error]', error.message);
    throw error;
  }
};

// Helper: Set JWT in secure httpOnly cookie (XSS protection)
const setTokenCookie = (res, token) => {
  const isProduction = process.env.NODE_ENV === 'production';
  
  // Calculate maxAge from JWT_ACCESS_EXPIRE (e.g., '15m' -> 15 * 60 * 1000)
  const accessExpire = config.jwt.accessTokenExpiresIn || '15m';
  let maxAge = 15 * 60 * 1000; // Default 15 minutes
  
  if (accessExpire.endsWith('m')) {
    maxAge = parseInt(accessExpire) * 60 * 1000;
  } else if (accessExpire.endsWith('h')) {
    maxAge = parseInt(accessExpire) * 60 * 60 * 1000;
  } else if (accessExpire.endsWith('d')) {
    maxAge = parseInt(accessExpire) * 24 * 60 * 60 * 1000;
  }
  
  res.cookie('token', token, {
    httpOnly: true,        // Cannot be accessed by JavaScript (XSS protection)
    secure: isProduction,  // Only sent over HTTPS in production
    sameSite: 'lax',       // CSRF protection while allowing same-site navigation
    maxAge: maxAge,        // Match JWT expiry from config
    path: '/'
  });
};

// Helper: Clear token cookie on logout
const clearTokenCookie = (res) => {
  res.cookie('token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',  // Must match setTokenCookie setting
    maxAge: 0,        // Use maxAge: 0 instead of expires for reliable clearing
    path: '/'
  });
};

// @route   POST /api/auth/register
// @desc    Public registration based on configuration visibility
// @access  Public
router.post('/register', async (req, res) => {
  try {
    const cfg = await Configuration.findOne({ key: 'global' }).select('visibility').lean();
    const registrationVisibility = cfg?.visibility?.registration || 'private';

    if (registrationVisibility !== 'public') {
      return res.status(403).json({
        success: false,
        message: 'Public registration is currently disabled.',
        registrationDisabled: true
      });
    }

    return res.status(501).json({
      success: false,
      message: 'Public registration is enabled in configuration but this endpoint is not fully implemented yet. Use admin user creation for now.'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to check registration visibility setting'
    });
  }
});

// @route   POST /api/auth/google
// @desc    Verify Google identity and sign in or create an eligible account
// @access  Public
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    const clientId = process.env.GOOGLE_CLIENT_ID;

    if (!clientId) {
      return res.status(503).json({ success: false, message: 'Google sign-in is not configured.' });
    }
    if (!credential || typeof credential !== 'string') {
      return res.status(400).json({ success: false, message: 'A Google credential is required.' });
    }

    const ticket = await googleOAuthClient.verifyIdToken({ idToken: credential, audience: clientId });
    const googleUser = ticket.getPayload();
    if (!googleUser?.email || googleUser.email_verified !== true) {
      return res.status(401).json({ success: false, message: 'Google did not provide a verified email address.' });
    }

    const email = googleUser.email.toLowerCase();
    let user = await User.findOne({ email });
    if (!user) {
      const cfg = await Configuration.findOne({ key: 'global' }).select('visibility').lean();
      if ((cfg?.visibility?.registration || 'private') !== 'public') {
        return res.status(403).json({
          success: false,
          message: 'Public registration is currently disabled. Contact an administrator to create your account.'
        });
      }

      const cleanedUsername = (googleUser.name || email.split('@')[0])
        .normalize('NFKD')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 24);
      const baseUsername = cleanedUsername.length >= 3 ? cleanedUsername : `user_${cleanedUsername || 'google'}`;
      let username = baseUsername;
      let suffix = 1;
      while (await User.exists({ username })) {
        const suffixText = `_${suffix++}`;
        username = `${baseUsername.slice(0, 24 - suffixText.length)}${suffixText}`;
      }

      user = await User.create({
        username,
        email,
        password: crypto.randomBytes(32).toString('hex'),
        role: 'user',
        verified: true,
        isEmailVerified: true
      });
    }

    if (user.isBlocked) {
      await createLoginLog(user, req, 'failed', 'Account blocked by admin');
      return res.status(403).json({
        success: false,
        message: 'You are blocked. Contact an administrator for further information.',
        isBlocked: true,
        blockedReason: user.blockedReason
      });
    }

    user.lastLoginAt = new Date();
    await user.save();
    await user.resetLoginAttempts();
    await createLoginLog(user, req, 'success');
    await user.populate('team');

    const refreshTokenUtils = require('../utils/refreshToken');
    const clientIp = getRealIP(req);
    const userAgentParsed = parseUserAgent(req.get('User-Agent'));
    const tokens = await refreshTokenUtils.createTokenPair(user, clientIp, userAgentParsed);
    const isProduction = process.env.NODE_ENV === 'production';
    const durationInMs = (value, fallback) => {
      const match = /^(\d+)([mhd])$/.exec(value || '');
      if (!match) return fallback;
      const multipliers = { m: 60000, h: 3600000, d: 86400000 };
      return Number(match[1]) * multipliers[match[2]];
    };
    const accessMaxAge = durationInMs(config.jwt.accessTokenExpiresIn, 15 * 60 * 1000);
    const refreshMaxAge = durationInMs(config.jwt.refreshTokenExpiresIn, 7 * 24 * 60 * 60 * 1000);
    const cookieOptions = { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' };

    res.cookie('access_token', tokens.accessToken, { ...cookieOptions, maxAge: accessMaxAge });
    res.cookie('refresh_token', tokens.refreshToken, { ...cookieOptions, maxAge: refreshMaxAge });
    res.cookie('token', tokens.accessToken, { ...cookieOptions, maxAge: accessMaxAge });

    res.json({
      success: true,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        points: user.points,
        team: user.team ? {
          _id: user.team._id ? user.team._id.toString() : user.team.toString(),
          name: user.team.name || 'Team'
        } : null
      }
    });
  } catch (error) {
    if (User.db.readyState !== 1) {
      return res.status(503).json({
        success: false,
        message: 'Google sign-in is temporarily unavailable because the database is disconnected. Check MongoDB Atlas Network Access and try again.'
      });
    }

    console.error('Google sign-in error:', error);
    res.status(401).json({
      success: false,
      message: 'Google sign-in failed. Please verify your account and try again.'
    });
  }
});

// @route   POST /api/auth/verify-otp
// @desc    Verify OTP and activate user account
// @access  Public
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    // Validate input
    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and OTP'
      });
    }

    let validatedEmail;
    try {
      validatedEmail = validateInput.email(email);
    } catch (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError.message
      });
    }

    // Find user
    const user = await User.findOne({ email: validatedEmail }).select('+otp');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if already verified
    if (user.isEmailVerified) {
      return res.status(400).json({
        success: false,
        message: 'Email already verified'
      });
    }

    // Verify OTP
    if (!user.verifyOTP(otp)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP'
      });
    }

    // Mark email as verified and clear OTP
    user.isEmailVerified = true;
    user.clearOTP();
    await user.save();

    // Generate token and set in httpOnly cookie
    const token = generateToken(user._id);
    setTokenCookie(res, token);

    res.json({
      success: true,
      message: 'Email verified successfully',
      // Token NOT sent in response body (httpOnly cookie only)
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        points: user.points,
        isEmailVerified: user.isEmailVerified
      }
    });
  } catch (error) {
    console.error('OTP verification error:', error);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ?
        `Error verifying OTP: ${error.message}` :
        'Error verifying OTP. Please try again later.'
    });
  }
});

// @route   POST /api/auth/resend-otp
// @desc    Resend OTP to email
// @access  Public
router.post('/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email'
      });
    }

    let validatedEmail;
    try {
      validatedEmail = validateInput.email(email);
    } catch (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError.message
      });
    }

    const user = await User.findOne({ email: validatedEmail });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.isEmailVerified) {
      return res.status(400).json({
        success: false,
        message: 'Email already verified'
      });
    }

    // Generate new OTP
    const otp = user.generateOTP();
    await user.save();

    // Send OTP email
    try {
      await sendOTPEmail(user.email, otp);
    } catch (emailError) {
      console.error('Failed to send OTP email:', emailError);
      return res.status(500).json({
        success: false,
        message: 'Failed to send verification email. Please try again.'
      });
    }

    res.json({
      success: true,
      message: 'OTP resent successfully'
    });
  } catch (error) {
    console.error('Resend OTP error:', error);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ?
        `Error resending OTP: ${error.message}` :
        'Error resending OTP. Please try again later.'
    });
  }
});

// @route   POST /api/auth/register-admin
// @desc    Register a user (Admin only)
// @access  Private/Admin
router.post('/register-admin', protect, authorize('admin'), async (req, res) => {
  try {
    const { username, email, password, teamId, type, verified, hidden, banned } = req.body;

    // Validate input
    if (!username || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }

    let validatedUsername;
    let validatedEmail;
    let validatedPassword;

    try {
      validatedUsername = validateInput.username(username);
      validatedEmail = validateInput.email(email);
      validatedPassword = validateInput.password(password);
    } catch (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError.message
      });
    }

    // Check if user already exists
    const userExists = await User.findOne({
      $or: [{ email: validatedEmail }, { username: validatedUsername }]
    });

    if (userExists) {
      return res.status(400).json({
        success: false,
        message: userExists.email === validatedEmail ?
          'Email already registered' :
          'Username already taken'
      });
    }

    const userData = {
      username: validatedUsername,
      email: validatedEmail,
      password: validatedPassword,
      role: type === 'admin' ? 'admin' : 'user',
      verified: !!verified,
      isEmailVerified: !!verified,
      hidden: !!hidden,
      banned: !!banned,
      isBlocked: !!banned,
      blockedReason: banned ? 'Banned by admin' : null,
      blockedAt: banned ? new Date() : null
    };

    let user;
    if (teamId) {
      if (type === 'admin') {
        return res.status(400).json({ success: false, message: 'Admin accounts cannot join teams' });
      }
      const mongoose = require('mongoose');
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const team = await Team.findById(teamId).session(session);
          if (!team || team.banned || team.members.length >= 4) {
            throw new Error(!team ? 'Team not found' : team.banned ? 'This team is unavailable' : 'Team already has four members');
          }
          const [createdUser] = await User.create([userData], { session });
          const updatedTeam = await Team.findOneAndUpdate(
            {
              _id: team._id,
              $expr: { $lt: [{ $size: { $ifNull: ['$members', []] } }, 4] }
            },
            { $addToSet: { members: createdUser._id } },
            { new: true, session }
          );
          if (!updatedTeam) throw new Error('Team already has four members');
          createdUser.team = team._id;
          await createdUser.save({ session });
          await ensureCaptain(team._id, session);
          user = createdUser;
        });
      } finally {
        await session.endSession();
      }
    } else {
      user = await User.create(userData);
    }

    // Populate team if exists
    if (user.team) {
      await user.populate('team', '_id name');
    }

    // Generate token
    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        points: user.points,
        team: user.team ? {
          _id: user.team._id,
          name: user.team.name
        } : null
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ?
        `Error creating user: ${error.message}` :
        'Error creating user. Please try again later.'
    });
  }
});

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', sanitizeInput, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Enhanced input validation
    let validatedEmail;
    try {
      validatedEmail = enhancedValidation.email(email);
      logActivity('LOGIN_ATTEMPT', { email: validatedEmail, ip: req.ip, userAgent: req.get('User-Agent') });
    } catch (validationError) {
      logActivity('LOGIN_VALIDATION_FAILED', { email, error: validationError.message, ip: req.ip });
      return res.status(400).json({
        success: false,
        message: validationError.message
      });
    }

    // Limit password guessing: per email and address, and per account from anywhere.
    // Counted before checking so parallel guesses cannot slip past.
    const attempts = [await takeAttempt('login', `${validatedEmail}:${req.ip}`)];
    // A blocked address must not use up the account's allowance for everyone else
    if (attempts[0].allowed) attempts.push(await takeAttempt('loginAccount', validatedEmail));
    const blocked = attempts.find(attempt => !attempt.allowed);
    if (blocked) {
      return tooMany(res, blocked.retryAfter, 'Too many failed logins. Please wait a few minutes.');
    }

    // Check for user
    const user = await User.findOne({ email: validatedEmail }).select('+password');

    if (!user) {
      logActivity('LOGIN_FAILED', { email: validatedEmail, reason: 'User not found', ip: req.ip });
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check for account locking (Relaxed: 20 attempts, 5 min lock)
    if (user.isLocked()) {
      await createLoginLog(user, req, 'failed', 'Account locked');

      return res.status(429).json({
        success: false,
        message: 'Account is temporarily locked. Please try again later.',
        retryAfter: Math.ceil((user.lockUntil - Date.now()) / 1000)
      });
    }

    // Check if user is blocked by admin
    if (user.isBlocked) {
      await createLoginLog(user, req, 'failed', 'Account blocked by admin');

      return res.status(403).json({
        success: false,
        message: 'You are blocked. Suspicious activity detected. Contact Admin for further information.',
        isBlocked: true,
        blockedReason: user.blockedReason
      });
    }

    // Check if password matches
    const isMatch = await user.matchPassword(password);

    if (!isMatch) {
      // Log failed login attempt and increment counter (never the password)
      await user.incrementLoginAttempts();
      await createLoginLog(user, req, 'failed', 'Invalid password');
      logActivity('LOGIN_FAILED', { email: validatedEmail, reason: 'Invalid password', ip: req.ip });

      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Only failed logins count against the limits
    await Promise.all(attempts.map(attempt => attempt.release()));

    // Update last login time
    user.lastLoginAt = new Date();
    await user.save();

    // Log successful login and reset attempts
    console.log('[Debug] Resetting login attempts...');
    await user.resetLoginAttempts();
    console.log('[Debug] Creating login log...');
    await createLoginLog(user, req, 'success');



    // Populate team info
    console.log('[Debug] Populating team...');
    try {
      await user.populate('team');
      console.log('[Debug] Team populated:', user.team ? user.team._id : 'No team');
    } catch (popErr) {
      console.error('[Debug] Populate error:', popErr);
    }

    // NEW: Generate token pair (access + refresh)
    console.log('[Debug] Generating token pair...');
    const refreshTokenUtils = require('../utils/refreshToken');
    const clientIp = getRealIP(req);
    const userAgentParsed = parseUserAgent(req.get('User-Agent'));
    
    const tokens = await refreshTokenUtils.createTokenPair(
      user,
      clientIp,
      userAgentParsed
    );

    // Set access token cookie (short-lived, configurable via .env)
    const isProduction = process.env.NODE_ENV === 'production';
    
    // Calculate maxAge from JWT_ACCESS_EXPIRE
    const accessExpire = config.jwt.accessTokenExpiresIn || '15m';
    let accessMaxAge = 15 * 60 * 1000; // Default 15 minutes
    if (accessExpire.endsWith('m')) {
      accessMaxAge = parseInt(accessExpire) * 60 * 1000;
    } else if (accessExpire.endsWith('h')) {
      accessMaxAge = parseInt(accessExpire) * 60 * 60 * 1000;
    } else if (accessExpire.endsWith('d')) {
      accessMaxAge = parseInt(accessExpire) * 24 * 60 * 60 * 1000;
    }
    
    res.cookie('access_token', tokens.accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: accessMaxAge,
      path: '/'
    });

    // Set refresh token cookie (long-lived, configurable via .env)
    const refreshExpire = config.jwt.refreshTokenExpiresIn || '7d';
    let refreshMaxAge = 7 * 24 * 60 * 60 * 1000; // Default 7 days
    if (refreshExpire.endsWith('d')) {
      refreshMaxAge = parseInt(refreshExpire) * 24 * 60 * 60 * 1000;
    } else if (refreshExpire.endsWith('h')) {
      refreshMaxAge = parseInt(refreshExpire) * 60 * 60 * 1000;
    } else if (refreshExpire.endsWith('m')) {
      refreshMaxAge = parseInt(refreshExpire) * 60 * 1000;
    }
    
    res.cookie('refresh_token', tokens.refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: refreshMaxAge,
      path: '/'
    });

    // Legacy: Also set old 'token' cookie for backward compatibility
    res.cookie('token', tokens.accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: accessMaxAge,  // Match access token expiry from config
      path: '/'
    });

    console.log('[Debug] Token pair set in httpOnly cookies.');

    logActivity('LOGIN_SUCCESS', { 
      userId: user._id, 
      username: user.username, 
      ip: clientIp, 
      userAgent: userAgentParsed,
      tokenFamily: tokens.family
    });

    console.log('[Debug] Sending response...');

    // Ensure team is properly formatted
    let teamData = null;
    if (user.team) {
      console.log('[Debug] user.team type:', typeof user.team);
      console.log('[Debug] user.team:', user.team);
      
      teamData = {
        _id: user.team._id ? user.team._id.toString() : user.team.toString(),
        name: user.team.name || 'Team'
      };
      
      console.log('[Debug] Formatted teamData:', teamData);
    }

    const responseData = {
      success: true,
      // Token NOT sent in response body (httpOnly cookie only)
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        points: user.points,
        team: teamData
      }
    };

    console.log('[Debug] Sending login response with team:', responseData.user.team);

    res.json(responseData);
  } catch (error) {
    console.error('[Login Error]', error.message, error.stack);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ? error.message : 'Error logging in'
    });
  }
});

// @route   POST /api/auth/logout
// @desc    Logout user and clear token cookie (with refresh token revocation)
// @access  Private
router.post('/logout', protect, async (req, res) => {
  try {
    // NEW: Revoke refresh token if present
    const refreshToken = req.cookies.refresh_token;
    if (refreshToken) {
      const refreshTokenUtils = require('../utils/refreshToken');
      await refreshTokenUtils.revokeRefreshToken(refreshToken, 'user_logout');
    }
    
    // Clear both access and refresh token cookies
    clearTokenCookie(res);
    
    // Clear refresh token cookie
    res.cookie('refresh_token', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',  // Must match login setting
      maxAge: 0,        // Use maxAge: 0 for reliable clearing
      path: '/'
    });
    
    // Clear access_token cookie (if using new token structure)
    res.cookie('access_token', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
      path: '/'
    });
    
    logActivity('LOGOUT_SUCCESS', { 
      userId: req.user._id, 
      username: req.user.username 
    });

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      message: 'Error logging out'
    });
  }
});

// @route   POST /api/auth/refresh
// @desc    Refresh access token using refresh token
// @access  Public (requires refresh_token cookie)
router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = req.cookies.refresh_token;

    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token not found',
        code: 'NO_REFRESH_TOKEN'
      });
    }

    const refreshTokenUtils = require('../utils/refreshToken');
    const clientIp = getRealIP(req);
    const userAgent = parseUserAgent(req.get('User-Agent'));

    // Validate refresh token and detect reuse
    let dbToken;
    try {
      dbToken = await refreshTokenUtils.validateRefreshToken(refreshToken);
    } catch (error) {
      // Clear invalid token cookie
      res.cookie('refresh_token', '', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        expires: new Date(0),
        path: '/'
      });

      if (error.message === 'TOKEN_REUSE_DETECTED') {
        logActivity('SECURITY_ALERT_TOKEN_REUSE', {
          ip: clientIp,
          userAgent
        });

        return res.status(403).json({
          success: false,
          message: 'Security breach detected. All sessions have been revoked. Please login again.',
          code: 'TOKEN_REUSE_DETECTED'
        });
      }

      return res.status(401).json({
        success: false,
        message: 'Invalid or expired refresh token',
        code: error.message
      });
    }

    // Rotate refresh token (create new pair, mark old as replaced)
    const newTokens = await refreshTokenUtils.rotateRefreshToken(
      dbToken,
      clientIp,
      userAgent
    );

    // Set new access token cookie (short-lived, 15min)
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('access_token', newTokens.accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 15 * 60 * 1000, // 15 minutes
      path: '/'
    });

    // Set new refresh token cookie (long-lived, 7 days)
    res.cookie('refresh_token', newTokens.refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/'
    });

    logActivity('TOKEN_REFRESHED', {
      userId: dbToken.user._id,
      username: dbToken.user.username,
      oldTokenId: dbToken.tokenId,
      newTokenId: newTokens.tokenId
    });

    res.json({
      success: true,
      message: 'Token refreshed successfully',
      expiresAt: newTokens.expiresAt
    });

  } catch (error) {
    console.error('[Refresh Token Error]', error);
    res.status(500).json({
      success: false,
      message: 'Error refreshing token'
    });
  }
});

// @route   GET /api/auth/sessions
// @desc    Get user's active sessions
// @access  Private
router.get('/sessions', protect, async (req, res) => {
  try {
    const refreshTokenUtils = require('../utils/refreshToken');
    const sessions = await refreshTokenUtils.getUserSessions(req.user._id);

    res.json({
      success: true,
      count: sessions.length,
      data: sessions.map(session => ({
        id: session._id,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        isCurrentSession: req.cookies.refresh_token && 
          refreshTokenUtils.hashToken(req.cookies.refresh_token) === session.tokenHash
      }))
    });
  } catch (error) {
    console.error('[Sessions Error]', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching sessions'
    });
  }
});

// @route   DELETE /api/auth/sessions/:sessionId
// @desc    Revoke a specific session
// @access  Private
router.delete('/sessions/:sessionId', protect, async (req, res) => {
  try {
    const RefreshToken = require('../models/RefreshToken');
    const session = await RefreshToken.findOne({
      _id: req.params.sessionId,
      user: req.user._id
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    await session.revoke('user_action');

    logActivity('SESSION_REVOKED', {
      userId: req.user._id,
      username: req.user.username,
      sessionId: session._id
    });

    res.json({
      success: true,
      message: 'Session revoked successfully'
    });
  } catch (error) {
    console.error('[Session Revocation Error]', error);
    res.status(500).json({
      success: false,
      message: 'Error revoking session'
    });
  }
});

// @route   POST /api/auth/logout-all
// @desc    Logout from all devices (revoke all refresh tokens)
// @access  Private
router.post('/logout-all', protect, async (req, res) => {
  try {
    const refreshTokenUtils = require('../utils/refreshToken');
    const revokedCount = await refreshTokenUtils.revokeAllUserTokens(
      req.user._id,
      'user_logout_all'
    );

    // Clear cookies
    clearTokenCookie(res);
    res.cookie('refresh_token', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      expires: new Date(0),
      path: '/'
    });

    logActivity('LOGOUT_ALL_DEVICES', {
      userId: req.user._id,
      username: req.user.username,
      sessionsRevoked: revokedCount
    });

    res.json({
      success: true,
      message: `Logged out from ${revokedCount} device(s) successfully`
    });
  } catch (error) {
    console.error('[Logout All Error]', error);
    res.status(500).json({
      success: false,
      message: 'Error logging out from all devices'
    });
  }
});

// Password reset endpoints removed - use admin team management to change passwords

// @route   GET /api/auth/me
// @desc    Get current logged in user (optimized for 400+ concurrent users)
// @access  Private
router.get('/me', protect, async (req, res) => {
  // Prevent HTTP caching to avoid 304 responses
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });

  try {
    // Use lean() for faster queries and populate only needed fields
    const user = await User.findById(req.user._id)
      .populate('team', 'name')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.isBlocked) {
      return res.status(403).json({
        success: false,
        isBlocked: true,
        message: 'Your account has been blocked. Contact Admin for further information.',
        user: {
          id: user._id,
          username: user.username,
          email: user.email,
          isBlocked: user.isBlocked,
          blockedReason: user.blockedReason,
          blockedAt: user.blockedAt
        }
      });
    }

    const totalPoints = Math.max(0, await getUserRawScore(user._id));

    // Challenges closed to this player: their own solves and their current team's
    const solvedIds = await getSolvedChallengeIds(user._id, user.team?._id);
    const ownIds = await Submission.distinct('challenge', { user: user._id, isCorrect: true });
    const challengeDetails = await Challenge.find({ _id: { $in: [...solvedIds, ...ownIds] } })
      .select('title category points')
      .lean();
    const pick = ids => {
      const wanted = new Set(ids.map(String));
      return challengeDetails.filter(challenge => wanted.has(String(challenge._id)));
    };
    const solvedChallenges = pick(solvedIds);
    // The player's own solves; these add up to their points (with any awards)
    const ownSolves = pick(ownIds);

    // Place on the player scoreboard the user can see; null when not ranked
    let rank = null;
    if (allows((await getVisibility()).score, user)) {
      const freezeTime = user.role === 'admin' ? null : await getFreezeTime();
      const board = await loadScoreboard({ cutoff: freezeTime });
      rank = board.userStandings().find(row => row.account_id === String(user._id))?.pos || null;
    }

    const formattedHints = await listUnlockedHints({ user: user._id });

    // Format team data
    let teamData = null;
    if (user.team) {
      teamData = {
        _id: user.team._id ? user.team._id.toString() : user.team.toString(),
        name: user.team.name || 'Team'
      };
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        points: totalPoints,
        rank: rank,
        team: teamData,
        solvedChallenges,
        ownSolves,
        unlockedHints: formattedHints,
        isBlocked: user.isBlocked
      }
    });
  } catch (error) {
    console.error('Error in /api/auth/me:', error);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ? error.message : 'Error fetching user data'
    });
  }
});

// @route   GET /api/auth/users
// @desc    Get all users with pagination (admin only)
// @access  Private/Admin
router.get('/users', protect, authorize('admin'), async (req, res) => {
  try {
    const { all, search, q, field, view } = req.query;

    // Build search query
    let query = {};
    const searchValue = (search || q || '').toString().trim();
    const searchField = (field || '').toString().trim();

    if (searchValue) {
      // Sanitize regex input to prevent ReDoS attacks
      const sanitized = searchValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').substring(0, 50);
      const allowedFields = ['username', 'email', 'affiliation', 'country', 'website'];
      if (searchField && allowedFields.includes(searchField)) {
        query[searchField] = { $regex: sanitized, $options: 'i' };
      } else {
        query.$or = [
          { username: { $regex: sanitized, $options: 'i' } },
          { email: { $regex: sanitized, $options: 'i' } },
          { affiliation: { $regex: sanitized, $options: 'i' } },
          { country: { $regex: sanitized, $options: 'i' } }
        ];
      }
    }

    // CTFd-style: only include hidden/banned users for admin view
    if (view !== 'admin') {
      query.hidden = { $ne: true };
      query.banned = { $ne: true };
    }

    if (all === 'true') {
      // Return all users without pagination for team creation
      const users = await User.find(query)
        .select('-password')
        .populate('team', 'name')
        .sort({ username: 1 });

      return res.json({
        success: true,
        count: users.length,
        total: users.length,
        users
      });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const totalUsers = await User.countDocuments(query);
    const users = await User.find(query)
      .select('-password')
      .populate('team', 'name')
      .limit(limit)
      .skip(skip)
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: users.length,
      total: totalUsers,
      page,
      pages: Math.ceil(totalUsers / limit),
      users
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ? error.message : 'Error fetching users'
    });
  }
});

// @route   GET /api/auth/users/:id
// @desc    Get single user by ID (admin only or own profile)
// @access  Private/Admin
router.get('/users/:id', protect, async (req, res) => {
  try {
    // Allow users to view their own profile or admins to view any profile
    const isOwnProfile = req.user._id.toString() === req.params.id; // Fixed: added .toString()
    const isAdmin = req.user.role === 'admin';

    if (!isOwnProfile && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only view your own profile.'
      });
    }

    const user = await User.findById(req.params.id).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // CTFd-style visibility: hidden/banned users are admin-only unless self
    if (!isAdmin && !isOwnProfile && (user.hidden || user.banned)) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      user
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching user'
    });
  }
});

// @route   GET /api/auth/user/:id
// @desc    Get public user profile by ID
// @access  Private
router.get('/user/:id', protect, async (req, res) => {
  try {
    const viewer = await getViewer(req);
    const admin = isAdminViewer(viewer);
    const user = await User.findById(req.params.id)
      .select('username role team createdAt hidden banned isBlocked showInScoreboard')
      .populate('team', 'name');
    const self = Boolean(user) && String(viewer._id) === String(user._id);

    // Hidden and banned players are seen by admins and themselves
    if (!user || (!admin && !self && !isListedUser(user))) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const visibility = await getVisibility();
    if (!self && !allows(visibility.account, viewer)) {
      return res.status(403).json({ success: false, message: 'Profiles are hidden by the organisers' });
    }

    // Players see their own live score; others see it as of the freeze
    const freezeTime = admin ? null : await getFreezeTime();
    const cutoff = self ? null : freezeTime;
    const showScores = self || allows(visibility.score, viewer);

    const board = await loadScoreboard({ cutoff });
    const publicBoard = cutoff === freezeTime ? board : await loadScoreboard({ cutoff: freezeTime });
    const rank = allows(visibility.score, viewer)
      ? publicBoard.userStandings().find(row => row.account_id === String(user._id))?.pos || null
      : null;

    const entries = showScores ? board.userEntries(user._id) : [];
    const solves = entries.filter(entry => entry.challengeId).sort((a, b) => b.date - a.date);
    const details = await Challenge.find({ _id: { $in: solves.map(entry => entry.challengeId) } })
      .select('title category')
      .lean();
    const detailById = new Map(details.map(challenge => [String(challenge._id), challenge]));
    const solvedChallengesWithDetails = solves.map(entry => ({
      _id: entry.challengeId,
      title: detailById.get(entry.challengeId)?.title,
      category: detailById.get(entry.challengeId)?.category,
      points: entry.value,
      solvedAt: entry.date
    }));

    const unlockedHints = showScores
      ? (await listUnlockedHints({ user: user._id })).filter(hint => !cutoff || hint.unlockedAt < cutoff)
      : [];

    res.json({
      success: true,
      user: {
        _id: user._id,
        username: user.username,
        team: user.team,
        points: showScores ? Math.max(0, board.summarize(entries).score) : null,
        rank,
        scoresHidden: !showScores,
        solvedChallenges: solvedChallengesWithDetails,
        challengesSolvedCount: solvedChallengesWithDetails.length,
        unlockedHints
      }
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ? error.message : 'Error fetching user'
    });
  }
});

// REMOVED: Old broken reset endpoints
// New enterprise-grade reset endpoints available at /api/admin/reset/*
// See backend/routes/adminReset.js for implementation

// @route   PUT /api/auth/users/:id/role
// @desc    Change user role (Admin/User)
// @access  Private/Admin
router.put('/users/:id/role', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin can change user roles'
      });
    }

    const { newRole } = req.body;

    if (!newRole || !['admin', 'user'].includes(newRole)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid role. Must be "admin" or "user"'
      });
    }

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (isSuperadmin(user) && newRole !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'The superadmin account cannot be demoted'
      });
    }

    const oldRole = user.role;
    user.role = newRole;
    await user.save();
    await rescore();

    res.json({
      success: true,
      message: `User role changed from ${oldRole} to ${newRole}`,
      data: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Error changing user role:', error);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ?
        `Error changing role: ${error.message}` :
        'Error changing user role. Please try again.'
    });
  }
});

// @route   PATCH /api/auth/users/:id
// @desc    CTFd-style admin user management update
// @access  Private/Admin
router.patch('/users/:id', protect, authorize('admin'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const {
      username,
      email,
      password,
      type,
      role,
      verified,
      hidden,
      banned,
      canSubmitFlags,
      showInScoreboard
    } = req.body;

    if (isSuperadmin(user) && email !== undefined && (typeof email !== 'string' || email.toLowerCase() !== SUPERADMIN_EMAIL)) {
      return res.status(403).json({
        success: false,
        message: 'The superadmin account email cannot be changed'
      });
    }

    if (username !== undefined) user.username = username;
    if (email !== undefined) user.email = email;
    if (password !== undefined && password !== '') user.password = password;

    const nextRole = type !== undefined ? (type === 'admin' ? 'admin' : 'user') : role;
    if (nextRole !== undefined) {
      if (!['user', 'admin'].includes(nextRole)) {
        return res.status(400).json({ success: false, message: 'Invalid user type/role' });
      }
      if (isSuperadmin(user) && nextRole !== 'admin') {
        return res.status(403).json({
          success: false,
          message: 'The superadmin account cannot be demoted'
        });
      }
      user.role = nextRole;
    }

    if (verified !== undefined) {
      user.verified = !!verified;
      user.isEmailVerified = !!verified;
    }

    if (hidden !== undefined) {
      user.hidden = !!hidden;
      user.showInScoreboard = !hidden;
    }

    if (banned !== undefined) {
      // CTFd-style safety: admin cannot ban themselves
      const isSelf = req.user._id.toString() === user._id.toString();
      if (isSelf && !!banned) {
        return res.status(400).json({
          success: false,
          message: 'You cannot ban yourself'
        });
      }
      user.banned = !!banned;
      user.isBlocked = !!banned;
      user.blockedReason = banned ? 'Banned by admin' : null;
      user.blockedAt = banned ? new Date() : null;
      user.showInScoreboard = !banned && !user.hidden;
    }

    if (canSubmitFlags !== undefined) user.canSubmitFlags = !!canSubmitFlags;
    if (showInScoreboard !== undefined) user.showInScoreboard = !!showInScoreboard;

    await user.save();
    await rescore();

    return res.json({
      success: true,
      data: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        type: user.role === 'admin' ? 'admin' : 'user',
        verified: !!user.verified,
        hidden: !!user.hidden,
        banned: !!user.banned,
        isBlocked: !!user.isBlocked,
        canSubmitFlags: !!user.canSubmitFlags,
        showInScoreboard: !!user.showInScoreboard
      }
    });
  } catch (error) {
    console.error('Error patching user:', error);
    return res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ? error.message : 'Error updating user'
    });
  }
});

// @route   DELETE /api/auth/users/:id
// @desc    Delete a user (Admin only)
// @access  Private/Admin
router.delete('/users/:id', protect, authorize('admin'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (isSuperadmin(user)) {
      return res.status(403).json({
        success: false,
        message: 'The superadmin account cannot be deleted'
      });
    }

    const session = await require('mongoose').startSession();
    try {
      await session.withTransaction(async () => {
        await removeFromTeams(user._id, session);
        await User.deleteOne({ _id: user._id }, { session });
      });
    } finally {
      await session.endSession();
    }
    await rescore();

    res.json({
      success: true,
      message: 'User deleted successfully',
      data: {
        id: user._id,
        username: user.username,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ?
        `Error deleting user: ${error.message}` :
        'Error deleting user. Please try again.'
    });
  }
});

// @route   PUT /api/auth/users/:id/block
// @desc    Block or unblock a user (Admin only)
// @access  Private/Admin
router.put('/users/:id/block', protect, authorize('admin'), async (req, res) => {
  try {
    const { isBlocked, reason } = req.body;

    if (typeof isBlocked !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isBlocked must be a boolean'
      });
    }

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    user.isBlocked = isBlocked;
    user.banned = isBlocked;
    user.blockedReason = isBlocked ? reason || 'No reason provided' : null;
    user.blockedAt = isBlocked ? new Date() : null;
    user.showInScoreboard = !isBlocked && !user.hidden;
    await user.save();
    await rescore();

    res.json({
      success: true,
      message: `User ${isBlocked ? 'blocked' : 'unblocked'} successfully`,
      data: {
        id: user._id,
        username: user.username,
        email: user.email,
        isBlocked: user.isBlocked,
        blockedReason: user.blockedReason
      }
    });
  } catch (error) {
    console.error('Error blocking/unblocking user:', error);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ?
        `Error updating user block status: ${error.message}` :
        'Error updating user block status. Please try again.'
    });
  }
});

// @route   PUT /api/auth/users/:id/submission-permission
// @desc    Update user submission permission (Admin only)
// @access  Private/Admin
router.put('/users/:id/submission-permission', protect, authorize('admin'), async (req, res) => {
  try {
    const { canSubmitFlags } = req.body;

    if (typeof canSubmitFlags !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'canSubmitFlags must be a boolean'
      });
    }

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    user.canSubmitFlags = canSubmitFlags;
    await user.save();

    res.json({
      success: true,
      message: `User submission permission ${canSubmitFlags ? 'allowed' : 'blocked'}`,
      data: {
        id: user._id,
        username: user.username,
        email: user.email,
        canSubmitFlags: user.canSubmitFlags
      }
    });
  } catch (error) {
    console.error('Error updating submission permission:', error);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ?
        `Error updating submission permission: ${error.message}` :
        'Error updating submission permission. Please try again.'
    });
  }
});

// @route   PUT /api/auth/users/:id/scoreboard-visibility
// @desc    Update user scoreboard visibility (Admin only)
// @access  Private/Admin
router.put('/users/:id/scoreboard-visibility', protect, authorize('admin'), async (req, res) => {
  try {
    const { showInScoreboard } = req.body;

    if (typeof showInScoreboard !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'showInScoreboard must be a boolean'
      });
    }

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    user.showInScoreboard = showInScoreboard;
    await user.save();
    await rescore();

    res.json({
      success: true,
      message: `User ${showInScoreboard ? 'shown on' : 'hidden from'} scoreboard`,
      data: {
        id: user._id,
        username: user.username,
        email: user.email,
        showInScoreboard: user.showInScoreboard
      }
    });
  } catch (error) {
    console.error('Error updating scoreboard visibility:', error);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ?
        `Error updating scoreboard visibility: ${error.message}` :
        'Error updating scoreboard visibility. Please try again.'
    });
  }
});

// Platform Control routes removed - to be added back later

// @route   GET /api/auth/admin/login-logs
// @desc    Get login logs (Admin only)
// @access  Private/Admin
router.get('/admin/login-logs', protect, authorize('admin'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const { userId, status, search } = req.query;

    // Build query
    let query = {};
    if (userId) query.user = userId;
    if (status) query.status = status;
    if (search) {
      query.$or = [
        { email: { $regex: search, $options: 'i' } },
        { username: { $regex: search, $options: 'i' } }
      ];
    }

    const totalLogs = await LoginLog.countDocuments(query);
    const logs = await LoginLog.find(query)
      .populate('user', 'username email role')
      .sort({ loginTime: -1, createdAt: -1, _id: -1 })
      .limit(limit)
      .skip(skip);

    res.json({
      success: true,
      count: logs.length,
      total: totalLogs,
      page,
      pages: Math.ceil(totalLogs / limit),
      logs
    });
  } catch (error) {
    console.error('Error fetching login logs:', error);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ? error.message : 'Error fetching login logs'
    });
  }
});

// @route   GET /api/auth/admin/login-logs/:userId
// @desc    Get login logs for specific user (Admin only)
// @access  Private/Admin
router.get('/admin/login-logs/:userId', protect, authorize('admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const totalLogs = await LoginLog.countDocuments({ user: userId });
    const logs = await LoginLog.find({ user: userId })
      .populate('user', 'username email role')
      .sort({ loginTime: -1 })
      .limit(limit)
      .skip(skip);

    res.json({
      success: true,
      count: logs.length,
      total: totalLogs,
      page,
      pages: Math.ceil(totalLogs / limit),
      logs
    });
  } catch (error) {
    console.error('Error fetching user login logs:', error);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ? error.message : 'Error fetching user login logs'
    });
  }
});

// @route   DELETE /api/auth/admin/login-logs
// @desc    Clear all login logs (Admin only)
// @access  Private/Admin
router.delete('/admin/login-logs', protect, authorize('admin'), async (req, res) => {
  try {
    // Delete all login logs
    const result = await LoginLog.deleteMany({});

    res.json({
      success: true,
      message: `Deleted all ${result.deletedCount} login logs`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Error clearing login logs:', error);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ? error.message : 'Error clearing login logs'
    });
  }
});

// @route   PUT /api/auth/admin/change-password
// @desc    Change admin password (Admin only - can only change own password)
// @access  Private/Admin
router.put('/admin/change-password', protect, authorize('admin'), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // Validate input
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Please provide current password and new password'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters long'
      });
    }

    // Get current user with password
    const user = await User.findById(req.user._id).select('+password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Verify current password
    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Update password
    user.password = newPassword;
    user.passwordChangedAt = Date.now();
    await user.save();

    // NEW: Revoke all refresh tokens (force re-login on all devices)
    const refreshTokenUtils = require('../utils/refreshToken');
    const revokedCount = await refreshTokenUtils.revokeAllUserTokens(
      user._id,
      'password_changed'
    );

    // Clear Redis cache for this user
    const { getRedisClient } = require('../utils/redis');
    const redisClient = getRedisClient();
    await redisClient.del(`user:${user._id}`);

    logActivity('ADMIN_PASSWORD_CHANGED', { 
      userId: user._id, 
      username: user.username,
      sessionsRevoked: revokedCount
    });

    res.json({
      success: true,
      message: `Password changed successfully. ${revokedCount} session(s) revoked. You will need to login again.`
    });
  } catch (error) {
    console.error('Error changing admin password:', error);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'development' ?
        `Error changing password: ${error.message}` :
        'Error changing password. Please try again.'
    });
  }
});





module.exports = router;

