import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import Message from '../models/Message.js';
import Conversation from '../models/Conversation.js';
import ConversationSession from '../models/ConversationSession.js';
import ChatCreditLedger from '../models/ChatCreditLedger.js';
import ServiceCreditLedger from '../models/ServiceCreditLedger.js';
import VoiceCallLog from '../models/VoiceCallLog.js';
import Partner from '../models/Partner.js';
import User from '../models/User.js';
import astrologyService from '../services/astrologyService.js';
import numerologyService from '../services/numerologyService.js';
import doshaService from '../services/doshaService.js';
import remedyService from '../services/remedyService.js';
import { canPartnerAcceptConversation, syncPartnerActiveConversationCount } from '../utils/partnerConversationUtils.js';
import { normalizeConversationType, resolveConversationKindFromRequest, ensureVoiceCallConversation } from '../utils/voiceCallConversationUtils.js';
import panchangService from '../services/panchangService.js';
import { generateConversationSummary } from '../services/geminiService.js';
import { getPresignedUrl, generateUploadUrl } from '../utils/storage.js';
import { getBillingRates } from '../services/billingRates.js';
import { validateUserPartnerNotSameContact, getUserDisplayName } from '../utils/accountValidation.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET environment variable is not set!');
  process.exit(1);
}

// Middleware to authenticate
const authenticate = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    let user;
    if (decoded.role === 'partner') {
      const partnerIdFromToken = decoded.userId || decoded.partnerId;
      user = await Partner.findById(partnerIdFromToken);
      req.userId = partnerIdFromToken;
      req.userType = 'partner';
    } else if (decoded.role === 'user') {
      user = await User.findById(decoded.userId);
      req.userId = decoded.userId;
      req.userType = 'user';
    }

    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }

    req.user = user;
    next();
  } catch (error) {
    // Only log unexpected errors, not normal expired/invalid token cases
    if (error.name !== 'TokenExpiredError' && error.name !== 'JsonWebTokenError') {
      console.error('❌ Authentication error:', error.message);
    }
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// ==================== PARTNER STATUS MANAGEMENT ====================

// @route   PATCH /api/chat/partner/status
// @desc    Update partner's online status (online/offline/busy)
// @access  Private (Partner only)
router.patch('/partner/status', authenticate, async (req, res) => {
  try {
    console.log('📊 UPDATE PARTNER STATUS - START');
    console.log('User Type:', req.userType);
    console.log('User ID:', req.userId);
    console.log('Request Body:', req.body);

    if (req.userType !== 'partner') {
      console.log('❌ Access denied - not a partner');
      return res.status(403).json({
        success: false,
        message: 'Only partners can update status'
      });
    }

    const { status } = req.body;

    if (!['online', 'offline', 'busy'].includes(status)) {
      console.log('❌ Invalid status:', status);
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be: online, offline, or busy'
      });
    }

    console.log('🔄 Updating partner status to:', status);

    const partner = await Partner.findByIdAndUpdate(
      req.userId,
      {
        onlineStatus: status,
        lastActiveAt: new Date()
      },
      { new: true }
    ).select('name email onlineStatus lastActiveAt activeConversationsCount');

    console.log('✅ Partner status updated:', partner);

    res.json({
      success: true,
      message: 'Status updated successfully',
      data: partner
    });
  } catch (error) {
    console.error('❌ Error updating partner status:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to update status',
      error: error.message
    });
  }
});

// @route   GET /api/chat/partner/status
// @desc    Get partner's current status
// @access  Private (Partner only)
router.get('/partner/status', authenticate, async (req, res) => {
  try {
    console.log('📊 GET PARTNER STATUS - START');
    console.log('User Type:', req.userType);
    console.log('User ID:', req.userId);

    if (req.userType !== 'partner') {
      console.log('❌ Access denied - not a partner');
      return res.status(403).json({
        success: false,
        message: 'Only partners can view their status'
      });
    }

    const partner = await Partner.findById(req.userId)
      .select('name email onlineStatus lastActiveAt activeConversationsCount maxConversations');

    console.log('✅ Partner status fetched:', partner);

    res.json({
      success: true,
      data: {
        ...partner.toObject(),
        canAcceptMore: partner.activeConversationsCount < partner.maxConversations
      }
    });
  } catch (error) {
    console.error('❌ Error fetching partner status:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch status',
      error: error.message
    });
  }
});

// ==================== GET AVAILABLE PARTNERS ====================

// @route   GET /api/chat/partners
// @desc    Get all available partners for users
// @access  Private
router.get('/partners', authenticate, async (req, res) => {
  try {
    console.log('═══════════════════════════════════════════════════');
    console.log('🔍 GET ALL PARTNERS - START');
    console.log('═══════════════════════════════════════════════════');
    console.log('📋 Request Info:');
    console.log('  - User Type:', req.userType);
    console.log('  - User ID:', req.userId);
    console.log('  - User Email:', req.user?.email);

    console.log('🔍 Querying Partner collection...');
    
    const totalPartners = await Partner.countDocuments();
    const activePartners = await Partner.countDocuments({ isActive: true });
    const verifiedPartners = await Partner.countDocuments({ isVerified: true });
    const activeAndVerified = await Partner.countDocuments({ isActive: true, isVerified: true });
    
    console.log(`📊 Total partners: ${totalPartners}`);
    console.log(`📊 Active partners: ${activePartners}`);
    console.log(`📊 Verified partners: ${verifiedPartners}`);
    console.log(`📊 Active AND verified: ${activeAndVerified}`);

    const partners = await Partner.find({ isActive: true, isVerified: true })
      .select('name email phone profilePicture bio specialization rating totalSessions experience experienceRange expertise expertiseCategory skills languages qualifications consultationModes location totalRatings completedSessions pricePerSession currency onlineStatus activeConversationsCount maxConversations lastActiveAt availabilityPreference')
      .sort({ rating: -1, totalSessions: -1 })
      .lean();

    console.log(`✅ Partners found: ${partners.length}`);

    // Process partners with safe defaults for missing fields
    const partnersData = partners.map(partner => {
      const onlineStatus = partner.onlineStatus || 'offline';
      const activeConversationsCount = partner.activeConversationsCount ?? 0;
      const maxConversations = partner.maxConversations || 5;
      
      const processedPartner = {
        ...partner,
        name: partner.name || partner.email.split('@')[0],
        onlineStatus,
        activeConversationsCount,
        maxConversations,
        rating: partner.rating || 0,
        totalSessions: partner.totalSessions || 0,
        experience: partner.experience || 0,
        status: onlineStatus,
        isBusy: activeConversationsCount >= maxConversations,
        canAcceptConversation: activeConversationsCount < maxConversations,
        availableSlots: maxConversations - activeConversationsCount
      };
      
      console.log('🔄 Processed partner:', processedPartner.name, {
        status: processedPartner.status,
        isBusy: processedPartner.isBusy,
        activeConversations: activeConversationsCount,
        maxConversations: maxConversations
      });
      
      return processedPartner;
    });

    console.log('✅ Partners data prepared, sending response...');
    console.log('═══════════════════════════════════════════════════');

    res.json({
      success: true,
      data: partnersData,
      meta: {
        total: partnersData.length,
        totalInDb: totalPartners,
        active: activePartners,
        verified: verifiedPartners,
        query: { isActive: true, isVerified: true }
      }
    });
  } catch (error) {
    console.error('═══════════════════════════════════════════════════');
    console.error('❌ ERROR in GET PARTNERS:');
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);
    console.error('═══════════════════════════════════════════════════');
    res.status(500).json({
      success: false,
      message: 'Failed to fetch partners',
      error: error.message
    });
  }
});

// @route   GET /api/chat/partners/:partnerId
// @desc    Get full partner details (for display in chat sidebar)
// @access  Private
router.get('/partners/:partnerId', authenticate, async (req, res) => {
  try {
    const { partnerId } = req.params;
    const partner = await Partner.findById(partnerId)
      .select('-password -resetPasswordToken -resetPasswordExpires')
      .lean();
    if (!partner || !partner.isActive) {
      return res.status(404).json({ success: false, message: 'Partner not found' });
    }
    const onlineStatus = partner.onlineStatus || 'offline';
    const activeConversationsCount = partner.activeConversationsCount ?? 0;
    const maxConversations = partner.maxConversations || 5;
    res.json({
      success: true,
      data: {
        ...partner,
        status: onlineStatus,
        isBusy: activeConversationsCount >= maxConversations,
        canAcceptConversation: activeConversationsCount < maxConversations
      }
    });
  } catch (error) {
    console.error('❌ Error fetching partner:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch partner',
      error: error.message
    });
  }
});

