// src/routes/client.js - UPDATED VERSION
// Now supports user token authentication for all endpoints
// Numerology endpoints updated: name always from DB, date defaults to today

import express from 'express';
import mongoose from 'mongoose';
import { authenticate, authorize } from '../middleware/auth.js';
import User from '../models/User.js';
import Client from '../models/Client.js';
import Partner from '../models/Partner.js';
import Agent from '../models/Agent.js';
import Chat from '../models/Chat.js';
import VoiceConfig from '../models/voiceConfig.js';
import { getPresignedUrl } from '../utils/storage.js';
import Astrology from '../models/Astrology.js';
import Panchang from '../models/Panchang.js';
import Credit from '../models/Credit.js';
import KarmaPointsTransaction from '../models/KarmaPointsTransaction.js';
import AstrologyReport from '../models/AstrologyReport.js';
import astrologyService from '../services/astrologyService.js';
import panchangService from '../services/panchangService.js';
import numerologyService from '../services/numerologyService.js';
import doshaService from '../services/doshaService.js';
import remedyService from '../services/remedyService.js';
import { astrologyExternalService } from '../services/astrologyExternalService.js';
import { deductCredits } from '../services/creditLedger.js';
import axios from 'axios';

// Credit costs per report type (1 credit = 1 INR)
const REPORT_CREDIT_COSTS = {
  kundali_mini: 2,       // mini_horoscope_pdf = ₹1.5 → 2 credits
  kundali_basic: 8,      // basic_horoscope_pdf = ₹8
  kundali_pro: 60,       // pro_horoscope_pdf = ₹60
  match_making: 25,      // match_making_pdf = ₹25
};
import AppSettings from '../models/AppSettings.js';
import { bustStorageModeCache } from '../utils/storage.js';
import { uploadBuffer } from '../utils/storage.js';
import ConversationSession from '../models/ConversationSession.js';
import LiveAvatar from '../models/LiveAvatar.js';

const router = express.Router();

const getAstrologyToolsConfig = (clientDoc) => {
  const cfg = clientDoc?.settings?.astrologyTools || {};
  const pricing = cfg.pricing || {};
  return {
    enabled: Boolean(cfg.enabled),
    currency: cfg.currency || 'INR',
    pricing: {
      kundaliMini: Number(pricing.kundaliMini ?? 199),
      kundaliBasic: Number(pricing.kundaliBasic ?? 499),
      kundaliPro: Number(pricing.kundaliPro ?? 699),
      matchMaking: Number(pricing.matchMaking ?? 499)
    }
  };
};

/**
 * Helper function to get client ID based on user role
 */
const getClientIdForQuery = (user) => {
  if (user.role === 'client') {
    return user._id;
  }
  if (user.role === 'user') {
    // For users, get clientId from populated field or token
    return user.clientId?._id || user.clientId || user.tokenClientId;
  }
  // Admin and super_admin don't filter by clientId
  return null;
};

/**
 * Helper function to check if user has access to a specific user record
 */
const checkUserAccess = (requestingUser, targetUser) => {
  // Super admin and admin have access to all users
  if (requestingUser.role === 'super_admin' || requestingUser.role === 'admin') {
    return true;
  }

  // Client can only access their own users
  if (requestingUser.role === 'client') {
    const targetClientId = targetUser.clientId?._id?.toString() || targetUser.clientId?.toString();
    return targetClientId === requestingUser._id.toString();
  }

  // User can only access their own record
  if (requestingUser.role === 'user') {
    return targetUser._id.toString() === requestingUser._id.toString();
  }

  return false;
};

/**
 * GET  /api/client/settings/storage-mode
 * PUT  /api/client/settings/storage-mode
 */
