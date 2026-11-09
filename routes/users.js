import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import { authenticate } from '../middleware/auth.js';

const STORE_BASE_URL = process.env.STORE_API_URL || 'https://store.brahmakosh.com';
const ADMIN_ROLES = ['admin', 'super_admin'];
// Fields a client may never set through PUT /profile (privilege / balance / identity).
const PROTECTED_PROFILE_FIELDS = new Set([
  'role', 'karmaPoints', 'credits', 'isActive', 'loginApproved', 'clientId', 'email',
  'emailVerified', 'mobileVerified', 'authMethod', 'firebaseId', 'fcmTokens', '_id', '__v',
  'passwordResetToken', 'passwordResetExpires',
]);

const byEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
});

// 5 sync requests per user per hour (keyed by authenticated user, never by IP)
const byEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.BY_EMAIL_RATE_LIMIT || 5),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `by-email:${req.user?._id}`,
  validate: { keyGeneratorIpFallback: false },
  message: { success: false, message: 'Too many sync requests. Try again later.' },
});

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Get user profile
router.get('/profile', async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    res.json({
      success: true,
      data: { user }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Update user profile
router.put('/profile', async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    
    if (req.body.password) {
      user.password = req.body.password;
    }
    
    if (req.body.profile) {
      user.profile = { ...user.profile, ...req.body.profile };
    }
    
    if (req.body.clientInfo) {
      user.clientInfo = { ...user.clientInfo, ...req.body.clientInfo };
    }

    Object.keys(req.body).forEach(key => {
      if (key !== 'password' && key !== 'profile' && key !== 'clientInfo' && !PROTECTED_PROFILE_FIELDS.has(key)) {
        user[key] = req.body[key];
      }
    });

    await user.save();

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: { user }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Import/sync user from store.brahmakosh.com by email
// POST /api/users/by-email  { email }
router.post('/by-email', byEmailLimiter, async (req, res) => {
  try {
    const parsed = byEmailSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'A valid email (max 255 chars) is required' });
    }
    const email = parsed.data.email;

    // Ownership: users may only sync themselves; admins may sync anyone.
    const isAdmin = ADMIN_ROLES.includes(req.user.role);
    const ownEmail = String(req.user.email || '').toLowerCase();
    if (!isAdmin && ownEmail !== email) {
      return res.status(403).json({ success: false, message: 'You can only sync your own account' });
    }

    // Call external API
    let remoteResponse;
    try {
      remoteResponse = await axios.post(`${STORE_BASE_URL}/api/users/by-email`, { email }, { timeout: 10000 });
    } catch (err) {
      if (err.response) {
        return res.status(err.response.status).json({
          success: false,
          message: typeof err.response.data?.message === 'string' ? err.response.data.message : 'External sync failed'
        });
      }
      throw err;
    }

    const remoteData = remoteResponse.data;
    if (
      typeof remoteData?.message === 'string' &&
      remoteData.message.toLowerCase().includes('user not found')
    ) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const remoteUser = remoteData?.user || remoteData?.data?.user || remoteData?.data || null;
    if (!remoteUser || typeof remoteUser !== 'object') {
      return res.status(502).json({ success: false, message: 'Unexpected response from external service' });
    }

    // Whitelist: ONLY name, credits, karmaPoints are ever taken from the external source.
    const name = remoteUser.name || remoteUser.fullName || remoteUser.profile?.name;
    const safeRemote = {
      ...(typeof name === 'string' && name.trim() ? { name: name.trim().slice(0, 255) } : {}),
      ...(Number.isFinite(remoteUser.credits) && remoteUser.credits >= 0 ? { credits: remoteUser.credits } : {}),
      ...(Number.isFinite(remoteUser.karmaPoints) && remoteUser.karmaPoints >= 0 ? { karmaPoints: remoteUser.karmaPoints } : {}),
    };

    let user = await User.findOne({ email });
    if (!user) {
      // Never let a regular user create accounts through this endpoint.
      if (!isAdmin) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      user = new User({
        email,
        password: crypto.randomBytes(32).toString('hex'),
        profile: { name: safeRemote.name || email },
        credits: safeRemote.credits ?? 0,
        karmaPoints: safeRemote.karmaPoints ?? 0,
        loginApproved: true,
        isActive: true
      });
      await user.save();
      await AuditLog.create({
        action: 'user.balance_sync', actorId: req.user._id, actorRole: req.user.role,
        targetUserId: user._id, targetEmail: email, source: STORE_BASE_URL, ip: req.ip,
        changes: [
          { field: 'credits', oldValue: null, newValue: user.credits },
          { field: 'karmaPoints', oldValue: null, newValue: user.karmaPoints },
        ],
      });
    } else {
      const changes = [];
      if (safeRemote.name && safeRemote.name !== user.profile?.name) {
        changes.push({ field: 'profile.name', oldValue: user.profile?.name ?? null, newValue: safeRemote.name });
        user.profile = { ...(user.profile?.toObject?.() || user.profile || {}), name: safeRemote.name };
      }
      for (const field of ['credits', 'karmaPoints']) {
        if (safeRemote[field] !== undefined && safeRemote[field] !== user[field]) {
          changes.push({ field, oldValue: user[field], newValue: safeRemote[field] });
          user[field] = safeRemote[field];
        }
      }
      if (changes.length) {
        await user.save();
        if (changes.some((c) => c.field !== 'profile.name')) {
          await AuditLog.create({
            action: 'user.balance_sync', actorId: req.user._id, actorRole: req.user.role,
            targetUserId: user._id, targetEmail: email, source: STORE_BASE_URL, ip: req.ip, changes,
          });
        }
      }
    }

    const safeUser = await User.findById(user._id).select('-password');
    return res.json({
      success: true,
      source: 'store.brahmakosh.com',
      remote: { user: safeRemote },
      data: { user: safeUser }
    });
  } catch (error) {
    console.error('Error syncing user by email:', error);
    res.status(500).json({ success: false, message: 'Failed to sync user by email' });
  }
});

// Proxy: get full access token from store.brahmakosh.com by email
// POST /api/users/token-by-email  { email }
router.post('/token-by-email', async (req, res) => {
  try {
    const { email } = req.body || {};

    if (!email || typeof email !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Email is required',
      });
    }

    // Ownership: only the account owner or an admin may request a token for an email.
    if (
      !ADMIN_ROLES.includes(req.user.role) &&
      String(req.user.email || '').toLowerCase() !== email.trim().toLowerCase()
    ) {
      return res.status(403).json({ success: false, message: 'You can only request a token for your own account' });
    }

    let remoteResponse;
    try {
      remoteResponse = await axios.post(
        'https://store.brahmakosh.com/api/users/token-by-email',
        { email }
      );
    } catch (err) {
      if (err.response) {
        return res.status(err.response.status).json(err.response.data);
      }
      throw err;
    }

    // Just forward whatever store.brahmakosh.com returns (token or error)
    return res.status(remoteResponse.status || 200).json(remoteResponse.data);
  } catch (error) {
    console.error('Error getting token by email from store:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get token by email',
    });
  }
});

export default router;