// ==================== CONVERSATION REQUESTS ====================

// @route   POST /api/chat/conversations
// @desc    Create conversation request with user's astrology data (AUTO-FILLED FROM PROFILE)
// @access  Private
router.post('/conversations', authenticate, async (req, res) => {
  try {
    console.log('💬 CREATE CONVERSATION - START');
    console.log('Request Body:', req.body);
    console.log('User Type:', req.userType);

    const { partnerId, userId, astrologyData } = req.body;
    const conversationKind = resolveConversationKindFromRequest({
      ...req.body,
      type: req.body?.type ?? req.query?.type,
      conversationType: req.body?.conversationType ?? req.query?.conversationType,
      callType: req.body?.callType ?? req.query?.callType,
      serviceType: req.body?.serviceType ?? req.query?.serviceType,
      mode: req.body?.mode ?? req.query?.mode,
      requestType: req.body?.requestType ?? req.query?.requestType
    });

    console.log('Resolved conversation kind:', conversationKind);

    // Validate request based on user type
    if (req.userType === 'user' && !partnerId) {
      console.log('❌ Partner ID missing for user request');
      return res.status(400).json({
        success: false,
        message: 'Partner ID is required'
      });
    }

    if (req.userType === 'partner' && !userId) {
      console.log('❌ User ID missing for partner request');
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    const finalPartnerId = req.userType === 'partner' ? req.userId : partnerId;
    const finalUserId = req.userType === 'user' ? req.userId : userId;

    console.log('Final IDs:', { partnerId: finalPartnerId, userId: finalUserId });

    // Check if partner exists and is available
    const partner = await Partner.findById(finalPartnerId);
    if (!partner) {
      console.log('❌ Partner not found:', finalPartnerId);
      return res.status(404).json({
        success: false,
        message: 'Partner not found'
      });
    }

    console.log('✅ Partner found:', partner.name);

    const contactError = await validateUserPartnerNotSameContact(finalUserId, finalPartnerId);
    if (contactError) {
      return res.status(400).json({ success: false, message: contactError });
    }

    // If user is starting a chat, ensure they have credits > 0
    if (req.userType === 'user') {
      const user = await User.findById(finalUserId).select('credits email');
      if (!user || (user.credits || 0) <= 0) {
        console.log('❌ User has insufficient credits to start chat:', user?.email);
        return res.status(402).json({
          success: false,
          message: 'Insufficient credits. Please recharge before starting a chat.'
        });
      }
    }

    // Base ID for lookup; new consultations get unique ID with timestamp
    const baseId = [finalPartnerId, finalUserId].sort().join('_');
    console.log('Base conversation ID:', baseId);

    // Check if active/pending conversation already exists (same session + type)
    let conversation = await Conversation.findOne({
      partnerId: finalPartnerId,
      userId: finalUserId,
      type: conversationKind,
      status: { $in: ['pending', 'accepted', 'active'] }
    });

    // Android may retry voice after an older pending chat request was created incorrectly.
    if (!conversation && conversationKind === 'voice_call') {
      const pendingChat = await Conversation.findOne({
        partnerId: finalPartnerId,
        userId: finalUserId,
        type: 'chat',
        status: 'pending',
        isAcceptedByPartner: false
      });
      if (pendingChat) {
        conversation = await ensureVoiceCallConversation(pendingChat);
      }
    }

    // BUG FIX: voice_call conversation already exists aur response mein conversationId properly aana chahiye
    if (conversation) {
      console.log('ℹ️ Active/pending conversation already exists', {
        conversationId: conversation.conversationId,
        type: conversation.type,
        status: conversation.status
      });
      await conversation.populate('partnerId', 'name email profilePicture specialization rating onlineStatus bio experience expertise languages qualifications location totalSessions completedSessions pricePerSession');
      await conversation.populate('userId', 'email profile profileImage');
      return res.json({
        success: true,
        message: conversation.type === 'voice_call'
          ? 'Voice call request already exists'
          : 'Conversation already exists',
        data: {
          ...conversation.toObject(),
          conversationId: conversation.conversationId  // Explicitly include at top level
        }
      });
    }

    // For new consultation after ended/rejected: create NEW conversation with unique ID
    const conversationId = `${baseId}_${Date.now()}`;
    console.log('Generated new conversation ID:', conversationId);

    // Get user's complete profile data
    let userAstrologyInfo = {};
    if (req.userType === 'user') {
      const user = await User.findById(finalUserId);
      
      console.log('📊 User profile data:', user.profile);
      
      // Use provided astrology data OR fall back to user profile
      // Provided data takes priority, profile is fallback
      userAstrologyInfo = {
        name: astrologyData?.name || user.profile?.name || user.email,
        dateOfBirth: astrologyData?.dateOfBirth || (user.profile?.dob ? new Date(user.profile.dob).toISOString().split('T')[0] : null),
        timeOfBirth: astrologyData?.timeOfBirth || user.profile?.timeOfBirth || '',
        placeOfBirth: astrologyData?.placeOfBirth || user.profile?.placeOfBirth || '',
        latitude: astrologyData?.latitude ?? user.profile?.latitude ?? null,
        longitude: astrologyData?.longitude ?? user.profile?.longitude ?? null,
        gowthra: astrologyData?.gowthra || user.profile?.gowthra || '',
        zodiacSign: astrologyData?.zodiacSign || user.profile?.zodiacSign || '',
        moonSign: astrologyData?.moonSign || user.profile?.moonSign || '',
        ascendant: astrologyData?.ascendant || user.profile?.ascendant || '',
        additionalInfo: astrologyData?.additionalInfo || user.profile?.astrologyDetails
      };
      
      console.log('📊 Final astrology data for conversation:', userAstrologyInfo);
    }

    // Create new conversation request
    console.log('🆕 Creating new conversation...');
    const isVoiceRequest = conversationKind === 'voice_call';
    conversation = await Conversation.create({
      conversationId,
      partnerId: finalPartnerId,
      userId: finalUserId,
      status: 'pending',
      isAcceptedByPartner: false,
      type: conversationKind,
      conversationType: isVoiceRequest ? 'call' : 'chat',
      userAstrologyData: userAstrologyInfo,
      metadata: {
        source: req.headers['x-client-platform'] || req.body?.platform || 'api',
        deviceType: req.headers['x-client-platform'] || req.body?.deviceType || null,
        userAgent: req.headers['user-agent'] || null
      }
    });

    await conversation.populate('partnerId', 'name email profilePicture specialization rating onlineStatus bio experience expertise languages qualifications location totalSessions completedSessions pricePerSession');
    await conversation.populate('userId', 'email profile profileImage');

    console.log('✅ Conversation created successfully', {
      conversationId: conversation.conversationId,
      type: conversation.type,
      conversationType: conversation.conversationType
    });

    // BUG FIX: conversationId explicitly top-level mein include karo response mein
    // Android app data.conversationId parse karta hai
    const convObj = conversation.toObject();
    res.json({
      success: true,
      message: isVoiceRequest
        ? 'Voice call request created. Waiting for partner to accept the call.'
        : 'Conversation request created. Waiting for partner acceptance.',
      data: {
        ...convObj,
        conversationId: conversation.conversationId  // Guarantee top-level field
      }
    });
  } catch (error) {
    console.error('❌ Error creating conversation:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to create conversation',
      error: error.message
    });
  }
});