router.get('/settings/storage-mode', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const settings = await AppSettings.getSettings();
    return res.json({ success: true, data: { storageMode: settings.storageMode || 's3_only' } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/settings/storage-mode', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { storageMode } = req.body;
    if (!['s3_only', 'r2_only', 'both'].includes(storageMode)) {
      return res.status(400).json({ success: false, message: 'Invalid storageMode. Use: s3_only | r2_only | both' });
    }
    const settings = await AppSettings.getSettings();
    settings.storageMode = storageMode;
    await settings.save();
    bustStorageModeCache();
    return res.json({ success: true, message: 'Storage mode updated', data: { storageMode: settings.storageMode } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/client/settings/r2-browser
 * List R2 bucket files with counts by type, pagination, presigned URLs
 */
router.get('/settings/r2-browser', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { prefix = '', limit = 50, cursor } = req.query;
    const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');

    const r2 = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY,
        secretAccessKey: process.env.R2_SECRET_KEY,
      },
    });

    const params = {
      Bucket: process.env.R2_BUCKET,
      MaxKeys: Math.min(parseInt(limit) || 50, 200),
      Prefix: prefix || undefined,
      ContinuationToken: cursor || undefined,
    };

    const result = await r2.send(new ListObjectsV2Command(params));
    const objects = result.Contents || [];

    const getFileType = (key) => {
      const ext = key.split('.').pop()?.toLowerCase();
      if (['jpg','jpeg','png','gif','webp','svg','bmp'].includes(ext)) return 'image';
      if (['mp4','webm','mov','avi','mkv'].includes(ext)) return 'video';
      if (['mp3','wav','ogg','m4a','aac','webm'].includes(ext)) return 'audio';
      if (['pdf'].includes(ext)) return 'pdf';
      return 'other';
    };

    // Generate presigned URLs for each file
    const files = await Promise.all(objects.map(async (obj) => {
      let url = null;
      try {
        const cmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: obj.Key });
        url = await getSignedUrl(r2, cmd, { expiresIn: 3600 });
      } catch (e) { /* ignore */ }
      return {
        key: obj.Key,
        size: obj.Size,
        lastModified: obj.LastModified,
        type: getFileType(obj.Key),
        url
      };
    }));

    // Count by type
    const counts = files.reduce((acc, f) => {
      acc[f.type] = (acc[f.type] || 0) + 1;
      acc.total = (acc.total || 0) + 1;
      return acc;
    }, {});

    return res.json({
      success: true,
      data: {
        files,
        counts,
        nextCursor: result.NextContinuationToken || null,
        isTruncated: result.IsTruncated || false,
        totalInPage: files.length
      }
    });
  } catch (error) {
    console.error('[R2 Browser]', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET  /api/client/settings/ccr-rates
 * PUT  /api/client/settings/ccr-rates
 */
router.get('/settings/ccr-rates', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const targetClientId = req.user.role === 'client' ? req.user._id : req.query.clientId;
    if (!targetClientId) return res.status(400).json({ success: false, message: 'clientId is required' });

    const client = await Client.findById(targetClientId).select('settings.chatCCR settings.voiceCCR').lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    return res.json({
      success: true,
      data: {
        chatCCR: client.settings?.chatCCR ?? 0.5,
        voiceCCR: client.settings?.voiceCCR ?? 0.5
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/settings/ccr-rates', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const targetClientId = req.user.role === 'client' ? req.user._id : req.body.clientId;
    if (!targetClientId) return res.status(400).json({ success: false, message: 'clientId is required' });

    const { chatCCR, voiceCCR } = req.body;
    const update = {};
    if (chatCCR !== undefined) {
      const v = Number(chatCCR);
      if (isNaN(v) || v < 0) return res.status(400).json({ success: false, message: 'chatCCR must be a non-negative number' });
      update['settings.chatCCR'] = v;
    }
    if (voiceCCR !== undefined) {
      const v = Number(voiceCCR);
      if (isNaN(v) || v < 0) return res.status(400).json({ success: false, message: 'voiceCCR must be a non-negative number' });
      update['settings.voiceCCR'] = v;
    }

    const client = await Client.findByIdAndUpdate(targetClientId, { $set: update }, { new: true })
      .select('settings.chatCCR settings.voiceCCR').lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    return res.json({
      success: true,
      message: 'CCR rates updated successfully',
      data: {
        chatCCR: client.settings?.chatCCR ?? 0.5,
        voiceCCR: client.settings?.voiceCCR ?? 0.5
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Client astrology tools settings
 * GET  /api/client/settings/astrology-tools
 * PUT  /api/client/settings/astrology-tools
 */
router.get('/settings/astrology-tools', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { clientId } = req.query;
    let targetClientId = null;

    if (req.user.role === 'client') {
      targetClientId = req.user._id;
    } else {
      targetClientId = clientId;
    }

    if (!targetClientId) {
      return res.status(400).json({ success: false, message: 'clientId is required' });
    }

    const client = await Client.findById(targetClientId).select('settings.astrologyTools').lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    return res.json({ success: true, data: getAstrologyToolsConfig(client) });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch astrology tools settings',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

router.put('/settings/astrology-tools', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { clientId, enabled, currency, pricing } = req.body || {};
    let targetClientId = null;

    if (req.user.role === 'client') {
      targetClientId = req.user._id;
    } else {
      targetClientId = clientId;
    }

    if (!targetClientId) {
      return res.status(400).json({ success: false, message: 'clientId is required' });
    }

    const update = {
      'settings.astrologyTools.enabled': Boolean(enabled),
      'settings.astrologyTools.currency': (currency || 'INR').toString().trim().toUpperCase(),
      'settings.astrologyTools.pricing.kundaliMini': Number(pricing?.kundaliMini ?? 199),
      'settings.astrologyTools.pricing.kundaliBasic': Number(pricing?.kundaliBasic ?? 499),
      'settings.astrologyTools.pricing.kundaliPro': Number(pricing?.kundaliPro ?? 699),
      'settings.astrologyTools.pricing.matchMaking': Number(pricing?.matchMaking ?? 499)
    };

    Object.keys(update).forEach((k) => {
      if (typeof update[k] === 'number' && (Number.isNaN(update[k]) || update[k] < 0)) {
        update[k] = 0;
      }
    });

    const client = await Client.findByIdAndUpdate(
      targetClientId,
      { $set: update },
      { new: true }
    ).select('settings.astrologyTools').lean();

    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    return res.json({ success: true, data: getAstrologyToolsConfig(client) });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update astrology tools settings',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Public config for user-facing screens (with auth/access control)
 * GET /api/client/users/:userId/astrology-tools/config
 */
router.get('/users/:userId/astrology-tools/config', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId).select('clientId').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to view settings for this user' });
    }

    const targetClientId = user.clientId?._id || user.clientId;
    const client = await Client.findById(targetClientId).select('settings.astrologyTools').lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    return res.json({ success: true, data: getAstrologyToolsConfig(client) });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch astrology config',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// TEMPORARY DEBUG ROUTE - remove after diagnosis
// GET /api/client/partners/debug
router.get('/partners/debug', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    // Get ALL partners for this client with NO filters
    const allPartners = await Partner.find({ 
      clientId: req.user._id 
    })
    .select('email name isActive isDeleted verificationStatus registrationStep createdAt')
    .lean();

    const summary = {
      total: allPartners.length,
      byIsDeleted: {
        false: allPartners.filter(p => p.isDeleted === false).length,
        true: allPartners.filter(p => p.isDeleted === true).length,
        missing: allPartners.filter(p => p.isDeleted === undefined || p.isDeleted === null).length,
      },
      byIsActive: {
        true: allPartners.filter(p => p.isActive === true).length,
        false: allPartners.filter(p => p.isActive === false).length,
      },
      byVerificationStatus: {
        pending: allPartners.filter(p => p.verificationStatus === 'pending').length,
        approved: allPartners.filter(p => p.verificationStatus === 'approved').length,
        rejected: allPartners.filter(p => p.verificationStatus === 'rejected').length,
        missing: allPartners.filter(p => !p.verificationStatus).length,
      },
      byRegistrationStep: allPartners.reduce((acc, p) => {
        const step = p.registrationStep ?? 'missing';
        acc[step] = (acc[step] || 0) + 1;
        return acc;
      }, {}),
      partners: allPartners.map(p => ({
        email: p.email,
        name: p.name,
        isActive: p.isActive,
        isDeleted: p.isDeleted,
        verificationStatus: p.verificationStatus,
        registrationStep: p.registrationStep,
      }))
    };

    res.json({ success: true, data: summary });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Get client's own users
 * GET /api/client/users
 * Query params: ?page=1&limit=25&search=query
 * Access: client, admin, super_admin, user (user can only see themselves)
 */
router.get('/users', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { search, page = 1, limit = 25 } = req.query;
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(limit) || 25, 1), 100);
    const skip = (pageNum - 1) * pageSize;

    let query = {};

    if (req.user.role === 'client') {
      query.clientId = req.user._id;
    } else if (req.user.role === 'user') {
      query._id = req.user._id;
    }

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      query.$or = [
        { email: regex },
        { 'profile.name': regex }
      ];
    }

    const [users, total] = await Promise.all([
      User.find(query)
        .select('-password -emailOtp -emailOtpExpiry -mobileOtp -mobileOtpExpiry')
        .populate('clientId', 'clientId businessName email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      User.countDocuments(query)
    ]);

    const usersWithKarma = users.map(user => ({
      ...user,
      karmaPoints: user.karmaPoints ?? 0
    }));

    res.json({
      success: true,
      data: {
        users: usersWithKarma,
        total,
        page: pageNum,
        limit: pageSize,
        hasMore: total > skip + usersWithKarma.length
      }
    });
  } catch (error) {
    console.error('[Client API] Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Create a new user under this client
 * POST /api/client/users
 * Access: client, admin, super_admin (users cannot create other users)
 */
router.post('/users', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { email, password, profile } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    console.log('[Client API] Creating user for client:', req.user._id.toString());

    const user = new User({
      email,
      password,
      profile: profile || {},
      clientId: req.user.role === 'client' ? req.user._id : req.body.clientId,
      credits: 1000, // signup bonus for client-created users
      emailVerified: true,
      loginApproved: true,
      registrationStep: 3
    });

    await user.save();
    console.log('[Client API] User created:', user._id.toString());

    const userResponse = await User.findById(user._id)
      .select('-password -emailOtp -emailOtpExpiry -mobileOtp -mobileOtpExpiry')
      .populate('clientId', 'clientId businessName email')
      .lean();

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: {
        user: userResponse
      }
    });
  } catch (error) {
    console.error('[Client API] Create user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create user',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Add credits to a user (for paid chat/features)
 * POST /api/client/users/:userId/credits
 * Body: { amount: number, description?: string }
 * Access: client (own users), admin, super_admin
 */
router.post('/users/:userId/credits', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, description } = req.body;

    const numericAmount = Number(amount);
    if (!numericAmount || Number.isNaN(numericAmount)) {
      return res.status(400).json({
        success: false,
        message: 'amount is required and must be a number'
      });
    }
    if (numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'amount must be greater than 0'
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Clients can only manage their own users
    if (req.user.role === 'client') {
      if (!user.clientId || user.clientId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'You can only add credits to your own users'
        });
      }
    }

    const previousBalance = user.credits || 0;
    const newBalance = previousBalance + numericAmount;

    user.credits = newBalance;
    await user.save();

    const tx = await Credit.create({
      userId: user._id,
      amount: numericAmount,
      previousBalance,
      newBalance,
      addedBy: req.user._id,
      addedByRole: req.user.role,
      description: description || `Credits added by ${req.user.role}`
    });

    res.status(201).json({
      success: true,
      message: 'Credits added successfully',
      data: {
        userId: user._id,
        previousBalance,
        newBalance,
        transaction: tx
      }
    });
  } catch (error) {
    console.error('[Client API] Add user credits error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add credits',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Add karma points to a user (bonus points)
 * POST /api/client/users/:userId/karma-points
 * Body: { amount: number, description?: string }
 * Access: client (own users), admin, super_admin
 */
router.post('/users/:userId/karma-points', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, description } = req.body;

    const numericAmount = Number(amount);
    if (!numericAmount || Number.isNaN(numericAmount)) {
      return res.status(400).json({
        success: false,
        message: 'amount is required and must be a number'
      });
    }
    if (numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'amount must be greater than 0'
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Clients can only manage their own users
    if (req.user.role === 'client') {
      if (!user.clientId || user.clientId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'You can only add karma points to your own users'
        });
      }
    }

    const previousBalance = user.karmaPoints || 0;
    const newBalance = previousBalance + numericAmount;

    user.karmaPoints = newBalance;
    await user.save();

    // Save transaction history
    const tx = await KarmaPointsTransaction.create({
      userId: user._id,
      amount: numericAmount,
      previousBalance,
      newBalance,
      addedBy: req.user._id,
      addedByModel: req.user.role === 'client' ? 'Client' : req.user.role === 'admin' || req.user.role === 'super_admin' ? 'Admin' : 'User',
      addedByRole: req.user.role,
      description: description || `Karma points bonus added by ${req.user.role}`
    });

    res.status(201).json({
      success: true,
      message: 'Karma points added successfully',
      data: {
        userId: user._id,
        previousBalance,
        newBalance,
        transaction: tx
      }
    });
  } catch (error) {
    console.error('[Client API] Add karma points error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add karma points',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Get karma points transaction history for a user
 * GET /api/client/users/:userId/karma-points/history
 * Access: client (own users), admin, super_admin, user (own history only)
 */
router.get('/users/:userId/karma-points/history', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check access permissions
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to view karma points history for this user'
      });
    }

    const transactions = await KarmaPointsTransaction.find({ userId })
      .populate('addedBy', 'email businessName profile')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      data: {
        transactions,
        currentBalance: user.karmaPoints || 0
      }
    });
  } catch (error) {
    console.error('[Client API] Get karma points history error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch karma points history',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ============================================
// PARTNERS - Pending approval & management
// ============================================

/**
 * List partners awaiting client approval (registered but not yet approved to login)
 * GET /api/client/partners/pending
 * Query: ?page=1&limit=25&search=query
 * Access: client (own partners), admin, super_admin
 */
router.get('/partners/pending', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { search, page = 1, limit = 25 } = req.query;
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(limit) || 25, 1), 100);
    const skip = (pageNum - 1) * pageSize;

    const query = {
      isDeleted: { $ne: true },
      verificationStatus: 'pending'   // ✅ Simple and consistent
    };

    if (req.user.role === 'client') {
      query.clientId = req.user._id;
    } else if (req.query.clientId) {
      const client = await Client.findOne({ clientId: String(req.query.clientId).toUpperCase() });
      if (client) query.clientId = client._id;
    }

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      query.$and = [
        ...(query.$and || []),
        { $or: [{ email: regex }, { name: regex }, { phone: regex }] }
      ];
    }

    const [partners, total] = await Promise.all([
      Partner.find(query)
        .select('-password -emailOtp -emailOtpExpiry -phoneOtp -phoneOtpExpiry')
        .populate('clientId', 'clientId businessName email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      Partner.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: {
        partners,
        total,
        page: pageNum,
        limit: pageSize,
        hasMore: total > skip + partners.length
      }
    });
  } catch (error) {
    console.error('[Client API] Get pending partners error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pending partners',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});
/**
 * Approve partner - allow them to login
 * POST /api/client/partners/:partnerId/approve
 * Access: client (own partners), admin, super_admin
 */
router.post('/partners/:partnerId/approve', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { partnerId } = req.params;

    const partner = await Partner.findById(partnerId);
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner not found'
      });
    }

    if (req.user.role === 'client') {
      if (!partner.clientId || partner.clientId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'You can only approve partners registered under your client account'
        });
      }
    }

    if (partner.isActive) {
      return res.status(400).json({
        success: false,
        message: 'Partner is already approved and can login'
      });
    }

    partner.isActive = true;
    partner.isVerified = true;
    partner.verificationStatus = 'approved';
    partner.verifiedAt = new Date();
    await partner.save();

    res.json({
      success: true,
      message: 'Partner approved successfully. They can now login.',
      data: {
        partner: {
          _id: partner._id,
          email: partner.email,
          name: partner.name,
          phone: partner.phone,
          isActive: partner.isActive
        }
      }
    });
  } catch (error) {
    console.error('[Client API] Approve partner error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to approve partner',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Reject partner (optional - keeps record but they cannot login)
 * POST /api/client/partners/:partnerId/reject
 * Access: client (own partners), admin, super_admin
 */
router.post('/partners/:partnerId/reject', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { partnerId } = req.params;
    const { reason } = req.body;

    const partner = await Partner.findById(partnerId);
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner not found'
      });
    }

    if (req.user.role === 'client') {
      if (!partner.clientId || partner.clientId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'You can only reject partners registered under your client account'
        });
      }
    }

    partner.isActive = false;
    partner.verificationStatus = 'rejected';
    if (reason) partner.blockedReason = reason;
    await partner.save();

    res.json({
      success: true,
      message: 'Partner registration rejected',
      data: {
        partner: {
          _id: partner._id,
          email: partner.email,
          name: partner.name
        }
      }
    });
  } catch (error) {
    console.error('[Client API] Reject partner error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject partner',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Soft delete a partner (hide from lists)
 * DELETE /api/client/partners/:partnerId
 * Access: client (own partners), admin, super_admin
 */
router.delete('/partners/:partnerId', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { partnerId } = req.params;

    const partner = await Partner.findById(partnerId);
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner not found'
      });
    }

    if (req.user.role === 'client') {
      if (!partner.clientId || partner.clientId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'You can only delete partners registered under your client account'
        });
      }
    }

    if (partner.isDeleted) {
      return res.status(400).json({
        success: false,
        message: 'Partner already deleted'
      });
    }

    partner.isActive = false;
    await partner.save();

    res.json({
      success: true,
      message: 'Partner deleted successfully',
      data: {
        partner: {
          _id: partner._id,
          email: partner.email,
          name: partner.name
        }
      }
    });
  } catch (error) {
    console.error('[Client API] Delete partner error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete partner',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * List all partners (approved and pending) for client
 * GET /api/client/partners
 * Query: ?page=1&limit=25&search=query&status=all|pending|approved|rejected
 * Access: client (own partners), admin, super_admin
 */
router.get('/partners', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { search, page = 1, limit = 25, status = 'all' } = req.query;
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(limit) || 25, 1), 100);
    const skip = (pageNum - 1) * pageSize;

    const query = {
      isDeleted: { $ne: true }
    };

    if (status === 'pending') {
      // ✅ Pending = verificationStatus is 'pending' (regardless of isActive)
      query.verificationStatus = 'pending';
    } else if (status === 'approved') {
      query.verificationStatus = 'approved';
      query.isActive = true;
    } else if (status === 'rejected') {
      query.verificationStatus = 'rejected';
    }

    if (req.user.role === 'client') {
      // Support both newer partners linked by clientId and older ones linked by clientCode
      query.$and = [
        ...(query.$and || []),
        {
          $or: [
            { clientId: req.user._id },
            { clientCode: req.user.clientId }
          ]
        }
      ];
    } else if (req.query.clientId) {
      const client = await Client.findOne({ clientId: req.query.clientId.toUpperCase() });
      if (client) query.clientId = client._id;
    }

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      query.$and = [
        ...(query.$and || []),
        { $or: [{ email: regex }, { name: regex }, { phone: regex }] }
      ];
    }

    const [partners, total] = await Promise.all([
      Partner.find(query)
        .select('-password -emailOtp -emailOtpExpiry -phoneOtp -phoneOtpExpiry')
        .populate('clientId', 'clientId businessName email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      Partner.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: {
        partners,
        total,
        page: pageNum,
        limit: pageSize,
        hasMore: total > skip + partners.length
      }
    });
  } catch (error) {
    console.error('[Client API] Get partners error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch partners',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Update a user
 * PUT /api/client/users/:userId
 * Access: client (own users), admin, super_admin, user (own profile only)
 */
router.put('/users/:userId', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { profile, isActive } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check access permissions
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to update this user'
      });
    }

    // Users can only update their own profile, not isActive status
    if (req.user.role === 'user') {
      if (isActive !== undefined) {
        return res.status(403).json({
          success: false,
          message: 'You cannot change your active status'
        });
      }
    }

    const birthFieldsChanged = profile && (
      profile.dob !== undefined || profile.timeOfBirth !== undefined ||
      profile.latitude !== undefined || profile.longitude !== undefined
    );

    if (profile) {
      user.profile = { ...user.profile, ...profile };
    }
    if (typeof isActive === 'boolean' && req.user.role !== 'user') {
      user.isActive = isActive;
    }

    await user.save();

    // Refresh astrology data when birth details are updated
    if (birthFieldsChanged) {
      const userWithLoc = await User.findById(userId).select('profile liveLocation').lean();
      const profileWithLocation = {
        ...userWithLoc?.profile,
        latitude: userWithLoc?.liveLocation?.latitude ?? userWithLoc?.profile?.latitude,
        longitude: userWithLoc?.liveLocation?.longitude ?? userWithLoc?.profile?.longitude
      };
      if (profileWithLocation.dob && profileWithLocation.timeOfBirth &&
          profileWithLocation.latitude != null && profileWithLocation.longitude != null) {
        astrologyService.refreshAstrologyData(userId, profileWithLocation)
          .then(() => console.log('[Client API] Astrology data refreshed after profile update'))
          .catch(err => console.warn('[Client API] Astrology refresh failed:', err.message));
      }
    }

    const updatedUser = await User.findById(userId)
      .select('-password -emailOtp -emailOtpExpiry -mobileOtp -mobileOtpExpiry')
      .populate('clientId', 'clientId businessName email')
      .lean();

    res.json({
      success: true,
      message: 'User updated successfully',
      data: {
        user: updatedUser
      }
    });
  } catch (error) {
    console.error('[Client API] Update user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Update user's live location
 * PUT /api/client/users/:userId/live-location
 * Body: { latitude: 19.076, longitude: 72.8777, formattedAddress: "...", city: "...", state: "...", country: "..." }
 * Access: client (own users), admin, super_admin, user (own location only)
 */
router.put('/users/:userId/live-location', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { latitude, longitude, formattedAddress, city, state, country } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check access permissions
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to update location for this user'
      });
    }

    // Validate coordinates
    if (latitude === null || latitude === undefined || longitude === null || longitude === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Both latitude and longitude are required'
      });
    }

    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);

    if (lat < -90 || lat > 90) {
      return res.status(400).json({
        success: false,
        message: 'Latitude must be between -90 and 90'
      });
    }

    if (lon < -180 || lon > 180) {
      return res.status(400).json({
        success: false,
        message: 'Longitude must be between -180 and 180'
      });
    }

    // Update live location
    user.liveLocation = {
      latitude: lat,
      longitude: lon,
      formattedAddress: formattedAddress || user.liveLocation?.formattedAddress,
      city: city || user.liveLocation?.city,
      state: state || user.liveLocation?.state,
      country: country || user.liveLocation?.country,
      lastUpdated: new Date()
    };

    await user.save();

    // Refresh astrology when live location changes (used for coords if profile has none)
    const userWithLoc = await User.findById(userId).select('profile liveLocation').lean();
    const profileWithLocation = {
      ...userWithLoc?.profile,
      latitude: userWithLoc?.liveLocation?.latitude ?? userWithLoc?.profile?.latitude,
      longitude: userWithLoc?.liveLocation?.longitude ?? userWithLoc?.profile?.longitude
    };
    if (profileWithLocation.dob && profileWithLocation.timeOfBirth &&
        profileWithLocation.latitude != null && profileWithLocation.longitude != null) {
      astrologyService.refreshAstrologyData(userId, profileWithLocation)
        .then(() => console.log('[Client API] Astrology data refreshed after live-location update'))
        .catch(err => console.warn('[Client API] Astrology refresh failed:', err.message));
    }

    const updatedUser = await User.findById(userId)
      .select('-password -emailOtp -emailOtpExpiry -mobileOtp -mobileOtpExpiry')
      .populate('clientId', 'clientId businessName email')
      .lean();

    res.json({
      success: true,
      message: 'Live location updated successfully',
      data: {
        user: updatedUser
      }
    });
  } catch (error) {
    console.error('[Client API] Update live location error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update live location',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Delete a user
 * DELETE /api/client/users/:userId
 * Access: client (own users), admin, super_admin (users cannot delete themselves)
 */
router.delete('/users/:userId', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (req.user.role === 'client') {
      if (!user.clientId || user.clientId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'You can only delete your own users'
        });
      }
    }

    // Delete associated astrology data
    await Astrology.findOneAndDelete({ userId });
    await Panchang.findOneAndDelete({ userId });
    
    await User.findByIdAndDelete(userId);
    console.log('[Client API] User deleted:', userId);

    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error('[Client API] Delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete user',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// FIX FOR: /api/client/users/:userId/complete-details endpoint
// Replace the existing endpoint in your client.js with this updated version

/**
 * Get user's complete details including astrology data
 * GET /api/client/users/:userId/complete-details
 * Query params: ?refresh=true to force refresh from API
 * Access: client (own users), admin, super_admin, user (own data only)
 */
router.get('/users/:userId/complete-details', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    const forceRefresh = req.query.refresh === 'true';

    console.log('[Client API] Fetching complete details for user:', userId, 'Refresh:', forceRefresh);

    const user = await User.findById(userId)
      .select('-password -emailOtp -emailOtpExpiry -mobileOtp -mobileOtpExpiry')
      .populate('clientId', 'clientId businessName email')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check access permissions
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to view this user'
      });
    }

    let astrologyData = null;
    let astrologyError = null;
    let doshaData = null;

    // FIXED: Check for required fields including liveLocation for coordinates
    const hasRequiredFields = user.profile?.dob && 
                             user.profile?.timeOfBirth && 
                             (user.liveLocation?.latitude !== null && user.liveLocation?.latitude !== undefined) &&
                             (user.liveLocation?.longitude !== null && user.liveLocation?.longitude !== undefined);

    if (hasRequiredFields) {
      try {
        console.log('[Client API] Fetching astrology data from service...');
        
        // FIXED: Merge liveLocation coordinates into profile for astrology calculation
        const profileWithLocation = {
          ...user.profile,
          latitude: user.liveLocation.latitude,
          longitude: user.liveLocation.longitude
        };
        
        astrologyData = await astrologyService.getCompleteAstrologyData(
          userId, 
          profileWithLocation, 
          forceRefresh
        );
        console.log('[Client API] Astrology data retrieved successfully');

        // Fetch doshas + dashas (cached)
        try {
          doshaData = await doshaService.getAllDoshas(user, { forceRefresh });
        } catch (doshaErr) {
          console.warn('[Client API] Could not fetch doshas/dashas for complete-details:', doshaErr.message);
        }
      } catch (error) {
        console.error('[Client API] Astrology generation error:', error);
        astrologyError = error.message;
      }
    } else {
      // Detailed error message
      const missing = [];
      if (!user.profile?.dob) missing.push('dob');
      if (!user.profile?.timeOfBirth) missing.push('timeOfBirth');
      if (user.liveLocation?.latitude === null || user.liveLocation?.latitude === undefined) missing.push('latitude (liveLocation)');
      if (user.liveLocation?.longitude === null || user.liveLocation?.longitude === undefined) missing.push('longitude (liveLocation)');
      
      astrologyError = `Incomplete birth details. Missing: ${missing.join(', ')}`;
    }

    res.json({
      success: true,
      data: {
        user,
        astrology: astrologyData,
        doshas: doshaData ? doshaData.doshas : undefined,
        dashas: doshaData ? doshaData.dashas : undefined,
        doshaSummary: doshaData ? doshaData.summary : undefined,
        astrologyError: astrologyError || undefined
      }
    });

  } catch (error) {
    console.error('[Client API] Get user complete details error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user details',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ALSO UPDATE: /api/client/users/:userId/astrology endpoint
router.get('/users/:userId/astrology', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    const forceRefresh = req.query.refresh === 'true';

    const user = await User.findById(userId)
      .select('profile clientId liveLocation') // ADDED: liveLocation
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check access permissions
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to view astrology data for this user'
      });
    }

    // FIXED: Check liveLocation for coordinates
    if (!user.profile?.dob || !user.profile?.timeOfBirth || 
        user.liveLocation?.latitude === null || user.liveLocation?.latitude === undefined ||
        user.liveLocation?.longitude === null || user.liveLocation?.longitude === undefined) {
      return res.status(400).json({
        success: false,
        message: 'User has incomplete birth details',
        missingFields: {
          dob: !user.profile?.dob,
          timeOfBirth: !user.profile?.timeOfBirth,
          latitude: user.liveLocation?.latitude === null || user.liveLocation?.latitude === undefined,
          longitude: user.liveLocation?.longitude === null || user.liveLocation?.longitude === undefined
        }
      });
    }

    // FIXED: Merge liveLocation coordinates into profile
    const profileWithLocation = {
      ...user.profile,
      latitude: user.liveLocation.latitude,
      longitude: user.liveLocation.longitude
    };

    const astrologyData = await astrologyService.getCompleteAstrologyData(
      userId, 
      profileWithLocation, 
      forceRefresh
    );

    // Fetch doshas (Kal Sarpa, Manglik, Pitra, Sade Sati, Shani, Gandmool)
    let doshas = null;
    try {
      console.log('[Client API] Fetching dosha data for astrology endpoint...');
      // Ensure user object has liveLocation for doshaService
      const userWithLocation = {
        ...user,
        liveLocation: user.liveLocation || {}
      };
      doshas = await doshaService.getAllDoshas(userWithLocation);
      console.log('[Client API] Dosha data retrieved successfully');
    } catch (doshaError) {
      console.warn('[Client API] Could not fetch doshas:', doshaError.message);
      // Don't fail the request if doshas fail, just log warning
    }

    res.json({
      success: true,
      data: {
        ...astrologyData,
        doshas: doshas || undefined
      }
    });

  } catch (error) {
    console.error('[Client API] Get astrology data error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch astrology data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ALSO UPDATE: /api/client/users/:userId/astrology/refresh endpoint
router.post('/users/:userId/astrology/refresh', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId)
      .select('profile clientId liveLocation') // ADDED: liveLocation
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check access permissions
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to refresh astrology data for this user'
      });
    }

    // FIXED: Merge liveLocation coordinates into profile
    const profileWithLocation = {
      ...user.profile,
      latitude: user.liveLocation?.latitude,
      longitude: user.liveLocation?.longitude
    };

    const astrologyData = await astrologyService.refreshAstrologyData(
      userId, 
      profileWithLocation
    );

    res.json({
      success: true,
      message: 'Astrology data refreshed successfully',
      data: astrologyData
    });

  } catch (error) {
    console.error('[Client API] Refresh astrology data error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to refresh astrology data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});
// ==========================================
// PANCHANG API ENDPOINTS - Add to client.js
// ==========================================

/**
 * GET panchang data by date from database
 * GET /api/client/users/:userId/panchang
 * Query params: 
 *   - date: YYYY-MM-DD format (optional, defaults to today) e.g., "2026-01-31"
 * Access: client (own users), admin, super_admin, user (own data only)
 * 
 * Location Logic:
 * 1. First checks if panchang exists in DB for the date
 * 2. If not found, tries to fetch using user's current liveLocation
 * 3. If user has no liveLocation, returns 404 with helpful message
 * 
 * Returns panchang data if exists, or auto-fetches using liveLocation if available
 * 
 * Examples:
 *   GET /api/client/users/:userId/panchang                     // Today's panchang
 *   GET /api/client/users/:userId/panchang?date=2026-01-31     // Specific date
 *   GET /api/client/users/:userId/panchang?date=2026-02-15     // Future date
 */
router.get('/users/:userId/panchang', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    let { date } = req.query;

    // Validate user and fetch live location + profile (for numero daily prediction)
    const user = await User.findById(userId)
      .select('clientId liveLocation profile')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check access permissions
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to view panchang data for this user'
      });
    }

    // If no date provided, use today
    if (!date) {
      const today = new Date();
      const year = today.getFullYear();
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const day = String(today.getDate()).padStart(2, '0');
      date = `${year}-${month}-${day}`;
      console.log('[Client API] No date provided, using today:', date);
    }

    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date format. Please use YYYY-MM-DD format (e.g., 2026-01-31)'
      });
    }

    // STEP 1: Check if panchang data exists in DB for this date
    const panchangData = await Panchang.findOne({
      userId,
      dateKey: date
    }).lean();

    if (panchangData) {
      console.log('[Client API] Panchang data found in DB for date:', date);
      
      // Daily nakshatra prediction is always for today (even when requesting another date)
      const todayKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
      let dailyNakshatraPrediction = panchangData.dailyNakshatraPrediction;
      if (date !== todayKey) {
        const todayPanchang = await Panchang.findOne({ userId, dateKey: todayKey }).select('dailyNakshatraPrediction').lean();
        if (todayPanchang?.dailyNakshatraPrediction) {
          dailyNakshatraPrediction = todayPanchang.dailyNakshatraPrediction;
        }
      }

      // Enrich with numero daily prediction (lucky number, prediction for the day)
      let numeroDailyPrediction = null;
      const userName = user.profile?.name || user.profile?.firstName;
      if (userName) {
        try {
          const numeroResult = await numerologyService.getDailyPredictionOnly(userId, date, userName, user.profile?.dob);
          numeroDailyPrediction = numeroResult.data; // lucky_number, prediction, etc.
        } catch (e) {
          console.warn('[Client API] Could not fetch numero daily prediction:', e.message);
        }
      }

      const formattedData = {
        dateKey: panchangData.dateKey,
        requestDate: panchangData.requestDate,
        location: panchangData.location,
        basicPanchang: panchangData.basicPanchang,
        advancedPanchang: panchangData.advancedPanchang,
        chaughadiyaMuhurta: panchangData.chaughadiyaMuhurta,
        dailyNakshatraPrediction,
        numeroDailyPrediction, // lucky_number, prediction for the day from numerology
        lastCalculated: panchangData.lastCalculated,
        calculationSource: panchangData.calculationSource
      };

      return res.json({
        success: true,
        source: 'database',
        data: formattedData
      });
    }

    // STEP 2: Panchang not found in DB - try to fetch using user's liveLocation
    console.log('[Client API] No panchang data found in DB for date:', date);
    
    // Check if user has live location
    const hasLocation = user.liveLocation?.latitude !== null && 
                       user.liveLocation?.latitude !== undefined &&
                       user.liveLocation?.longitude !== null && 
                       user.liveLocation?.longitude !== undefined;

    if (!hasLocation) {
      // No live location - cannot auto-fetch
      return res.status(404).json({
        success: false,
        message: `No panchang data found for date: ${date}`,
        reason: 'User has no live location stored',
        suggestion: 'Update user live location first, then the panchang will be automatically fetched',
        dateRequested: date,
        hasLocation: false
      });
    }

    // STEP 3: User has liveLocation - auto-fetch panchang data
    console.log('[Client API] Auto-fetching panchang using user liveLocation for date:', date);
    
    try {
      // Parse the date string to create proper date object
      const requestDate = new Date(date);
      
      if (isNaN(requestDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'Invalid date value provided'
        });
      }

      // Fetch panchang data using user's live location and birth profile for personalized nakshatra
      const fetchedPanchangData = await panchangService.getCompletePanchangData(
        userId,
        requestDate.toISOString(),
        user.liveLocation.latitude,
        user.liveLocation.longitude,
        false, // Don't force refresh
        user.profile || null
      );

      // Enrich with numero daily prediction (lucky number, prediction for the day)
      let numeroDailyPrediction;
      const userName = user.profile?.name || user.profile?.firstName;
      try {
        const numeroResult = await numerologyService.getDailyPredictionOnly(userId, date, userName || '', user.profile?.dob);
        numeroDailyPrediction = numeroResult.data;
      } catch (e) {
        console.warn('[Client API] Could not fetch numero daily prediction:', e.message);
        numeroDailyPrediction = { missingFields: ['name'], message: 'Name is required for personalized daily numerology prediction' };
      }

      // Daily nakshatra prediction is always for today
      const todayKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
      let dailyNakshatraPrediction = fetchedPanchangData.dailyNakshatraPrediction;
      if (date !== todayKey) {
        const todayPanchang = await Panchang.findOne({ userId, dateKey: todayKey }).select('dailyNakshatraPrediction').lean();
        if (todayPanchang?.dailyNakshatraPrediction) {
          dailyNakshatraPrediction = todayPanchang.dailyNakshatraPrediction;
        }
      }
      const enrichedData = { ...fetchedPanchangData, dailyNakshatraPrediction, numeroDailyPrediction };

      console.log('[Client API] Successfully auto-fetched and saved panchang for date:', date);

      return res.json({
        success: true,
        source: 'api',
        message: 'Panchang data fetched and saved automatically using user live location',
        autoFetched: true,
        data: enrichedData
      });

    } catch (fetchError) {
      console.error('[Client API] Auto-fetch panchang error:', fetchError);
      
      return res.status(500).json({
        success: false,
        message: 'Failed to auto-fetch panchang data',
        error: process.env.NODE_ENV === 'development' ? fetchError.message : undefined,
        suggestion: `You can try using POST /api/client/users/${userId}/panchang with date: ${date} to manually fetch`
      });
    }

  } catch (error) {
    console.error('[Client API] Get panchang by date error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch panchang data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * POST - Fetch and save panchang data for any date (current, past, or future)
 * POST /api/client/users/:userId/panchang
 * Body: { 
 *   date: "2026-01-31" or { day: 31, month: 1, year: 2026 }, 
 *   latitude: 28.5842 (optional),
 *   longitude: 77.3150 (optional)
 * }
 * Access: client (own users), admin, super_admin, user (own data only)
 * 
 * This endpoint:
 * 1. Fetches panchang data from API for the specified date
 * 2. Saves it to database
 * 3. Returns the panchang data
 * 4. Future GET requests for this date will return saved data
 * 
 * If date not provided, defaults to current date
 * If location not provided, uses user's liveLocation from DB
 * 
 * Examples:
 *   POST /api/client/users/:userId/panchang
 *   Body: { date: "2026-02-15" }  // Fetch and save for future date
 *   
 *   POST /api/client/users/:userId/panchang
 *   Body: { date: "2026-01-20" }  // Fetch and save for past date
 *   
 *   POST /api/client/users/:userId/panchang
 *   Body: {}  // Fetch and save for today
 */
router.post('/users/:userId/panchang', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    let { date, latitude, longitude } = req.body;

    // Validate user and fetch live location + profile (for numero daily prediction)
    const user = await User.findById(userId)
      .select('clientId liveLocation profile')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check access permissions
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to fetch panchang data for this user'
      });
    }

    // Process date - convert string format to object if needed
    let currentDate;
    if (!date) {
      // No date provided - use today
      currentDate = new Date();
      console.log('[Client API] No date provided, using today');
    } else if (typeof date === 'string') {
      // String format: "2026-01-31"
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(date)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid date format. Please use YYYY-MM-DD format (e.g., 2026-01-31) or object format { day, month, year }'
        });
      }
      currentDate = new Date(date);
      console.log('[Client API] Using provided date string:', date);
    } else if (typeof date === 'object' && date.day && date.month && date.year) {
      // Object format: { day: 31, month: 1, year: 2026 }
      currentDate = new Date(date.year, date.month - 1, date.day);
      console.log('[Client API] Using provided date object:', date);
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid date format. Provide either string "YYYY-MM-DD" or object { day, month, year }'
      });
    }

    // Validate that date is valid
    if (isNaN(currentDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date value provided'
      });
    }

    // Use live location from DB if not provided in request
    if (latitude === null || latitude === undefined) {
      if (user.liveLocation?.latitude !== null && user.liveLocation?.latitude !== undefined) {
        latitude = user.liveLocation.latitude;
        console.log('[Client API] Using user live location latitude:', latitude);
      } else {
        return res.status(400).json({
          success: false,
          message: 'Latitude not provided and user has no live location stored. Please update live location first.'
        });
      }
    }

    if (longitude === null || longitude === undefined) {
      if (user.liveLocation?.longitude !== null && user.liveLocation?.longitude !== undefined) {
        longitude = user.liveLocation.longitude;
        console.log('[Client API] Using user live location longitude:', longitude);
      } else {
        return res.status(400).json({
          success: false,
          message: 'Longitude not provided and user has no live location stored. Please update live location first.'
        });
      }
    }

    // Get date key for this request
    const dateKey = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;
    
    // Check if data already exists for this date
    const existingData = await Panchang.findOne({
      userId,
      dateKey
    });

    if (existingData) {
      console.log('[Client API] Panchang data already exists for date:', dateKey);
      
      // Daily nakshatra prediction is always for today
      const todayKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
      let dailyNakshatraPrediction = existingData.dailyNakshatraPrediction;
      if (dateKey !== todayKey) {
        const todayPanchang = await Panchang.findOne({ userId, dateKey: todayKey }).select('dailyNakshatraPrediction').lean();
        if (todayPanchang?.dailyNakshatraPrediction) {
          dailyNakshatraPrediction = todayPanchang.dailyNakshatraPrediction;
        }
      }

      // Enrich with numero daily prediction
      let numeroDailyPrediction;
      const userName = user.profile?.name || user.profile?.firstName;
      try {
        const numeroResult = await numerologyService.getDailyPredictionOnly(userId, dateKey, userName || '', user.profile?.dob);
        numeroDailyPrediction = numeroResult.data;
      } catch (e) {
        console.warn('[Client API] Could not fetch numero daily prediction:', e.message);
        numeroDailyPrediction = { missingFields: ['name'], message: 'Name is required for personalized daily numerology prediction' };
      }

      const formattedData = {
        dateKey: existingData.dateKey,
        requestDate: existingData.requestDate,
        location: existingData.location,
        basicPanchang: existingData.basicPanchang,
        advancedPanchang: existingData.advancedPanchang,
        chaughadiyaMuhurta: existingData.chaughadiyaMuhurta,
        dailyNakshatraPrediction,
        numeroDailyPrediction,
        lastCalculated: existingData.lastCalculated,
        calculationSource: existingData.calculationSource
      };

      return res.json({
        success: true,
        message: 'Panchang data already exists in database for this date',
        source: 'database',
        dateRequested: dateKey,
        data: formattedData
      });
    }

    // Data doesn't exist - fetch from API and save
    console.log('[Client API] Fetching new panchang data from API for date:', dateKey);
    
    // Fetch panchang data from service (pass user.profile for personalized nakshatra)
    const panchangData = await panchangService.getCompletePanchangData(
      userId,
      currentDate.toISOString(),
      latitude,
      longitude,
      false, // Don't force refresh, let service handle caching
      user.profile || null
    );

    // Daily nakshatra prediction is always for today
    const todayKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
    let dailyNakshatraPrediction = panchangData.dailyNakshatraPrediction;
    if (dateKey !== todayKey) {
      const todayPanchang = await Panchang.findOne({ userId, dateKey: todayKey }).select('dailyNakshatraPrediction').lean();
      if (todayPanchang?.dailyNakshatraPrediction) {
        dailyNakshatraPrediction = todayPanchang.dailyNakshatraPrediction;
      }
    }

    // Enrich with numero daily prediction
    let numeroDailyPrediction;
    const userName = user.profile?.name || user.profile?.firstName;
    try {
      const numeroResult = await numerologyService.getDailyPredictionOnly(userId, dateKey, userName || '', user.profile?.dob);
      numeroDailyPrediction = numeroResult.data;
    } catch (e) {
      console.warn('[Client API] Could not fetch numero daily prediction:', e.message);
      numeroDailyPrediction = { missingFields: ['name'], message: 'Name is required for personalized daily numerology prediction' };
    }

    res.json({
      success: true,
      message: 'Panchang data fetched and saved successfully',
      source: 'api',
      dateRequested: dateKey,
      data: { ...panchangData, dailyNakshatraPrediction, numeroDailyPrediction }
    });

  } catch (error) {
    console.error('[Client API] Fetch panchang data error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch panchang data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});




/**
 * Get list of dates for which panchang data exists
 * GET /api/client/users/:userId/panchang/list
 * Query params: ?limit=30&skip=0
 * Access: client (own users), admin, super_admin, user (own data only)
 */
router.get('/users/:userId/panchang/list', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 30, 90);
    const skip = parseInt(req.query.skip) || 0;

    const user = await User.findById(userId).select('clientId').lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({ success: false, message: 'You do not have permission' });
    }

    const records = await Panchang.find({ userId })
      .select('dateKey requestDate lastCalculated')
      .sort({ dateKey: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Panchang.countDocuments({ userId });

    res.json({
      success: true,
      data: records.map(r => ({ dateKey: r.dateKey, requestDate: r.requestDate, lastCalculated: r.lastCalculated })),
      count: records.length,
      total,
      hasMore: total > skip + limit
    });
  } catch (error) {
    console.error('[Client API] Get panchang list error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch panchang list', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
});

router.get('/users/:userId/panchang/batch', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { startDate, endDate, limit = 30 } = req.query;

    // Validate user
    const user = await User.findById(userId)
      .select('clientId')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check access permissions
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to view panchang data for this user'
      });
    }

    // Validate required params
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'Both startDate and endDate are required (YYYY-MM-DD format)'
      });
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date format. Please use YYYY-MM-DD format'
      });
    }

    // Validate limit
    const maxLimit = Math.min(parseInt(limit), 90);

    // Parse dates
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date values provided'
      });
    }

    if (start > end) {
      return res.status(400).json({
        success: false,
        message: 'startDate must be before or equal to endDate'
      });
    }

    // Fetch panchang data for date range
    const panchangRecords = await Panchang.find({
      userId,
      dateKey: {
        $gte: startDate,
        $lte: endDate
      }
    })
    .sort({ dateKey: 1 })
    .limit(maxLimit)
    .lean();

    console.log('[Client API] Found', panchangRecords.length, 'panchang records for date range:', startDate, 'to', endDate);

    // Format response
    const formattedRecords = panchangRecords.map(record => ({
      dateKey: record.dateKey,
      requestDate: record.requestDate,
      location: record.location,
      basicPanchang: record.basicPanchang,
      advancedPanchang: record.advancedPanchang,
      chaughadiyaMuhurta: record.chaughadiyaMuhurta,
      dailyNakshatraPrediction: record.dailyNakshatraPrediction,
      lastCalculated: record.lastCalculated,
      calculationSource: record.calculationSource
    }));

    res.json({
      success: true,
      count: formattedRecords.length,
      dateRange: {
        start: startDate,
        end: endDate
      },
      data: formattedRecords
    });

  } catch (error) {
    console.error('[Client API] Get batch panchang data error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch panchang data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});
/**
 * DELETE panchang data for a specific date
 * DELETE /api/client/users/:userId/panchang
 * Body: { date: "2026-01-31" }
 * Access: client (own users), admin, super_admin (users cannot delete)
 * 
 * Deletes panchang data for the specified date
 */
router.delete('/users/:userId/panchang', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { date } = req.body;

    const user = await User.findById(userId)
      .select('clientId')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check permissions for clients
    if (req.user.role === 'client') {
      if (!user.clientId || user.clientId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'You can only delete panchang data for your own users'
        });
      }
    }

    if (!date) {
      return res.status(400).json({
        success: false,
        message: 'date is required in request body (YYYY-MM-DD format)'
      });
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date format. Please use YYYY-MM-DD format'
      });
    }

    const result = await Panchang.findOneAndDelete({
      userId,
      dateKey: date
    });

    if (!result) {
      return res.status(404).json({
        success: false,
        message: `No panchang data found for date: ${date}`
      });
    }

    console.log('[Client API] Deleted panchang data for user:', userId, 'date:', date);

    res.json({
      success: true,
      message: 'Panchang data deleted successfully',
      dateDeleted: date
    });

  } catch (error) {
    console.error('[Client API] Delete panchang data error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete panchang data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Refresh panchang data for a user (force recalculation)
 * POST /api/client/users/:userId/panchang/refresh
 * Body: { currentDate: "2026-01-24T10:30:00Z", latitude: 19.076, longitude: 72.8777 } (all optional)
 * Access: client (own users), admin, super_admin, user (own data only)
 * Note: currentDate defaults to now, location defaults to user's liveLocation from DB
 */
router.post('/users/:userId/panchang/refresh', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    let { currentDate, latitude, longitude } = req.body;

    const user = await User.findById(userId)
      .select('clientId liveLocation profile')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check access permissions
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to refresh panchang data for this user'
      });
    }

    // Use current date/time if not provided
    if (!currentDate) {
      currentDate = new Date().toISOString();
      console.log('[Client API] No currentDate provided for refresh, using now:', currentDate);
    }

    // Use live location from DB if not provided in request
    if (latitude === null || latitude === undefined) {
      if (user.liveLocation?.latitude !== null && user.liveLocation?.latitude !== undefined) {
        latitude = user.liveLocation.latitude;
        console.log('[Client API] Using user live location latitude for refresh:', latitude);
      } else {
        return res.status(400).json({
          success: false,
          message: 'Latitude not provided and user has no live location stored'
        });
      }
    }

    if (longitude === null || longitude === undefined) {
      if (user.liveLocation?.longitude !== null && user.liveLocation?.longitude !== undefined) {
        longitude = user.liveLocation.longitude;
        console.log('[Client API] Using user live location longitude for refresh:', longitude);
      } else {
        return res.status(400).json({
          success: false,
          message: 'Longitude not provided and user has no live location stored'
        });
      }
    }

    const panchangData = await panchangService.refreshPanchangData(userId, currentDate, latitude, longitude, user.profile || null);

    res.json({
      success: true,
      message: 'Panchang data refreshed successfully',
      data: panchangData
    });

  } catch (error) {
    console.error('[Client API] Refresh panchang data error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to refresh panchang data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ==========================================
// HOROSCOPE + REPORTS (AstrologyAPI JSON/PDF)
// ==========================================

const parseTimeOfBirthToHourMin = (timeOfBirthRaw) => {
  const timeOfBirth = (timeOfBirthRaw || '').toString().trim();
  if (!timeOfBirth) return null;

  // "4:45 AM" / "11:30 PM"
  const ampm = timeOfBirth.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (ampm) {
    let hour = parseInt(ampm[1], 10);
    const min = parseInt(ampm[2], 10);
    const period = String(ampm[4]).toUpperCase();
    if (period === 'PM' && hour !== 12) hour += 12;
    if (period === 'AM' && hour === 12) hour = 0;
    return { hour, minute: min };
  }

  // "16:30" / "16:30:00"
  const h24 = timeOfBirth.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (h24) {
    return { hour: parseInt(h24[1], 10), minute: parseInt(h24[2], 10) };
  }

  return null;
};

/**
 * POST /api/client/users/:userId/horoscope/daily/:sign
 * Body: { timezone?: number } (optional, defaults 5.5)
 */
router.post('/users/:userId/horoscope/daily/:sign', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId, sign } = req.params;
    const timezone = req.body?.timezone ?? 5.5;

    const user = await User.findById(userId).select('clientId').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!checkUserAccess(req.user, user)) return res.status(403).json({ success: false, message: 'You do not have permission to access horoscope for this user' });
    const client = await Client.findById(user.clientId?._id || user.clientId).select('settings.astrologyTools').lean();
    const cfg = getAstrologyToolsConfig(client);
    if (!cfg.enabled) {
      return res.status(403).json({ success: false, message: 'Astrology tools are disabled by client settings' });
    }

    const data = await astrologyExternalService.getDailyHoroscope(sign, { timezone });
    return res.json({ success: true, data });
  } catch (error) {
    const status = error.status || error.response?.status || 500;
    return res.status(status).json({
      success: false,
      message: error.message || 'Failed to fetch daily horoscope',
      error: process.env.NODE_ENV === 'development' ? (error.response?.data || error.message) : undefined
    });
  }
});

/**
 * POST /api/client/users/:userId/horoscope/monthly/:sign
 * Body: { timezone?: number } (optional, defaults 5.5)
 */
router.post('/users/:userId/horoscope/monthly/:sign', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId, sign } = req.params;
    const timezone = req.body?.timezone ?? 5.5;

    const user = await User.findById(userId).select('clientId').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!checkUserAccess(req.user, user)) return res.status(403).json({ success: false, message: 'You do not have permission to access horoscope for this user' });
    const client = await Client.findById(user.clientId?._id || user.clientId).select('settings.astrologyTools').lean();
    const cfg = getAstrologyToolsConfig(client);
    if (!cfg.enabled) {
      return res.status(403).json({ success: false, message: 'Astrology tools are disabled by client settings' });
    }

    const data = await astrologyExternalService.getMonthlyHoroscope(sign, { timezone });
    return res.json({ success: true, data });
  } catch (error) {
    const status = error.status || error.response?.status || 500;
    return res.status(status).json({
      success: false,
      message: error.message || 'Failed to fetch monthly horoscope',
      error: process.env.NODE_ENV === 'development' ? (error.response?.data || error.message) : undefined
    });
  }
});

/**
 * POST /api/client/users/:userId/reports/kundali/:reportType
 * reportType: mini | basic | pro
 *
 * Body (optional overrides):
 * {
 *   language?: "en" | "hi",
 *   footer_link?: string,
 *   logo_url?: string,
 *   company_name?: string,
 *   company_info?: string,
 *   domain_url?: string,
 *   company_email?: string,
 *   company_landline?: string,
 *   company_mobile?: string
 * }
 *
 * Birth details are taken from DB user.profile (+ liveLocation when available).
 */