// @route   GET /api/chat/partner/requests
// @desc    Get all pending conversation requests for partner
// @access  Private (Partner only)
router.get('/partner/requests', authenticate, async (req, res) => {
  try {
    console.log('📥 GET PARTNER REQUESTS - START');
    console.log('User Type:', req.userType);
    console.log('Partner ID:', req.userId);

    if (req.userType !== 'partner') {
      console.log('❌ Access denied - not a partner');
      return res.status(403).json({
        success: false,
        message: 'Only partners can view conversation requests'
      });
    }

    // Keep activeConversationsCount in sync with real open conversations
    await syncPartnerActiveConversationCount(req.userId);

    const partnerObjectId = mongoose.Types.ObjectId.isValid(req.userId) ? new mongoose.Types.ObjectId(req.userId) : req.userId;
    const requests = await Conversation.find({
      partnerId: partnerObjectId,
      status: 'pending',
      isAcceptedByPartner: false,
      type: { $ne: 'voice_call' }
    })
      .sort({ createdAt: -1 })
      .populate('userId', 'email profile profileImage')
      .lean();

    console.log(`✅ Found ${requests.length} pending requests`);

    const requestsWithAstrology = requests.map(request => ({
      ...request,
      userAstrology: request.userAstrologyData
    }));

    res.json({
      success: true,
      data: {
        requests: requestsWithAstrology,
        totalRequests: requests.length
      }
    });
  } catch (error) {
    console.error('❌ Error fetching conversation requests:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch conversation requests',
      error: error.message
    });
  }
});

// @route   POST /api/chat/partner/requests/:conversationId/accept
// @desc    Accept a conversation request
// @access  Private (Partner only)
router.post('/partner/requests/:conversationId/accept', authenticate, async (req, res) => {
  try {
    console.log('✅ ACCEPT CONVERSATION REQUEST - START');
    console.log('Conversation ID:', req.params.conversationId);
    console.log('Partner ID:', req.userId);

    if (req.userType !== 'partner') {
      return res.status(403).json({
        success: false,
        message: 'Only partners can accept conversation requests'
      });
    }

    const { conversationId } = req.params;

    const conversation = await Conversation.findOne({ conversationId });

    if (!conversation) {
      console.log('❌ Conversation not found');
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    if (conversation.partnerId.toString() !== req.userId) {
      console.log('❌ Access denied - not your conversation');
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    if (conversation.isAcceptedByPartner) {
      console.log('⚠️ Already accepted');
      return res.status(400).json({
        success: false,
        message: 'Conversation already accepted'
      });
    }

    // Check if partner can accept more conversations (sync from DB to avoid stale counter)
    const acceptCheck = await canPartnerAcceptConversation(req.userId);
    if (!acceptCheck.allowed) {
      console.log('❌ Max conversations reached (actual:', acceptCheck.actualCount, 'max:', acceptCheck.maxConversations, ')');
      return res.status(400).json({
        success: false,
        message: acceptCheck.message
      });
    }

    const partner = acceptCheck.partner;

    // Accept conversation - session timing starts from partner acceptance
    const acceptedAt = new Date();
    conversation.status = 'accepted';
    conversation.isAcceptedByPartner = true;
    conversation.acceptedAt = acceptedAt;
    conversation.startedAt = acceptedAt;
    conversation.sessionDetails = {
      ...(conversation.sessionDetails || {}),
      startTime: acceptedAt,
      duration: 0,
      messagesCount: 0,
      creditsUsed: conversation.sessionDetails?.creditsUsed || 0
    };
    await conversation.save();

    // Update partner's active conversation count
    partner.activeConversationsCount += 1;
    await partner.updateBusyStatus();

    console.log('✅ Conversation accepted, active count:', partner.activeConversationsCount);

    await conversation.populate('partnerId', 'name email profilePicture specialization rating onlineStatus');
    await conversation.populate('userId', 'email profile profileImage');

    res.json({
      success: true,
      message: 'Conversation accepted successfully',
      data: conversation
    });
  } catch (error) {
    console.error('❌ Error accepting conversation:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to accept conversation',
      error: error.message
    });
  }
});

// @route   POST /api/chat/partner/requests/:conversationId/reject
// @desc    Reject a conversation request
// @access  Private (Partner only)
router.post('/partner/requests/:conversationId/reject', authenticate, async (req, res) => {
  try {
    console.log('❌ REJECT CONVERSATION REQUEST - START');
    console.log('Conversation ID:', req.params.conversationId);

    if (req.userType !== 'partner') {
      return res.status(403).json({
        success: false,
        message: 'Only partners can reject conversation requests'
      });
    }

    const { conversationId } = req.params;
    const { reason } = req.body;

    const conversation = await Conversation.findOne({ conversationId });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    if (conversation.partnerId.toString() !== req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Only pending, not-yet-accepted requests can be rejected
    if (conversation.status !== 'pending' || conversation.isAcceptedByPartner) {
      return res.status(400).json({
        success: false,
        message: 'Only pending requests can be rejected'
      });
    }

    conversation.status = 'rejected';
    conversation.rejectedAt = new Date();
    if (reason) {
      conversation.rejectedReason = reason;
    }
    await conversation.save();

    console.log('✅ Conversation rejected');

    res.json({
      success: true,
      message: 'Conversation rejected',
      data: conversation
    });
  } catch (error) {
    console.error('❌ Error rejecting conversation:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to reject conversation',
      error: error.message
    });
  }
});

// @route   POST /api/chat/user/requests/:conversationId/cancel
// @desc    Cancel a pending conversation request before partner acceptance
// @access  Private (User only)
router.post('/user/requests/:conversationId/cancel', authenticate, async (req, res) => {
  try {
    console.log('🛑 CANCEL CONVERSATION REQUEST (USER) - START');
    console.log('Conversation ID:', req.params.conversationId);

    if (req.userType !== 'user') {
      return res.status(403).json({
        success: false,
        message: 'Only users can cancel conversation requests'
      });
    }

    const { conversationId } = req.params;
    const { reason } = req.body || {};

    const conversation = await Conversation.findOne({ conversationId });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    if (conversation.userId.toString() !== req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Only pending, not-yet-accepted requests can be cancelled
    if (conversation.status !== 'pending' || conversation.isAcceptedByPartner) {
      return res.status(400).json({
        success: false,
        message: 'Only pending requests can be cancelled before partner acceptance'
      });
    }

    conversation.status = 'cancelled';
    conversation.cancelledAt = new Date();
    conversation.cancelledBy = 'user';
    if (reason) {
      conversation.cancelReason = reason;
    }

    // Ensure there is no duration / billing information
    conversation.sessionDetails = {
      ...(conversation.sessionDetails || {}),
      startTime: conversation.sessionDetails?.startTime || conversation.createdAt,
      endTime: conversation.cancelledAt,
      duration: 0,
      messagesCount: 0,
      creditsUsed: 0,
      partnerCreditsEarned: 0
    };

    await conversation.save();

    console.log('✅ Conversation request cancelled by user');

    res.json({
      success: true,
      message: 'Conversation request cancelled',
      data: conversation
    });
  } catch (error) {
    console.error('❌ Error cancelling conversation request:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel conversation request',
      error: error.message
    });
  }
});

// ==================== CONVERSATIONS LIST ====================
// @route   GET /api/chat/conversations
// @desc    Get all conversations (accepted/active) for logged-in user/partner
// @access  Private
router.get('/conversations', authenticate, async (req, res) => {
  try {
    console.log('💬 GET CONVERSATIONS - START');
    console.log('User Type:', req.userType);
    console.log('User ID:', req.userId);

    const isPartner = req.userType === 'partner';
    if (isPartner) {
      await syncPartnerActiveConversationCount(req.userId);
    }

    const listType = req.query.type ? normalizeConversationType(req.query.type) : null;
    const query = isPartner
      ? { partnerId: req.userId, status: { $in: ['accepted', 'active', 'ended'] } }
      : { userId: req.userId, status: { $in: ['accepted', 'active', 'pending', 'ended'] } };

    if (listType) {
      query.type = listType;
    } else {
      query.type = { $ne: 'voice_call' };
    }

    console.log('Query:', JSON.stringify(query));

    const conversations = await Conversation.find(query)
      .sort({ lastMessageAt: -1 })
      .populate('partnerId', 'name email profilePicture specialization rating onlineStatus bio experience expertise languages qualifications location totalSessions completedSessions pricePerSession')
      .populate('userId', 'email profile profileImage')
      .lean();

    console.log(`✅ Found ${conversations.length} conversations`);

    const conversationsData = conversations.map(conv => ({
      ...conv,
      otherUser: isPartner ? conv.userId : conv.partnerId,
      unreadCount: isPartner ? conv.unreadCount.partner : conv.unreadCount.user,
      userAstrology: isPartner ? conv.userAstrologyData : null
    }));

    // Replace S3 keys with presigned URLs for otherUser profile images (bucket is private)
    const conversationsWithPresignedUrls = await Promise.all(
      conversationsData.map(async (conv) => {
        const other = conv.otherUser;
        if (!other) return conv;
        const updated = { ...conv, otherUser: other ? { ...other } : other };
        const otherUser = updated.otherUser;
        if (!otherUser) return updated;
        // Partner: profilePicture may be S3 key — use presigned URL so client can show image
        if (otherUser.profilePicture && !otherUser.profilePicture.startsWith('http')) {
          try {
            const url = await getPresignedUrl(otherUser.profilePicture);
            otherUser.profilePictureUrl = url;
            otherUser.profilePicture = url;
          } catch (err) {
            console.error('Error presigned URL for partner profilePicture:', err);
          }
        } else if (otherUser.profilePicture && otherUser.profilePicture.startsWith('http')) {
          otherUser.profilePictureUrl = otherUser.profilePicture;
        }
        // User: profileImage may be S3 key — use presigned URL so client can show image
        if (otherUser.profileImage && !otherUser.profileImage.startsWith('http')) {
          try {
            const url = await getPresignedUrl(otherUser.profileImage);
            otherUser.profileImageUrl = url;
            otherUser.profileImage = url;
          } catch (err) {
            console.error('Error presigned URL for user profileImage:', err);
          }
        } else if (otherUser.profileImage && otherUser.profileImage.startsWith('http')) {
          otherUser.profileImageUrl = otherUser.profileImage;
        }
        return updated;
      })
    );

    // Return only fields needed for conversation list (remove heavy/unnecessary payload)
    const slimData = conversationsWithPresignedUrls.map((conv) => ({
      _id: conv._id,
      conversationId: conv.conversationId,
      status: conv.status,
      type: conv.type || 'chat',
      isAcceptedByPartner: conv.isAcceptedByPartner,
      acceptedAt: conv.acceptedAt,
      lastMessage: conv.lastMessage,
      lastMessageAt: conv.lastMessageAt,
      unreadCount: conv.unreadCount,
      otherUser: conv.otherUser,
      userAstrology: conv.userAstrology,
      startedAt: conv.startedAt,
      endedAt: conv.endedAt,
      messagesCount: conv.sessionDetails?.messagesCount ?? 0,
      createdAt: conv.createdAt
    }));

    res.json({
      success: true,
      data: slimData
    });
  } catch (error) {
    console.error('❌ Error fetching conversations:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch conversations',
      error: error.message
    });
  }
});

// ==================== MESSAGES ====================

// @route   GET /api/chat/conversations/:conversationId/messages
// @desc    Get messages for a specific conversation
// @access  Private
router.get('/conversations/:conversationId/messages', authenticate, async (req, res) => {
  try {
    console.log('📨 GET MESSAGES - START');
    console.log('Conversation ID:', req.params.conversationId);
    console.log('User ID:', req.userId);
    console.log('User Type:', req.userType);

    const { conversationId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    // Verify user has access to this conversation
    const conversation = await Conversation.findOne({ conversationId });
    
    if (!conversation) {
      console.log('❌ Conversation not found');
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    const isPartner = req.userType === 'partner';
    const hasAccess = isPartner 
      ? conversation.partnerId.toString() === req.userId 
      : conversation.userId.toString() === req.userId;

    if (!hasAccess) {
      console.log('❌ Access denied');
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Don't allow messaging if conversation is not accepted
    if (conversation.status === 'pending' && !conversation.isAcceptedByPartner) {
      console.log('⚠️ Conversation pending acceptance');
      return res.status(403).json({
        success: false,
        message: 'Conversation is pending partner acceptance'
      });
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const messages = await Message.find({ conversationId, isDeleted: false })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('senderId', 'name email profilePicture profile profileImage')
      .lean();

    const totalMessages = await Message.countDocuments({ conversationId, isDeleted: false });

    console.log(`✅ Found ${messages.length} messages (total: ${totalMessages})`);

    // Replace S3 keys with presigned URLs for sender profile images
    const messagesWithPresignedUrls = await Promise.all(
      messages.map(async (message) => {
        const sender = message.senderId;
        if (!sender) return message;
        
        const updatedMessage = { ...message, senderId: { ...sender } };
        const senderData = updatedMessage.senderId;
        
        // Partner: profilePicture may be S3 key — use presigned URL so client can show image
        if (senderData.profilePicture && !senderData.profilePicture.startsWith('http')) {
          try {
            const url = await getPresignedUrl(senderData.profilePicture);
            senderData.profilePictureUrl = url;
            senderData.profilePicture = url;
          } catch (err) {
            console.error('Error presigned URL for sender profilePicture:', err);
          }
        } else if (senderData.profilePicture && senderData.profilePicture.startsWith('http')) {
          senderData.profilePictureUrl = senderData.profilePicture;
        }
        
        // User: profileImage may be S3 key — use presigned URL so client can show image
        if (senderData.profileImage && !senderData.profileImage.startsWith('http')) {
          try {
            const url = await getPresignedUrl(senderData.profileImage);
            senderData.profileImageUrl = url;
            senderData.profileImage = url;
          } catch (err) {
            console.error('Error presigned URL for sender profileImage:', err);
          }
        } else if (senderData.profileImage && senderData.profileImage.startsWith('http')) {
          senderData.profileImageUrl = senderData.profileImage;
        }
        
        return updatedMessage;
      })
    );

    const responseData = {
      messages: messagesWithPresignedUrls.reverse(),
      conversationStatus: conversation.status,
      isAccepted: conversation.isAcceptedByPartner,
      userAstrology: isPartner ? conversation.userAstrologyData : null,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        totalMessages,
        totalPages: Math.ceil(totalMessages / parseInt(limit)),
        hasMore: skip + messages.length < totalMessages
      }
    };

    if (conversation.status === 'ended') {
      responseData.sessionDetails = conversation.sessionDetails || null;
      responseData.rating = conversation.rating || { byUser: {}, byPartner: {} };
    }

    res.json({
      success: true,
      data: responseData
    });
  } catch (error) {
    console.error('❌ Error fetching messages:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch messages',
      error: error.message
    });
  }
});

// @route   POST /api/chat/conversations/:conversationId/messages
// @desc    Send a message (REST fallback if WebSocket is not available)
// @access  Private
router.post('/conversations/:conversationId/messages', authenticate, async (req, res) => {
  try {
    console.log('📤 SEND MESSAGE - START');
    console.log('Conversation ID:', req.params.conversationId);
    console.log('Sender ID:', req.userId);
    console.log('Message:', req.body.content);

    const { conversationId } = req.params;
    const { content, messageType = 'text', mediaUrl = null } = req.body;

    if (!content) {
      return res.status(400).json({
        success: false,
        message: 'Message content is required'
      });
    }

    const conversation = await Conversation.findOne({ conversationId });
    
    if (!conversation) {
      console.log('❌ Conversation not found');
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    // Check if conversation is accepted
    if (conversation.status === 'pending' && !conversation.isAcceptedByPartner) {
      console.log('⚠️ Conversation not accepted yet');
      return res.status(403).json({
        success: false,
        message: 'Conversation is pending partner acceptance. Cannot send messages yet.'
      });
    }

    const isPartner = req.userType === 'partner';
    const senderId = req.userId;

    // Credit deduction: only user pays per message
    if (!isPartner) {
      const userDoc = await User.findById(senderId);
      if (!userDoc || userDoc.credits <= 0) {
        await Conversation.findOneAndUpdate({ conversationId }, { status: 'ended', endedAt: new Date() });
        return res.status(402).json({
          success: false,
          message: 'Insufficient credits. Chat ended.',
          creditSummary: { creditsDeducted: 0, remainingBalance: 0 }
        });
      }
      const rates = await getBillingRates(conversation.partnerId, userDoc.clientId);
      const chatCCR = rates.chatPerMessage;
      const newBalance = Math.max(0, userDoc.credits - chatCCR);
      userDoc.credits = newBalance;
      await userDoc.save();

      if (newBalance <= 0) {
        await Conversation.findOneAndUpdate({ conversationId }, { status: 'ended', endedAt: new Date() });
      }
    }

    const senderModel = isPartner ? 'Partner' : 'User';
    const receiverId = isPartner ? conversation.userId : conversation.partnerId;
    const receiverModel = isPartner ? 'User' : 'Partner';

    const message = await Message.create({
      conversationId,
      senderId,
      senderModel,
      receiverId,
      receiverModel,
      messageType,
      content,
      mediaUrl
    });

    await message.populate('senderId', 'name email profilePicture profile');

    // Update conversation to active on first message
    const updateData = {
      lastMessageAt: new Date(),
      lastMessage: {
        content,
        senderId,
        senderModel,
        createdAt: message.createdAt
      },
      $inc: {
        [`unreadCount.${isPartner ? 'user' : 'partner'}`]: 1
      }
    };

    if (conversation.status === 'accepted') {
      updateData.status = 'active';
    }

    await Conversation.findOneAndUpdate(
      { conversationId },
      updateData
    );

    console.log('✅ Message sent successfully');

    res.json({
      success: true,
      data: message
    });
  } catch (error) {
    console.error('❌ Error sending message:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to send message',
      error: error.message
    });
  }
});

// @route   PATCH /api/chat/conversations/:conversationId/read
// @desc    Mark all messages in conversation as read
// @access  Private
router.patch('/conversations/:conversationId/read', authenticate, async (req, res) => {
  try {
    console.log('👁️ MARK AS READ - START');
    const { conversationId } = req.params;

    await Message.updateMany(
      {
        conversationId,
        receiverId: req.userId,
        isRead: false
      },
      {
        isRead: true,
        readAt: new Date()
      }
    );

    const isPartner = req.userType === 'partner';
    await Conversation.findOneAndUpdate(
      { conversationId },
      {
        [`unreadCount.${isPartner ? 'partner' : 'user'}`]: 0
      }
    );

    console.log('✅ Messages marked as read');

    res.json({
      success: true,
      message: 'Messages marked as read'
    });
  } catch (error) {
    console.error('❌ Error marking messages as read:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to mark messages as read',
      error: error.message
    });
  }
});

// @route   PATCH /api/chat/conversations/:conversationId/end
// @desc    End a conversation (accepts feedback in body for single-call flow)
// @access  Private
router.patch('/conversations/:conversationId/end', authenticate, async (req, res) => {
  try {
    console.log('🔚 END CONVERSATION - START');
    const { conversationId } = req.params;
    const { stars, feedback, satisfaction } = req.body || {};

    const conversation = await Conversation.findOne({ conversationId });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    const isPartner = req.userType === 'partner';
    const hasAccess = isPartner
      ? conversation.partnerId.toString() === req.userId
      : conversation.userId.toString() === req.userId;
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const endTime = new Date();

    const totalMessages = await Message.countDocuments({
      conversationId,
      isDeleted: false
    });

    // Credit billing rates from expert pricing / client CCR settings
    const userForRates = await User.findById(conversation.userId).select('clientId').lean();
    const billingRates = await getBillingRates(conversation.partnerId, userForRates?.clientId);
    const USER_RATE_PER_MIN = billingRates.chatPerMinute;
    const PARTNER_RATE_PER_MIN = billingRates.partnerChatPerMinute;

    // If conversation was never accepted by partner (still pending),
    // treat this as a non-billable end: no credits, no summary.
    if (!conversation.isAcceptedByPartner) {
      const startTime = conversation.sessionDetails?.startTime || conversation.acceptedAt || conversation.startedAt || conversation.createdAt;

      conversation.status = conversation.status === 'pending' ? 'cancelled' : conversation.status;
      conversation.endedAt = endTime;
      conversation.sessionDetails = {
        ...(conversation.sessionDetails || {}),
        startTime,
        endTime,
        duration: 0,
        messagesCount: totalMessages,
        creditsUsed: 0,
        partnerCreditsEarned: 0,
        userRatePerMinute: USER_RATE_PER_MIN,
        partnerRatePerMinute: PARTNER_RATE_PER_MIN
      };

      await conversation.save();

      const dataNoBill = conversation.toObject ? conversation.toObject() : conversation;
      return res.json({
        success: true,
        data: {
          ...dataNoBill,
          sessionDetails: conversation.sessionDetails,
          rating: conversation.rating
        }
      });
    }

    // If there were no messages at all in an accepted conversation,
    // end it as non-billable and skip feedback/summary.
    if (totalMessages === 0) {
      const startTime = conversation.sessionDetails?.startTime || conversation.acceptedAt || conversation.startedAt || conversation.createdAt;
      conversation.status = 'ended';
      conversation.endedAt = endTime;
      conversation.sessionDetails = {
        ...(conversation.sessionDetails || {}),
        startTime,
        endTime,
        duration: 0,
        messagesCount: 0,
        creditsUsed: 0,
        partnerCreditsEarned: 0,
        userRatePerMinute: USER_RATE_PER_MIN,
        partnerRatePerMinute: PARTNER_RATE_PER_MIN
      };

      await conversation.save();

      const dataNoMsg = conversation.toObject ? conversation.toObject() : conversation;
      return res.json({
        success: true,
        data: {
          ...dataNoMsg,
          sessionDetails: conversation.sessionDetails,
          rating: conversation.rating
        }
      });
    }

    // NEW: If there are only 1–2 messages (initial greeting + first reply),
    // treat this as a free handshake – no billing.
    if (totalMessages > 0 && totalMessages <= 2) {
      const startTime = conversation.sessionDetails?.startTime || conversation.acceptedAt || conversation.startedAt || conversation.createdAt;
      conversation.status = 'ended';
      conversation.endedAt = endTime;
      conversation.sessionDetails = {
        ...(conversation.sessionDetails || {}),
        startTime,
        endTime,
        duration: 0,
        messagesCount: totalMessages,
        creditsUsed: 0,
        partnerCreditsEarned: 0,
        userRatePerMinute: USER_RATE_PER_MIN,
        partnerRatePerMinute: PARTNER_RATE_PER_MIN
      };

      await conversation.save();

      const dataHandshake = conversation.toObject ? conversation.toObject() : conversation;
      return res.json({
        success: true,
        data: {
          ...dataHandshake,
          sessionDetails: conversation.sessionDetails,
          rating: conversation.rating
        }
      });
    }

    const startTime = conversation.acceptedAt || conversation.sessionDetails?.startTime || conversation.startedAt || conversation.createdAt;
    const rawMinutes = startTime ? (endTime - new Date(startTime)) / (1000 * 60) : 0;
    // Billing: per started minute. Only accepted conversations are billable, minimum 1 minute when accepted.
    const billableMinutes = startTime
      ? Math.max(1, Math.ceil(rawMinutes))
      : 0;
    const durationMinutes = billableMinutes;

    conversation.status = 'ended';
    conversation.endedAt = endTime;

    // Compute credits using expert rates; skip user debit if already billed via WebSocket
    const user = await User.findById(conversation.userId).select('credits email profile clientId');
    const partner = await Partner.findById(conversation.partnerId).select('creditsEarnedTotal creditsEarnedBalance email name activeConversationsCount');

    const existingLedger = await ServiceCreditLedger.findOne({
      conversationId,
      serviceType: { $in: ['chat', 'voice'] }
    }).lean();
    const existingChatLedger = await ChatCreditLedger.findOne({ conversationId }).lean();
    const alreadyDebited =
      (existingLedger?.userDebited || 0) + (existingChatLedger?.userDebited || 0);

    const userPreviousBalance = user?.credits || 0;
    const intendedUserDebit = billableMinutes * USER_RATE_PER_MIN;
    const userDebited = alreadyDebited > 0
      ? 0
      : Math.min(userPreviousBalance, intendedUserDebit);
    const userNewBalance = alreadyDebited > 0
      ? userPreviousBalance
      : Math.max(0, userPreviousBalance - userDebited);

    const partnerPreviousBalance = partner?.creditsEarnedBalance || 0;
    // Partner always earns full 3 credits per billable minute
    const partnerCredited = billableMinutes * PARTNER_RATE_PER_MIN;
    const partnerNewBalance = partnerPreviousBalance + partnerCredited;
    const partnerNewTotal = (partner?.creditsEarnedTotal || 0) + partnerCredited;

    if (user) {
      user.credits = userNewBalance;
      await user.save();
    }
    if (partner) {
      partner.creditsEarnedBalance = partnerNewBalance;
      partner.creditsEarnedTotal = partnerNewTotal;
      // Decrease active conversations count when conversation truly ends
      if (partner.activeConversationsCount > 0) {
        partner.activeConversationsCount -= 1;
        await partner.updateBusyStatus();
      } else {
        await partner.updateBusyStatus();
      }
    }

    conversation.sessionDetails = {
      duration: durationMinutes,
      messagesCount: totalMessages,
      startTime,
      endTime,
      creditsUsed: userDebited,
      partnerCreditsEarned: partnerCredited,
      userRatePerMinute: USER_RATE_PER_MIN,
      partnerRatePerMinute: PARTNER_RATE_PER_MIN
    };

    if (stars !== undefined || feedback !== undefined || satisfaction !== undefined) {
      const target = isPartner ? conversation.rating.byPartner : conversation.rating.byUser;
      if (stars !== undefined) {
        const n = Number(stars);
        if (!Number.isNaN(n) && n >= 0 && n <= 5) target.stars = n;
      }
      if (feedback !== undefined) target.feedback = String(feedback).trim() || null;
      if (satisfaction !== undefined) target.satisfaction = satisfaction || null;
      target.ratedAt = new Date();
    }

    await conversation.save();

    // Store billing ledger (fast audit)
    await ChatCreditLedger.findOneAndUpdate(
      { conversationId },
      {
        conversationId,
        userId: conversation.userId,
        partnerId: conversation.partnerId,
        billableMinutes,
        userDebited,
        partnerCredited,
        userPreviousBalance,
        userNewBalance,
        partnerPreviousBalance,
        partnerNewBalance,
        userRatePerMinute: USER_RATE_PER_MIN,
        partnerRatePerMinute: PARTNER_RATE_PER_MIN
      },
      { upsert: true, new: true }
    );

    // Unified ledger entry (chat/video)
    const serviceType = conversation.conversationType === 'video' ? 'video' : 'chat';
    await ServiceCreditLedger.findOneAndUpdate(
      { conversationId, serviceType },
      {
        conversationId,
        serviceType,
        userId: conversation.userId,
        partnerId: conversation.partnerId,
        billableMinutes,
        userDebited,
        partnerCredited,
        userPreviousBalance,
        userNewBalance,
        partnerPreviousBalance,
        partnerNewBalance,
        userRatePerMinute: USER_RATE_PER_MIN,
        partnerRatePerMinute: PARTNER_RATE_PER_MIN,
        startTime: conversation.sessionDetails?.startTime || null,
        endTime
      },
      { upsert: true, new: true }
    );

    await ConversationSession.findOneAndUpdate(
      { conversationId },
      {
        conversationId,
        partnerId: conversation.partnerId,
        userId: conversation.userId,
        startTime: conversation.sessionDetails.startTime,
        endTime,
        duration: durationMinutes,
        messagesCount: totalMessages,
        creditsUsed: conversation.sessionDetails.creditsUsed || 0,
        rating: conversation.rating
      },
      { upsert: true, new: true }
    );

    // Generate conversation summary via Gemini (topics discussed) and save to DB
    let summary = null;
    try {
      const messagesForSummary = await Message.find({ conversationId, isDeleted: false })
        .sort({ createdAt: 1 })
        .select('content senderModel')
        .lean();

      // Only attempt a summary if we have at least one real message
      if (messagesForSummary.length > 0) {
        const userDoc = await User.findById(conversation.userId).select('clientId').lean();
        const userClientId = userDoc?.clientId || null;
        summary = await generateConversationSummary(messagesForSummary, userClientId);
        if (summary) {
          conversation.sessionDetails = conversation.sessionDetails || {};
          conversation.sessionDetails.summary = summary;
          await conversation.save();
          await ConversationSession.findOneAndUpdate(
            { conversationId },
            { summary }
          );
        }
      }
    } catch (summaryErr) {
      console.warn('Conversation summary generation failed:', summaryErr.message);
    }

    const data = conversation.toObject ? conversation.toObject() : conversation;
    const sessionDetailsOut = { ...conversation.sessionDetails };
    if (summary) sessionDetailsOut.summary = summary;
    res.json({
      success: true,
      data: {
        ...data,
        sessionDetails: sessionDetailsOut,
        rating: conversation.rating,
        creditSummary: {
          creditsUsed: userDebited,
          remainingBalance: userNewBalance
        }
      }
    });
  } catch (error) {
    console.error('❌ Error ending conversation:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to end conversation',
      error: error.message
    });
  }
});