router.post('/users/:userId/reports/kundali/:reportType', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId, reportType } = req.params;
    const rt = String(reportType || '').toLowerCase();
    if (!['mini', 'basic', 'pro'].includes(rt)) {
      return res.status(400).json({ success: false, message: 'Invalid reportType. Use mini | basic | pro' });
    }

    const user = await User.findById(userId).select('clientId profile liveLocation').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!checkUserAccess(req.user, user)) return res.status(403).json({ success: false, message: 'You do not have permission to generate reports for this user' });
    const client = await Client.findById(user.clientId?._id || user.clientId).select('settings.astrologyTools').lean();
    const cfg = getAstrologyToolsConfig(client);
    if (!cfg.enabled) {
      return res.status(403).json({ success: false, message: 'Astrology tools are disabled by client settings' });
    }

    const dob = user.profile?.dob ? new Date(user.profile.dob) : null;
    const tob = parseTimeOfBirthToHourMin(user.profile?.timeOfBirth);
    const lat = user.liveLocation?.latitude ?? user.profile?.latitude;
    const lon = user.liveLocation?.longitude ?? user.profile?.longitude;
    const place = user.profile?.placeOfBirth || user.profile?.city || user.profile?.address || '';

    const missing = [];
    if (!user.profile?.name && !user.profile?.firstName) missing.push('name');
    if (!dob || isNaN(dob.getTime())) missing.push('dob');
    if (!tob) missing.push('timeOfBirth');
    if (lat == null || lon == null) missing.push('latitude/longitude');
    if (!place) missing.push('placeOfBirth');

    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: 'User profile is missing required fields for PDF generation',
        missingFields: missing
      });
    }

    const payload = {
      name: user.profile?.name || user.profile?.firstName,
      day: dob.getDate(),
      month: dob.getMonth() + 1,
      year: dob.getFullYear(),
      hour: tob.hour,
      minute: tob.minute,
      latitude: Number(lat),
      longitude: Number(lon),
      timezone: Number(req.body?.timezone ?? 5.5),
      place,
      language: req.body?.language || 'en',
      report_type: rt,

      footer_link: req.body?.footer_link || process.env.ASTROLOGY_PDF_FOOTER_LINK || '',
      logo_url: req.body?.logo_url || process.env.ASTROLOGY_PDF_LOGO_URL || '',
      company_name: req.body?.company_name || process.env.ASTROLOGY_PDF_COMPANY_NAME || 'Brahmakosh',
      company_info: req.body?.company_info || process.env.ASTROLOGY_PDF_COMPANY_INFO || '',
      domain_url: req.body?.domain_url || process.env.ASTROLOGY_PDF_DOMAIN_URL || '',
      company_email: req.body?.company_email || process.env.ASTROLOGY_PDF_COMPANY_EMAIL || '',
      company_landline: req.body?.company_landline || process.env.ASTROLOGY_PDF_COMPANY_LANDLINE || '',
      company_mobile: req.body?.company_mobile || process.env.ASTROLOGY_PDF_COMPANY_MOBILE || ''
    };

    // Deduct credits before generating report
    const creditCost = REPORT_CREDIT_COSTS[`kundali_${rt}`];
    const deduction = await deductCredits({
      userId,
      amount: creditCost,
      description: `Kundali ${rt} PDF report generation`,
      reportType: `kundali_${rt}`,
    });

    // 1) Call AstrologyAPI PDF endpoint
    const data = await astrologyExternalService.generateKundaliPdf(payload);
    const providerPdfUrl = data?.pdf_url || data?.url || null;

    if (!providerPdfUrl) {
      return res.status(502).json({
        success: false,
        message: 'Astrology PDF API did not return pdf_url',
        providerResponse: process.env.NODE_ENV === 'development' ? data : undefined
      });
    }

    // 2) Download PDF as buffer
    const pdfResponse = await axios.get(providerPdfUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(pdfResponse.data);

    // 3) Upload to storage (R2/S3/both based on settings)
    const s3Folder = 'astrology-reports';
    const filename = `${userId}_${rt}_${Date.now()}.pdf`;
    const uploadResult = await uploadBuffer(buffer, `${s3Folder}/${filename}`, 'application/pdf');

    // 4) Save history record
    const reportDoc = await AstrologyReport.create({
      userId,
      reportType: rt,
      category: 'kundali',
      provider: 'astrologyapi',
      providerPdfUrl,
      s3Key: uploadResult.key,
      s3Url: uploadResult.url,
      language: payload.language,
      place,
      meta: {
        timezone: payload.timezone,
        birth: {
          day: payload.day,
          month: payload.month,
          year: payload.year,
          hour: payload.hour,
          minute: payload.minute,
          latitude: payload.latitude,
          longitude: payload.longitude
        }
      }
    });

    return res.json({
      success: true,
      reportType: rt,
      creditsDeducted: creditCost,
      walletBalance: deduction.newBalance,
      providerResponse: data,
      s3: {
        key: uploadResult.key,
        url: uploadResult.url
      },
      history: reportDoc
    });
  } catch (error) {
    const status = error.status || error.response?.status || 500;
    if (error.code === 'INSUFFICIENT_CREDITS') {
      return res.status(402).json({
        success: false,
        message: error.message,
        code: 'INSUFFICIENT_CREDITS',
        required: error.required,
        available: error.available
      });
    }
    return res.status(status).json({
      success: false,
      message: error.message || 'Failed to generate kundali PDF',
      error: process.env.NODE_ENV === 'development' ? (error.response?.data || error.message) : undefined
    });
  }
});