// @route   PATCH /api/chat/conversations/:conversationId/feedback
// @desc    Submit rating/feedback for a conversation (user or partner)
// @access  Private
router.patch('/conversations/:conversationId/feedback', authenticate, async (req, res) => {
  try {
    console.log('📝 FEEDBACK - START');
    const { conversationId } = req.params;
    const { stars, feedback, satisfaction } = req.body;

    const conversation = await Conversation.findOne({ conversationId });
    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    const isPartner = req.userType === 'partner';

    // Ensure the caller belongs to this conversation
    const hasAccess = isPartner
      ? conversation.partnerId.toString() === req.userId
      : conversation.userId.toString() === req.userId;

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const target = isPartner ? conversation.rating.byPartner : conversation.rating.byUser;
    const previousStars = target.stars;

    if (stars !== undefined) {
      const n = Number(stars);
      if (!Number.isNaN(n) && n >= 0 && n <= 5) {
        target.stars = n;
      }
    }

    if (feedback !== undefined) {
      target.feedback = feedback;
    }

    if (satisfaction !== undefined) {
      target.satisfaction = satisfaction;
    }

    target.ratedAt = new Date();

    await conversation.save();

    // If user rated partner for the first time, update partner aggregate rating
    if (!isPartner && stars !== undefined) {
      const n = Number(stars);
      if (!Number.isNaN(n) && n >= 0 && n <= 5 && (previousStars == null)) {
        const partner = await Partner.findById(conversation.partnerId);
        if (partner) {
          const oldTotal = partner.totalRatings || 0;
          const oldAvg = partner.rating || 0;
          const newTotal = oldTotal + 1;
          const newAvg = newTotal > 0 ? ((oldAvg * oldTotal + n) / newTotal) : n;
          partner.totalRatings = newTotal;
          partner.rating = newAvg;
          await partner.save();
        }
      }
    }

    res.json({
      success: true,
      data: conversation.rating
    });
  } catch (error) {
    console.error('❌ Error saving feedback:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to save feedback',
      error: error.message
    });
  }
});

// @route   PATCH /api/chat/conversations/:conversationId/voice-recording
// @desc    Attach uploaded voice call recording (S3 key/url) to conversation metadata
// @access  Private
router.patch('/conversations/:conversationId/voice-recording', authenticate, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { audioKey, audioUrl } = req.body || {};

    if (!audioKey) {
      return res.status(400).json({
        success: false,
        message: 'audioKey is required'
      });
    }

    const conversation = await Conversation.findOne({ conversationId });
    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    const isPartner = req.userType === 'partner';
    const hasAccess = isPartner
      ? conversation.partnerId.toString() === req.userId
      : conversation.userId.toString() === req.userId;
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const roleKey = isPartner ? 'partner' : 'user';

    conversation.metadata = conversation.metadata || {};
    const existing = conversation.metadata.voiceRecordings || {};
    existing[roleKey] = {
      key: audioKey,
      url: audioUrl || null,
      uploadedAt: new Date()
    };
    conversation.metadata.voiceRecordings = existing;

    await conversation.save();

    res.json({
      success: true,
      message: 'Voice recording attached',
      data: conversation.metadata.voiceRecordings
    });
  } catch (error) {
    console.error('❌ Error saving voice recording:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to save voice recording',
      error: error.message
    });
  }
});

// @route   POST /api/chat/voice/recording/upload-url
// @desc    Generate a presigned S3 upload URL for a voice call recording
// @access  Private
router.post('/voice/recording/upload-url', authenticate, async (req, res) => {
  try {
    const { conversationId, role, fileExt, contentType } = req.body || {};
    if (!conversationId) {
      return res.status(400).json({
        success: false,
        message: 'conversationId is required'
      });
    }

    const conversation = await Conversation.findOne({ conversationId });
    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    const isPartner = req.userType === 'partner';
    const hasAccess = isPartner
      ? conversation.partnerId.toString() === req.userId
      : conversation.userId.toString() === req.userId;
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const effectiveRole = role || (isPartner ? 'partner' : 'user');

    // IMPORTANT: iOS AVPlayer is strict about container/codec.
    // For maximum cross-platform compatibility, prefer AAC in M4A (audio/mp4).
    // Client can request file type using { fileExt, contentType }.
    const normalizedExt = String(fileExt || '').toLowerCase().replace('.', '');
    const desiredExt = normalizedExt || 'm4a';

    const allowed = new Map([
      ['m4a', 'audio/mp4'],  // AAC in M4A (best iOS compatibility)
      ['mp3', 'audio/mpeg'], // MP3
      ['webm', 'audio/webm'] // Only if your player supports it on iOS (often not)
    ]);

    const effectiveContentType = (typeof contentType === 'string' && contentType.trim())
      ? contentType.trim()
      : (allowed.get(desiredExt) || 'audio/mp4');

    // Force ext/content-type pairing if client sends mismatched values
    const finalExt = allowed.has(desiredExt) ? desiredExt : 'm4a';
    const finalContentType = allowed.get(finalExt) || 'audio/mp4';

    const fileName = `voice-call-${conversationId}-${effectiveRole}-${Date.now()}.${finalExt}`;
    const folder = `voice-calls/${conversationId}`;

    const { uploadUrl, key, fileUrl } = await generateUploadUrl(fileName, finalContentType, folder);

    res.json({
      success: true,
      data: {
        uploadUrl,
        key,
        fileUrl,
        fileExt: finalExt,
        contentType: finalContentType
      }
    });
  } catch (error) {
    console.error('❌ Error generating voice recording upload URL:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to generate upload URL for voice recording',
      error: error.message
    });
  }
});