/**
 * GET /api/client/users/:userId/reports/kundali/history
 * Query: page, limit
 */
router.get('/users/:userId/reports/kundali/history', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);

    const user = await User.findById(userId).select('clientId').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to view report history for this user' });
    }
    const client = await Client.findById(user.clientId?._id || user.clientId).select('settings.astrologyTools').lean();
    const cfg = getAstrologyToolsConfig(client);
    if (!cfg.enabled) {
      return res.status(403).json({ success: false, message: 'Astrology tools are disabled by client settings' });
    }

    const query = { userId, category: 'kundali' };
    const [items, total] = await Promise.all([
      AstrologyReport.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AstrologyReport.countDocuments(query)
    ]);

    return res.json({
      success: true,
      page,
      limit,
      total,
      items
    });
  } catch (error) {
    console.error('[Client API] Get kundali report history error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch kundali report history',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /api/client/users/:userId/reports/kundali/:reportId/download
 * Returns a signed S3 URL for downloading the PDF.
 */
router.get('/users/:userId/reports/kundali/:reportId/download', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId, reportId } = req.params;

    const report = await AstrologyReport.findById(reportId).lean();
    if (!report || String(report.userId) !== String(userId)) {
      return res.status(404).json({ success: false, message: 'Report not found' });
    }

    const user = await User.findById(userId).select('clientId').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to download this report' });
    }
    const client = await Client.findById(user.clientId?._id || user.clientId).select('settings.astrologyTools').lean();
    const cfg = getAstrologyToolsConfig(client);
    if (!cfg.enabled) {
      return res.status(403).json({ success: false, message: 'Astrology tools are disabled by client settings' });
    }

    const signedUrl = await getPresignedUrl(report.s3Key, 600); // 10 minutes
    return res.json({ success: true, url: signedUrl });
  } catch (error) {
    console.error('[Client API] Download kundali report error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to generate download URL',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * POST /api/client/users/:userId/reports/match-making
 * Body: { m_day, m_month, m_year, m_hour, m_min, m_lat, m_lon, m_tzone, f_day, f_month, f_year, f_hour, f_min, f_lat, f_lon, f_tzone }
 */
router.post('/users/:userId/reports/match-making', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId).select('clientId').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!checkUserAccess(req.user, user)) return res.status(403).json({ success: false, message: 'You do not have permission to generate reports for this user' });
    const client = await Client.findById(user.clientId?._id || user.clientId).select('settings.astrologyTools').lean();
    const cfg = getAstrologyToolsConfig(client);
    if (!cfg.enabled) {
      return res.status(403).json({ success: false, message: 'Astrology tools are disabled by client settings' });
    }

    const deduction = await deductCredits({
      userId,
      amount: REPORT_CREDIT_COSTS.match_making,
      description: 'Match making report generation',
      reportType: 'match_making',
    });

    const data = await astrologyExternalService.getMatchMakingDetailedReport(req.body || {});
    return res.json({ success: true, creditsDeducted: REPORT_CREDIT_COSTS.match_making, walletBalance: deduction.newBalance, data });
  } catch (error) {
    const status = error.status || error.response?.status || 500;
    if (error.code === 'INSUFFICIENT_CREDITS') {
      return res.status(402).json({
        success: false,
        message: error.message,
        code: 'INSUFFICIENT_CREDITS',
        required: error.required,
        available: error.available
      });
    }
    return res.status(status).json({
      success: false,
      message: error.message || 'Failed to generate match making report',
      error: process.env.NODE_ENV === 'development' ? (error.response?.data || error.message) : undefined
    });
  }
});

/**
 * Get numerology data for a user
 * POST /api/client/users/:userId/numerology
 * Body: { date: "2026-01-24" or { day: 24, month: 1, year: 2026 } } (optional - defaults to today)
 * Query params: ?refresh=true to force refresh from API
 * Access: client (own users), admin, super_admin, user (own data only)
 * Note: Name is always taken from user profile in database
 */
router.post('/users/:userId/numerology', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    let { date } = req.body;
    const forceRefresh = req.query.refresh === 'true';

    // Validate user (include liveLocation for doshas)
    const user = await User.findById(userId)
      .select('profile clientId liveLocation')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check access permissions
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to access numerology data for this user'
      });
    }

    // Get name from user profile (required)
    const userName = user.profile?.name || user.profile?.firstName;
    if (!userName) {
      return res.status(400).json({
        success: false,
        message: 'User profile must have a name to generate numerology data'
      });
    }

    // User DOB - required for numeroReport & numeroTable (static, fetched once). If missing, only daily prediction is returned.
    const userDob = user.profile?.dob || null;

    // Use provided date or default to today (for daily prediction)
    if (!date) {
      const today = new Date();
      date = {
        day: today.getDate(),
        month: today.getMonth() + 1,
        year: today.getFullYear()
      };
      console.log('[Client API] No date provided, using today:', date);
    }

    const result = await numerologyService.getNumerologyData(
      userId,
      date,
      userName,
      userDob,
      forceRefresh
    );

    // Fetch doshas (Kal Sarpa, Manglik, Pitra, Sade Sati, Shani, Gandmool) using user details
    let doshas = null;
    if (user.profile?.dob) {
      try {
        doshas = await doshaService.getAllDoshas(user);
      } catch (e) {
        console.warn('[Client API] Could not fetch doshas:', e.message);
      }
    }

    res.json({
      success: true,
      source: result.source, // 'database' or 'api'
      data: { ...result.data, doshas }
    });

  } catch (error) {
    console.error('[Client API] Get numerology data error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch numerology data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

router.get('/users/:userId/numerology', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    let { date } = req.body;
    const forceRefresh = req.query.refresh === 'true';

    // Validate user (include liveLocation for doshas)
    const user = await User.findById(userId)
      .select('profile clientId liveLocation')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check access permissions
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to access numerology data for this user'
      });
    }

    // Get name from user profile (required)
    const userName = user.profile?.name || user.profile?.firstName;
    if (!userName) {
      return res.status(400).json({
        success: false,
        message: 'User profile must have a name to generate numerology data'
      });
    }

    // User DOB - required for numeroReport & numeroTable (static, fetched once). If missing, only daily prediction is returned.
    const userDob = user.profile?.dob || null;

    // Use provided date or default to today (for daily prediction)
    if (!date) {
      const today = new Date();
      date = {
        day: today.getDate(),
        month: today.getMonth() + 1,
        year: today.getFullYear()
      };
      console.log('[Client API] No date provided, using today:', date);
    }

    const result = await numerologyService.getNumerologyData(
      userId,
      date,
      userName,
      userDob,
      forceRefresh
    );

    // Fetch doshas (Kal Sarpa, Manglik, Pitra, Sade Sati, Shani, Gandmool) using user details
    let doshas = null;
    if (user.profile?.dob) {
      try {
        doshas = await doshaService.getAllDoshas(user);
      } catch (e) {
        console.warn('[Client API] Could not fetch doshas:', e.message);
      }
    }

    res.json({
      success: true,
      source: result.source, // 'database' or 'api'
      data: { ...result.data, doshas }
    });

  } catch (error) {
    console.error('[Client API] Get numerology data error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch numerology data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Refresh numerology data for a user (force recalculation)
 * POST /api/client/users/:userId/numerology/refresh
 * Body: { date: "2026-01-24" } (optional - defaults to today)
 * Access: client (own users), admin, super_admin, user (own data only)
 * Note: Name is always taken from user profile in database
 */
router.post('/users/:userId/numerology/refresh', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    let { date } = req.body;

    const user = await User.findById(userId)
      .select('profile clientId liveLocation')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check access permissions
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to refresh numerology data for this user'
      });
    }

    // Get name from user profile (required)
    const userName = user.profile?.name || user.profile?.firstName;
    if (!userName) {
      return res.status(400).json({
        success: false,
        message: 'User profile must have a name to refresh numerology data'
      });
    }

    const userDob = user.profile?.dob || null;

    // Use provided date or default to today
    if (!date) {
      const today = new Date();
      date = {
        day: today.getDate(),
        month: today.getMonth() + 1,
        year: today.getFullYear()
      };
      console.log('[Client API] No date provided for refresh, using today:', date);
    }

    const result = await numerologyService.refreshNumerologyData(userId, date, userName, userDob);

    // Fetch doshas using user details
    let doshas = null;
    if (user.profile?.dob) {
      try {
        doshas = await doshaService.getAllDoshas(user);
      } catch (e) {
        console.warn('[Client API] Could not fetch doshas:', e.message);
      }
    }

    res.json({
      success: true,
      message: 'Numerology data refreshed successfully',
      source: result.source,
      data: { ...result.data, doshas }
    });

  } catch (error) {
    console.error('[Client API] Refresh numerology data error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to refresh numerology data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Get numerology history for a user
 * GET /api/client/users/:userId/numerology/history
 * Query params: ?limit=10&skip=0
 * Access: client (own users), admin, super_admin, user (own data only)
 */
router.get('/users/:userId/numerology/history', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 10;
    const skip = parseInt(req.query.skip) || 0;

    const user = await User.findById(userId)
      .select('clientId')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check access permissions
    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to access numerology history for this user'
      });
    }

    const result = await numerologyService.getNumerologyHistory(userId, limit, skip);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('[Client API] Get numerology history error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch numerology history',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Delete numerology data for a specific date
 * DELETE /api/client/users/:userId/numerology
 * Body: { date: "2026-01-24" }
 * Access: client (own users), admin, super_admin (users cannot delete their own data)
 */
router.delete('/users/:userId/numerology', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { date } = req.body;

    const user = await User.findById(userId)
      .select('clientId')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (req.user.role === 'client') {
      if (!user.clientId || user.clientId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'You can only delete numerology data for your own users'
        });
      }
    }

    if (!date) {
      return res.status(400).json({
        success: false,
        message: 'date is required in request body'
      });
    }

    await numerologyService.deleteNumerologyData(userId, date);

    res.json({
      success: true,
      message: 'Numerology data deleted successfully'
    });

  } catch (error) {
    console.error('[Client API] Delete numerology data error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete numerology data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Get all doshas for a user (Kal Sarpa, Manglik, Pitra, Sade Sati, Shani, Gandmool)
 * GET /api/client/users/:userId/doshas
 * Access: client (own users), admin, super_admin, user (own data only)
 * Uses user profile (dob, timeOfBirth) and liveLocation (latitude, longitude) from DB
 */
router.get('/users/:userId/doshas', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    const forceRefresh = req.query.refresh === 'true';

    const user = await User.findById(userId)
      .select('profile clientId liveLocation')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to access dosha data for this user'
      });
    }

    const result = await doshaService.getAllDoshas(user, { forceRefresh });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('[Client API] Get doshas error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch dosha data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Get remedies (puja, gemstone, rudraksha) for a user
 * GET /api/client/users/:userId/remedies
 * Query params: ?refresh=true to force refresh from API
 * Access: client (own users), admin, super_admin, user (own data only)
 */
router.get('/users/:userId/remedies', authenticate, authorize('client', 'admin', 'super_admin', 'user'), async (req, res) => {
  try {
    const { userId } = req.params;
    const forceRefresh = req.query.refresh === 'true';

    const user = await User.findById(userId)
      .select('profile clientId liveLocation')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!checkUserAccess(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to access remedies for this user'
      });
    }

    // Require basic birth details to call remedies APIs
    if (!user.profile?.dob || !user.profile?.timeOfBirth) {
      return res.status(400).json({
        success: false,
        message: 'User has incomplete birth details for remedies',
        missingFields: {
          dob: !user.profile?.dob,
          timeOfBirth: !user.profile?.timeOfBirth
        }
      });
    }

    const result = await remedyService.getRemedies(user, { forceRefresh });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('[Client API] Get remedies error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch remedies',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Get client dashboard overview
 * GET /api/client/dashboard/overview
 * Access: client
 */
router.get('/dashboard/overview', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const clientId = req.user._id;
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const [totalUsers, activeUsers, inactiveUsers, newUsersThisMonth, newUsersLastMonth, totalPartners, activePartners] = await Promise.all([
      User.countDocuments({ clientId }),
      User.countDocuments({ clientId, isActive: true }),
      User.countDocuments({ clientId, isActive: false }),
      User.countDocuments({ clientId, createdAt: { $gte: thisMonthStart } }),
      User.countDocuments({ clientId, createdAt: { $gte: lastMonthStart, $lt: thisMonthStart } }),
      Partner.countDocuments({ clientId }),
      Partner.countDocuments({ clientId, isActive: true })
    ]);

    // Last 6 months user growth
    const userGrowthRaw = await User.aggregate([
      { $match: { clientId, createdAt: { $gte: sixMonthsAgo } } },
      { $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);
    const userGrowth = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const found = userGrowthRaw.find(r => r._id.year === d.getFullYear() && r._id.month === d.getMonth() + 1);
      userGrowth.push({ month: monthNames[d.getMonth()], count: found ? found.count : 0 });
    }

    // Recent 5 users
    const recentUsers = await User.find({ clientId })
      .select('email profile.name isActive createdAt')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    const growthPct = newUsersLastMonth === 0
      ? (newUsersThisMonth > 0 ? 100 : 0)
      : Math.round(((newUsersThisMonth - newUsersLastMonth) / newUsersLastMonth) * 100);

    res.json({
      success: true,
      data: {
        totalUsers, activeUsers, inactiveUsers,
        newUsersThisMonth, newUsersLastMonth, growthPct,
        totalPartners, activePartners,
        userGrowth, recentUsers,
        clientInfo: {
          businessName: req.user.businessName,
          email: req.user.email,
          clientId: req.user.clientId || 'N/A',
          isActive: req.user.isActive
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch dashboard data' });
  }
});

// ============================================================================
// AGENTS (Client-configurable Ask AI presets)
// ============================================================================

router.get('/agents', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    let clientId = null;

    if (req.user.role === 'client') {
      clientId = req.user._id;
    } else if (req.query.clientId) {
      clientId = req.query.clientId;
    }

    const query = clientId ? { clientId } : {};
    const agents = await Agent.find(query).sort({ createdAt: -1 }).lean();

    res.json({ success: true, data: agents });
  } catch (error) {
    console.error('[Client API] Get agents error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch agents',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

router.post('/agents', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { name, description, voiceName, systemPrompt, firstMessage, isActive } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, message: 'name is required' });
    }
    if (!voiceName || typeof voiceName !== 'string' || !voiceName.trim()) {
      return res.status(400).json({ success: false, message: 'voiceName is required' });
    }
    if (!systemPrompt || typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
      return res.status(400).json({ success: false, message: 'systemPrompt is required' });
    }

    const clientId = req.user.role === 'client' ? req.user._id : (req.body.clientId || null);
    if (!clientId) {
      return res.status(400).json({ success: false, message: 'clientId is required for admin/super_admin' });
    }

    const voice = await VoiceConfig.findOne({ name: voiceName.trim() }).lean();
    if (!voice) {
      return res.status(400).json({ success: false, message: `Invalid voiceName '${voiceName}'` });
    }

    const agent = await Agent.create({
      clientId,
      name: name.trim(),
      description: (description || '').toString().trim(),
      voiceName: voiceName.trim(),
      systemPrompt: systemPrompt.trim(),
      firstMessage: (firstMessage || '').toString().trim(),
      isActive: typeof isActive === 'boolean' ? isActive : true,
      createdByRole: req.user.role,
      createdBy: req.user._id,
    });

    res.status(201).json({ success: true, message: 'Agent created', data: agent });
  } catch (error) {
    const isDup = error?.code === 11000;
    if (isDup) {
      return res.status(409).json({ success: false, message: 'Agent name already exists for this client' });
    }
    console.error('[Client API] Create agent error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create agent',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

router.put('/agents/:agentId', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { agentId } = req.params;
    const { name, description, voiceName, systemPrompt, firstMessage, isActive } = req.body || {};

    const agent = await Agent.findById(agentId);
    if (!agent) return res.status(404).json({ success: false, message: 'Agent not found' });

    if (req.user.role === 'client' && agent.clientId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    if (name !== undefined) agent.name = String(name).trim();
    if (description !== undefined) agent.description = String(description).trim();
    if (voiceName !== undefined) {
      const voice = await VoiceConfig.findOne({ name: String(voiceName).trim() }).lean();
      if (!voice) return res.status(400).json({ success: false, message: `Invalid voiceName '${voiceName}'` });
      agent.voiceName = String(voiceName).trim();
    }
    if (systemPrompt !== undefined) agent.systemPrompt = String(systemPrompt).trim();
    if (firstMessage !== undefined) agent.firstMessage = String(firstMessage || '').trim();
    if (typeof isActive === 'boolean') agent.isActive = isActive;

    await agent.save();
    res.json({ success: true, message: 'Agent updated', data: agent });
  } catch (error) {
    const isDup = error?.code === 11000;
    if (isDup) {
      return res.status(409).json({ success: false, message: 'Agent name already exists for this client' });
    }
    console.error('[Client API] Update agent error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update agent',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

router.patch('/agents/:agentId/toggle', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const { agentId } = req.params;
    const agent = await Agent.findById(agentId);
    if (!agent) return res.status(404).json({ success: false, message: 'Agent not found' });

    if (req.user.role === 'client' && agent.clientId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    agent.isActive = !agent.isActive;
    await agent.save();

    res.json({ success: true, message: `Agent is now ${agent.isActive ? 'active' : 'inactive'}`, data: agent });
  } catch (error) {
    console.error('[Client API] Toggle agent error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle agent',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /avatar-conversations
// Returns ConversationSession records for users belonging to this client.
// Query: page (default 1), limit (default 20), avatarId (optional live avatar _id filter)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/avatar-conversations', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    let clientId = null;
    if (req.user.role === 'client') {
      clientId = req.user._id;
    } else if (req.query.clientId) {
      clientId = req.query.clientId;
    }
    if (!clientId) {
      return res.status(400).json({ success: false, message: 'clientId required' });
    }

    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const userDocs = await User.find({ clientId }).select('_id').lean();
    const userIds  = userDocs.map((u) => u._id);

    if (userIds.length === 0) {
      return res.json({
        success: true,
        data: [],
        meta: { page, limit, total: 0, pages: 0, totalConversations: 0 }
      });
    }

    // Text chats: liveAvatarId, avatarName, 'Chat with' title, ya agentId wale non-voice chats
    const query = {
      userId: { $in: userIds },
      $or: [
        { liveAvatarId: { $ne: null } },
        { avatarName: { $ne: null } },
        { title: { $regex: '^Chat with', $options: 'i' } },
        // Rashmi/Krishna text chats: agentId set hai but title 'Voice Agent Chat' nahi
        { agentId: { $ne: null }, title: { $nin: ['Voice Agent Chat', 'Voice Chat'] } }
      ]
    };
    const excludeAgentQuery = query;

    const [total, chats, allAvatars] = await Promise.all([
      Chat.countDocuments(excludeAgentQuery),
      Chat.find(excludeAgentQuery)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('userId', 'email profile')
        .populate('liveAvatarId', 'name category gender imageUrl imageKey')
        .populate('agentId', 'name voiceName')
        .lean(),
      LiveAvatar.find({ isActive: true }).select('name imageUrl imageKey category').lean()
    ]);

    // Build avatar name->image map for fallback with presigned URLs
    const avatarImageMap = {};
    for (const a of allAvatars) {
      let imageUrl = null;
      const imgKey = a.imageKey || a.imageUrl;
      if (imgKey) {
        try { imageUrl = await getPresignedUrl(imgKey, 3600); } catch (e) {}
      }
      avatarImageMap[a.name?.toLowerCase()] = { ...a, imageUrl };
    }

    const data = await Promise.all(chats.map(async (c) => {
      let avatarData;
      if (c.liveAvatarId) {
        let imageUrl = null;
        const imgKey = c.liveAvatarId.imageKey || c.liveAvatarId.imageUrl;
        if (imgKey) {
          try { imageUrl = await getPresignedUrl(imgKey, 3600); } catch (e) {}
        }
        avatarData = { _id: c.liveAvatarId._id, name: c.liveAvatarId.name, category: c.liveAvatarId.category, imageUrl };
      } else {
        // agentId se naam lo, ya avatarName se, ya title se
        const agentName = c.agentId?.name || null;
        const name = agentName || c.avatarName || 
          (c.title === 'Voice Agent Chat' || c.title === 'Voice Chat' ? null : c.title?.replace(/^Chat with /i, '')) || 
          'Unknown Avatar';
        const matched = avatarImageMap[name?.toLowerCase()];
        avatarData = { 
          name, 
          category: c.agentId ? 'AI Agent' : (matched?.category || (c.title === 'Voice Agent Chat' || c.title === 'Voice Chat' ? 'Voice Agent' : null)),
          imageUrl: matched?.imageUrl || null,
          voiceName: c.agentId?.voiceName || null
        };
      }
      return {
        _id: c._id,
        user: c.userId ? {
          _id:   c.userId._id,
          name:  c.userId.profile?.name || c.userId.profile?.firstName || 'Unknown',
          email: c.userId.email
        } : null,
        avatar: avatarData,
        avatarName:    c.avatarName,
        messagesCount: c.messages?.length || 0,
        startTime:     c.createdAt,
        endTime:       c.updatedAt,
        createdAt:     c.createdAt,
        updatedAt:     c.updatedAt,
      };
    }));

    return res.json({
      success: true,
      data,
      meta: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 0,
        totalConversations: total
      }
    });
  } catch (error) {
    console.error('[Client API] Avatar conversations error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch avatar conversations',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /agents/voice-call-logs
// Returns Voice Agent call sessions (Rashmi, Krishna) for this client's users.
// Query: agentId (optional), page (default 1), limit (default 20)
// Status: ongoing (voiceEndTime null) | completed (voiceEndTime set)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/agents/voice-call-logs', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    let clientId = null;
    if (req.user.role === 'client') {
      clientId = req.user._id;
    } else if (req.query.clientId) {
      clientId = req.query.clientId;
    }
    if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });

    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const agentId = req.query.agentId?.trim() || null;

    const userDocs = await User.find({ clientId }).select('_id').lean();
    const userIds  = userDocs.map((u) => u._id);
    if (userIds.length === 0) {
      return res.json({ success: true, data: [], meta: { page, limit, total: 0, pages: 0 } });
    }

    const query = {
      userId: { $in: userIds },
      title: { $in: ['Voice Agent Chat', 'Voice Chat'] }
    };
    if (agentId) query.agentId = agentId;

    const [total, chats] = await Promise.all([
      Chat.countDocuments(query),
      Chat.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('userId', 'profile email')
        .populate('agentId', 'name voiceName description')
        .lean()
    ]);

    // Get voiceCCR for this client
    const clientDoc = await Client.findById(clientId).select('settings.voiceCCR').lean();
    const voiceCCR = clientDoc?.settings?.voiceCCR ?? 20; // 20 credits per 10 seconds

    const data = chats.map((c) => {
      const startTime = c.voiceStartTime || c.createdAt;
      // Agar voiceEndTime null hai to updatedAt use karo (purani calls ke liye)
      // Agar updatedAt aur createdAt same hain to bhi completed maano (session khatam)
      const endTime = c.voiceEndTime || (c.updatedAt && c.updatedAt !== c.createdAt ? c.updatedAt : null);
      // Only mark ongoing if call started within last 2 hours and no endTime
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      const isOngoing = !endTime && new Date(startTime).getTime() > twoHoursAgo;
      const effectiveEndTime = endTime || (isOngoing ? null : c.updatedAt || c.createdAt);
      let durationSeconds = 0;
      if (startTime && effectiveEndTime) {
        durationSeconds = Math.max(0, Math.round((new Date(effectiveEndTime) - new Date(startTime)) / 1000));
      }
      const durationMinutes = Math.round(durationSeconds / 60);

      return {
        _id:       c._id,
        user: c.userId ? {
          _id:   c.userId._id,
          name:  c.userId.profile?.name || c.userId.profile?.firstName || 'Unknown',
          email: c.userId.email
        } : null,
        agent: c.agentId ? {
          _id:       c.agentId._id,
          name:      c.agentId.name,
          voiceName: c.agentId.voiceName
        } : { name: 'Voice Agent', voiceName: '—' },
        startTime,
        endTime:         effectiveEndTime,
        durationSeconds,
        durationMinutes,
        messagesCount: c.messages?.length || 0,
        status: isOngoing ? 'ongoing' : 'completed',
        creditsUsed: Math.floor(durationSeconds / 10) * voiceCCR,
        createdAt: c.createdAt
      };
    });

    return res.json({
      success: true,
      data,
      meta: { page, limit, total, pages: Math.ceil(total / limit) || 0 }
    });
  } catch (error) {
    console.error('[Client API] Voice call logs error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch voice call logs',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /agents/conversation-logs
// Returns all voice agent conversations for users belonging to this client.
// Query: agentId (optional), page (default 1), limit (default 20)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/agents/conversation-logs', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    let clientId = null;
    if (req.user.role === 'client') {
      clientId = req.user._id;
    } else if (req.query.clientId) {
      clientId = req.query.clientId;
    }
    if (!clientId) {
      return res.status(400).json({ success: false, message: 'clientId required' });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const agentId = req.query.agentId?.trim() || null;

    const userIds = await User.find({ clientId }).select('_id').lean();
    const ids = userIds.map((u) => u._id);
    if (ids.length === 0) {
      return res.json({ success: true, data: [], meta: { page, limit, total: 0, pages: 0 } });
    }

    const query = {
      userId: { $in: ids },
      title: 'Voice Agent Chat',
    };
    if (agentId) query.agentId = agentId;

    const total = await Chat.countDocuments(query);
    const chats = await Chat.find(query)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('userId', 'profile.name email mobile')
      .populate('agentId', 'name voiceName')
      .lean();

    const data = await Promise.all(chats.map(async (c) => {
      const messages = await Promise.all((c.messages || []).map(async (msg) => {
        const m = { ...msg };
        if (msg.audioKey) {
          try {
            m.audioUrl = await getPresignedUrl(msg.audioKey, 3600);
          } catch (e) {
            m.audioUrl = null;
          }
        }
        return m;
      }));
      return {
        _id: c._id,
        user: c.userId ? {
          _id: c.userId._id,
          name: c.userId.profile?.name || 'Unknown',
          email: c.userId.email || null,
          mobile: c.userId.mobile || null,
        } : null,
        agent: c.agentId ? { _id: c.agentId._id, name: c.agentId.name, voiceName: c.agentId.voiceName } : null,
        messages,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    }));

    res.json({
      success: true,
      data,
      meta: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 0,
      },
    });
  } catch (error) {
    console.error('[Client API] Conversation logs error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch conversation logs',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});


// ============ Client Health Route ============
router.get('/health', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  try {
    const dbState = mongoose.connection.readyState;
    const dbStatusMap = { 0: 'Disconnected', 1: 'Connected', 2: 'Connecting', 3: 'Disconnecting' };
    const dbStatus = dbStatusMap[dbState] || 'Unknown';

    const mem = process.memoryUsage();
    const toMB = (bytes) => Math.round(bytes / 1024 / 1024);

    const uptimeSec = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = uptimeSec % 60;
    const uptime = `${hours}h ${minutes}m ${seconds}s`;

    const clientId = req.user._id;
    const [totalUsers, activeUsers, newUsersThisMonth] = await Promise.all([
      User.countDocuments({ clientId }),
      User.countDocuments({ clientId, isActive: true }),
      User.countDocuments({
        clientId,
        createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
      })
    ]);

    const services = [
      { name: 'MongoDB', status: dbState === 1 ? 'Operational' : 'Down', healthy: dbState === 1 },
      { name: 'REST API', status: 'Operational', healthy: true },
      { name: 'Authentication', status: 'Operational', healthy: true },
      { name: 'File Storage', status: 'Operational', healthy: true }
    ];

    res.json({
      success: true,
      data: {
        server: { status: 'Operational', uptime, nodeVersion: process.version, env: process.env.NODE_ENV || 'production' },
        database: { status: dbStatus, healthy: dbState === 1, host: mongoose.connection.host || 'Atlas' },
        memory: { heapUsed: toMB(mem.heapUsed), heapTotal: toMB(mem.heapTotal), rss: toMB(mem.rss), unit: 'MB' },
        services,
        stats: { totalUsers, activeUsers, newUsersThisMonth }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============ Client API Health Monitor ============
router.get('/api-health', authenticate, authorize('client', 'admin', 'super_admin'), async (req, res) => {
  const BASE = `http://localhost:${process.env.PORT || 5000}/api`;
  const token = req.headers.authorization;

  const endpoints = [
    { name: 'Client Health',        group: 'Client',    method: 'GET', url: `${BASE}/client/health` },
    { name: 'Client Users',         group: 'Client',    method: 'GET', url: `${BASE}/client/users?limit=1` },
    { name: 'Auth - Client Me',     group: 'Client',    method: 'GET', url: `${BASE}/auth/client/me` },
    { name: 'Spiritual Check-in',   group: 'Spiritual', method: 'GET', url: `${BASE}/mobile/spiritual-checkin` },
    { name: 'Spiritual Activities', group: 'Spiritual', method: 'GET', url: `${BASE}/spiritual-activities` },
    { name: 'Spiritual Rewards',    group: 'Spiritual', method: 'GET', url: `${BASE}/spiritual-rewards` },
    { name: 'Karma Points',         group: 'Spiritual', method: 'GET', url: `${BASE}/karma-points` },
    { name: 'Leaderboard',          group: 'Spiritual', method: 'GET', url: `${BASE}/leaderboard` },
    { name: 'Sankalp',              group: 'Spiritual', method: 'GET', url: `${BASE}/sankalp` },
    { name: 'Puja Padhati',         group: 'Spiritual', method: 'GET', url: `${BASE}/puja-padhati` },
    { name: 'Swapna Decoder',       group: 'Spiritual', method: 'GET', url: `${BASE}/swapna-decoder` },
    { name: 'Experts',              group: 'Content',   method: 'GET', url: `${BASE}/experts` },
    { name: 'Expert Categories',    group: 'Content',   method: 'GET', url: `${BASE}/expert-categories` },
    { name: 'Meditations',          group: 'Content',   method: 'GET', url: `${BASE}/meditations` },
    { name: 'Chantings',            group: 'Content',   method: 'GET', url: `${BASE}/chantings` },
    { name: 'Brahm Avatars',        group: 'Content',   method: 'GET', url: `${BASE}/brahm-avatars` },
    { name: 'Chapters',             group: 'Content',   method: 'GET', url: `${BASE}/chapters` },
    { name: 'Notifications',        group: 'Content',   method: 'GET', url: `${BASE}/notifications` },
    { name: 'Voice Config',         group: 'Content',   method: 'GET', url: `${BASE}/voice-config` },
    { name: 'Prathanas',            group: 'Content',   method: 'GET', url: `${BASE}/prathanas` },
    { name: 'Shlokas',              group: 'Content',   method: 'GET', url: `${BASE}/shlokas` },
    { name: 'Health Check',         group: 'System',    method: 'GET', url: `${BASE}/health` },
  ];

  const results = await Promise.all(
    endpoints.map(async (ep) => {
      const start = Date.now();
      try {
        const response = await fetch(ep.url, {
          method: ep.method,
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(8000)
        });
        const ms = Date.now() - start;
        const healthy = response.status > 0 && response.status < 500;
        const label = response.status < 300 ? 'OK' : response.status < 400 ? 'Redirect' : response.status < 500 ? 'Client Err' : 'Server Err';
        return { ...ep, url: ep.url.replace(BASE, '/api'), status: response.status, ms, healthy, label };
      } catch (err) {
        return { ...ep, url: ep.url.replace(BASE, '/api'), method: ep.method, status: 0, ms: Date.now() - start, healthy: false, label: 'Unreachable', error: err.message };
      }
    })
  );

  const totalHealthy = results.filter(r => r.healthy).length;
  const avgMs = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);

  res.json({
    success: true,
    data: {
      summary: { total: results.length, healthy: totalHealthy, failed: results.length - totalHealthy, avgMs },
      endpoints: results
    }
  });
});

export default router;