// ==================== VOICE CALL LOG HISTORY ====================

async function enrichVoiceCallLogItems(items) {
  const userIds = [...new Set(items.map((i) => i.userId?.toString()).filter(Boolean))];
  const partnerIds = [...new Set(items.map((i) => i.partnerId?.toString()).filter(Boolean))];

  const [users, partners] = await Promise.all([
    userIds.length
      ? User.find({ _id: { $in: userIds } }).select('email profile profileImage name').lean()
      : [],
    partnerIds.length
      ? Partner.find({ _id: { $in: partnerIds } }).select('name email profilePicture').lean()
      : []
  ]);

  const userMap = new Map(users.map((u) => [u._id.toString(), u]));
  const partnerMap = new Map(partners.map((p) => [p._id.toString(), p]));

  return items.map((item) => {
    const user = userMap.get(item.userId?.toString());
    const partner = partnerMap.get(item.partnerId?.toString());
    const userName = getUserDisplayName(user) || item.from?.name || 'User';
    const partnerName = partner?.name || item.to?.name || 'Expert';

    const from = { ...(item.from || {}) };
    const to = { ...(item.to || {}) };

    if (from.type === 'user' && user) {
      from.name = getUserDisplayName(user);
      from.email = user.email;
    } else if (from.type === 'partner' && partner) {
      from.name = partner.name || partner.email;
      from.email = partner.email;
    }

    if (to.type === 'user' && user) {
      to.name = getUserDisplayName(user);
      to.email = user.email;
    } else if (to.type === 'partner' && partner) {
      to.name = partner.name || partner.email;
      to.email = partner.email;
    }

    return {
      ...item,
      from,
      to,
      userName,
      partnerName,
      user: user ? { _id: user._id, email: user.email, profile: user.profile, profileImage: user.profileImage } : null,
      partner: partner ? { _id: partner._id, name: partner.name, email: partner.email, profilePicture: partner.profilePicture } : null
    };
  });
}

// @route   GET /api/chat/voice/calls/history/user
// @desc    Get paginated voice call logs for current user
// @access  Private (User)
router.get('/voice/calls/history/user', authenticate, async (req, res) => {
  try {
    if (req.userType !== 'user') {
      return res.status(403).json({ success: false, message: 'Only users can access this endpoint' });
    }

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      VoiceCallLog.find({ userId: req.userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      VoiceCallLog.countDocuments({ userId: req.userId })
    ]);

    // Join recording keys (if any) from Conversation
    const convIds = items.map((i) => i.conversationId).filter(Boolean);
    const convDocs = await Conversation.find({ conversationId: { $in: convIds } })
      .select('conversationId metadata.voiceRecordings')
      .lean();
    const convMap = new Map(convDocs.map((c) => [c.conversationId, c]));

    const signVoiceRecordings = async (voiceRecordings) => {
      if (!voiceRecordings) return null;
      const out = { ...voiceRecordings };

      for (const side of ['user', 'partner']) {
        const rec = out?.[side];
        if (!rec || !rec.key) continue;
        try {
          const signedUrl = await getPresignedUrl(rec.key);
          out[side] = {
            ...rec,
            // Provide a directly playable URL (raw S3 URLs can be AccessDenied)
            signedUrl,
            // Avoid encouraging clients to open the raw URL
            url: null
          };
        } catch (e) {
          out[side] = { ...rec, signedUrl: null };
        }
      }

      return out;
    };

    const data = await Promise.all(
      (await enrichVoiceCallLogItems(items)).map(async (i) => {
        const voiceRecordings = convMap.get(i.conversationId)?.metadata?.voiceRecordings || null;
        const signed = await signVoiceRecordings(voiceRecordings);
        return { ...i, voiceRecordings: signed };
      })
    );

    res.json({
      success: true,
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('❌ Error fetching user voice call logs:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch voice call logs', error: error.message });
  }
});

// @route   GET /api/chat/voice/calls/history/partner
// @desc    Get paginated voice call logs for current partner
// @access  Private (Partner)
router.get('/voice/calls/history/partner', authenticate, async (req, res) => {
  try {
    if (req.userType !== 'partner') {
      return res.status(403).json({ success: false, message: 'Only partners can access this endpoint' });
    }

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      VoiceCallLog.find({ partnerId: req.userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      VoiceCallLog.countDocuments({ partnerId: req.userId })
    ]);

    const convIds = items.map((i) => i.conversationId).filter(Boolean);
    const convDocs = await Conversation.find({ conversationId: { $in: convIds } })
      .select('conversationId metadata.voiceRecordings')
      .lean();
    const convMap = new Map(convDocs.map((c) => [c.conversationId, c]));

    const signVoiceRecordings = async (voiceRecordings) => {
      if (!voiceRecordings) return null;
      const out = { ...voiceRecordings };

      for (const side of ['user', 'partner']) {
        const rec = out?.[side];
        if (!rec || !rec.key) continue;
        try {
          const signedUrl = await getPresignedUrl(rec.key);
          out[side] = {
            ...rec,
            signedUrl,
            url: null
          };
        } catch (e) {
          out[side] = { ...rec, signedUrl: null };
        }
      }

      return out;
    };

    const data = await Promise.all(
      (await enrichVoiceCallLogItems(items)).map(async (i) => {
        const voiceRecordings = convMap.get(i.conversationId)?.metadata?.voiceRecordings || null;
        const signed = await signVoiceRecordings(voiceRecordings);
        return { ...i, voiceRecordings: signed };
      })
    );

    res.json({
      success: true,
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('❌ Error fetching partner voice call logs:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch voice call logs', error: error.message });
  }
});

// @route   GET /api/chat/unread-count
// @desc    Get total unread message count
// @access  Private
router.get('/unread-count', authenticate, async (req, res) => {
  try {
    console.log('🔔 GET UNREAD COUNT - START');

    const isPartner = req.userType === 'partner';
    const query = isPartner 
      ? { partnerId: req.userId }
      : { userId: req.userId };

    const conversations = await Conversation.find(query);
    
    const totalUnread = conversations.reduce((sum, conv) => {
      return sum + (isPartner ? conv.unreadCount.partner : conv.unreadCount.user);
    }, 0);

    // For partners, also include pending request count
    let pendingRequests = 0;
    if (isPartner) {
      pendingRequests = await Conversation.countDocuments({
        partnerId: req.userId,
        status: 'pending',
        isAcceptedByPartner: false
      });
    }

    console.log('✅ Unread count:', totalUnread, 'Pending requests:', pendingRequests);

    res.json({
      success: true,
      data: {
        totalUnread,
        conversationCount: conversations.length,
        pendingRequests: isPartner ? pendingRequests : 0
      }
    });
  } catch (error) {
    console.error('❌ Error fetching unread count:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch unread count',
      error: error.message
    });
  }
});

// @route   GET /api/chat/credits/history/user
// @desc    Get paginated chat credit history for current user
// @access  Private (User)
router.get('/credits/history/user', authenticate, async (req, res) => {
  try {
    if (req.userType !== 'user') {
      return res.status(403).json({ success: false, message: 'Only users can access this endpoint' });
    }
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const skip = (page - 1) * limit;

    // Prefer unified ledger; fall back to legacy chat-only ledger if empty
    const unifiedCount = await ServiceCreditLedger.countDocuments({ userId: req.userId });
    const useUnified = unifiedCount > 0;

    const [items, total] = await Promise.all([
      useUnified
        ? ServiceCreditLedger.find({ userId: req.userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('partnerId', 'name email profilePicture')
            .lean()
        : ChatCreditLedger.find({ userId: req.userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('partnerId', 'name email profilePicture')
            .lean(),
      useUnified
        ? ServiceCreditLedger.countDocuments({ userId: req.userId })
        : ChatCreditLedger.countDocuments({ userId: req.userId })
    ]);

    // Join conversation recordings (keys only) so UI can play via presigned-url
    const convIds = items.map((i) => i.conversationId).filter(Boolean);
    const convDocs = await Conversation.find({ conversationId: { $in: convIds } })
      .select('conversationId metadata.voiceRecordings')
      .lean();
    const convMap = new Map(convDocs.map((c) => [c.conversationId, c]));

    const data = items.map((entry) => {
      const serviceType = entry.serviceType || 'chat';
      const conv = convMap.get(entry.conversationId);
      const recordings = conv?.metadata?.voiceRecordings || null;

      return {
        conversationId: entry.conversationId,
        serviceType,
        billableMinutes: entry.billableMinutes,
        creditsUsed: entry.userDebited,
        createdAt: entry.createdAt,
        partner: entry.partnerId,
        voiceRecordings: recordings
      };
    });

    res.json({
      success: true,
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('❌ Error fetching user credit history:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch credit history',
      error: error.message
    });
  }
});

// @route   GET /api/chat/credits/history/partner
// @desc    Get paginated chat earnings history for current partner
// @access  Private (Partner)
router.get('/credits/history/partner', authenticate, async (req, res) => {
  try {
    if (req.userType !== 'partner') {
      return res.status(403).json({ success: false, message: 'Only partners can access this endpoint' });
    }
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const skip = (page - 1) * limit;

    const unifiedCount = await ServiceCreditLedger.countDocuments({ partnerId: req.userId });
    const useUnified = unifiedCount > 0;

    const [items, total] = await Promise.all([
      useUnified
        ? ServiceCreditLedger.find({ partnerId: req.userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('userId', 'email profile profileImage')
            .lean()
        : ChatCreditLedger.find({ partnerId: req.userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('userId', 'email profile profileImage')
            .lean(),
      useUnified
        ? ServiceCreditLedger.countDocuments({ partnerId: req.userId })
        : ChatCreditLedger.countDocuments({ partnerId: req.userId })
    ]);

    const convIds = items.map((i) => i.conversationId).filter(Boolean);
    const convDocs = await Conversation.find({ conversationId: { $in: convIds } })
      .select('conversationId metadata.voiceRecordings')
      .lean();
    const convMap = new Map(convDocs.map((c) => [c.conversationId, c]));

    const data = items.map((entry) => {
      const serviceType = entry.serviceType || 'chat';
      const conv = convMap.get(entry.conversationId);
      const recordings = conv?.metadata?.voiceRecordings || null;

      return {
        conversationId: entry.conversationId,
        serviceType,
        billableMinutes: entry.billableMinutes,
        creditsEarned: entry.partnerCredited,
        createdAt: entry.createdAt,
        user: entry.userId,
        voiceRecordings: recordings
      };
    });

    res.json({
      success: true,
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('❌ Error fetching partner credit history:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch credit history',
      error: error.message
    });
  }
});

// @route   GET /api/chat/conversation/:conversationId/astrology
// @desc    Get user's astrology data for a conversation (Partner only)
// @access  Private (Partner only)
router.get('/conversation/:conversationId/astrology', authenticate, async (req, res) => {
  try {
    console.log('🌟 GET ASTROLOGY DATA - START');

    if (req.userType !== 'partner') {
      return res.status(403).json({
        success: false,
        message: 'Only partners can view astrology data'
      });
    }

    const { conversationId } = req.params;

    const conversation = await Conversation.findOne({ conversationId })
      .populate('userId', 'email profile profileImage');

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found'
      });
    }

    if (conversation.partnerId.toString() !== req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    console.log('✅ Astrology data retrieved');

    res.json({
      success: true,
      data: {
        conversationId: conversation.conversationId,
        userAstrology: conversation.userAstrologyData,
        user: conversation.userId
      }
    });
  } catch (error) {
    console.error('❌ Error fetching astrology data:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch astrology data',
      error: error.message
    });
  }
});

// @route   GET /api/chat/conversation/:conversationId/complete-user-details
// @desc    Get complete user data: astrology, numerology, doshas, remedies, panchang (Partner only)
// @access  Private (Partner only)
router.get('/conversation/:conversationId/complete-user-details', authenticate, async (req, res) => {
  try {
    if (req.userType !== 'partner') {
      return res.status(403).json({ success: false, message: 'Only partners can view this data' });
    }

    const { conversationId } = req.params;
    const conversation = await Conversation.findOne({ conversationId })
      .populate('userId', 'email profile profileImage clientId liveLocation');

    if (!conversation || conversation.partnerId.toString() !== req.userId) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }

    const user = await User.findById(conversation.userId._id)
      .select('-password')
      .populate('clientId', 'clientId businessName')
      .lean();

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const result = {
      user: { _id: user._id, email: user.email, profile: user.profile, profileImage: user.profileImage },
      birthDetails: conversation.userAstrologyData || user.profile,
      astrology: null,
      numerology: null,
      doshas: null,
      dashas: null,
      remedies: null,
      panchang: null,
      errors: {}
    };

    const hasBirthDetails = user.profile?.dob && user.profile?.timeOfBirth;
    const hasLocation = (user.liveLocation?.latitude != null) && (user.liveLocation?.longitude != null);

    if (hasBirthDetails) {
      const profileWithLocation = {
        ...user.profile,
        latitude: user.liveLocation?.latitude ?? user.profile?.latitude,
        longitude: user.liveLocation?.longitude ?? user.profile?.longitude
      };

      try {
        result.astrology = await astrologyService.getCompleteAstrologyData(user._id, profileWithLocation, false);
      } catch (e) {
        result.errors.astrology = e.message;
      }

      try {
        const doshaData = await doshaService.getAllDoshas(user, { forceRefresh: false });
        result.doshas = doshaData.doshas;
        result.dashas = doshaData.dashas;
      } catch (e) {
        result.errors.doshas = e.message;
      }

      try {
        result.remedies = (await remedyService.getRemedies(user, { forceRefresh: false })).remedies;
      } catch (e) {
        result.errors.remedies = e.message;
      }
    }

    const userName = user.profile?.name || user.profile?.firstName || user.email;
    if (userName) {
      try {
        const today = new Date();
        const date = { day: today.getDate(), month: today.getMonth() + 1, year: today.getFullYear() };
        const numData = await numerologyService.getNumerologyData(user._id, date, userName, user.profile?.dob, false);
        result.numerology = numData.data;
      } catch (e) {
        result.errors.numerology = e.message;
      }
    }

    if (hasLocation) {
      try {
        const today = new Date();
        result.panchang = await panchangService.getCompletePanchangData(
          user._id,
          today.toISOString(),
          user.liveLocation.latitude,
          user.liveLocation.longitude,
          false,
          user.profile || null
        );
      } catch (e) {
        result.errors.panchang = e.message;
      }
    }

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('❌ Complete user details error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user details',
      error: error.message
    });
  }
});

export default router;