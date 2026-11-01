import express from 'express';
import mongoose from 'mongoose';
import { authenticate } from '../middleware/authMiddleware.js';
import notificationService from '../services/notificationService.js';
import User from '../models/User.js';
import ClientNotificationGroup from '../models/ClientNotificationGroup.js';
import ClientNotificationCampaign from '../models/ClientNotificationCampaign.js';
import { sendClientNotificationCampaignNow } from '../services/clientNotificationScheduler.js';

const isObjectId = (v) => mongoose.Types.ObjectId.isValid(v) && String(v).length === 24;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 500;
const MAX_CAMPAIGNS_PAGE = 100;

// The URL is opened by the app when the notification is tapped: allow web links only
const isHttpUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

const router = express.Router();

// GET /api/notifications - Get user notifications
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    const limit = parseInt(req.query.limit) || 20;
    const skip = parseInt(req.query.skip) || 0;

    const result = await notificationService.getUserNotifications(userId, limit, skip);

    res.json({
      success: true,
      data: result.notifications,
      unreadCount: result.unreadCount,
      total: result.notifications.length
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch notifications',
      error: error.message
    });
  }
});

// PUT /api/notifications/:id/read - Mark notification as read
router.put('/:id/read', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    const notificationId = req.params.id;

    const notification = await notificationService.markAsRead(notificationId, userId);

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    res.json({
      success: true,
      message: 'Notification marked as read',
      data: notification
    });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark notification as read',
      error: error.message
    });
  }
});

// PUT /api/notifications/read-all - Mark all notifications as read
router.put('/read-all', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;

    await notificationService.markAllAsRead(userId);

    res.json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark all notifications as read',
      error: error.message
    });
  }
});

// GET /api/notifications/unread-count - Get unread count
router.get('/unread-count', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    const Notification = (await import('../models/Notification.js')).default;
    
    const unreadCount = await Notification.countDocuments({ userId, isRead: false });

    res.json({
      success: true,
      data: unreadCount
    });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch unread count',
      error: error.message
    });
  }
});

// ===== Client Notification Sender APIs =====

// GET /api/notifications/client/users - users for current client
router.get('/client/users', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res.status(403).json({ success: false, message: 'Only client can access this endpoint' });
    }

    const users = await User.find({ clientId: req.user._id, isActive: true })
      .select('_id email profile.name mobile createdAt')
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ success: true, data: users });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch client users',
      error: error.message
    });
  }
});

// GET /api/notifications/client/groups - list client groups
router.get('/client/groups', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res.status(403).json({ success: false, message: 'Only client can access this endpoint' });
    }

    const groups = await ClientNotificationGroup.find({ clientId: req.user._id })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ success: true, data: groups });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch notification groups',
      error: error.message
    });
  }
});

// POST /api/notifications/client/groups - create group
router.post('/client/groups', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res.status(403).json({ success: false, message: 'Only client can access this endpoint' });
    }

    const { name, description = '', userIds = [] } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Group name is required' });
    }
    if (String(name).trim().length > MAX_NAME) {
      return res.status(400).json({ success: false, message: `Group name must be ${MAX_NAME} characters or less` });
    }
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Select at least one user for the group' });
    }
    if (!userIds.every(isObjectId)) {
      return res.status(400).json({ success: false, message: 'userIds contains an invalid id' });
    }

    const validUsers = await User.find({
      _id: { $in: userIds },
      clientId: req.user._id,
      isActive: true
    }).select('_id');

    if (validUsers.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid users found for this client' });
    }

    const group = await ClientNotificationGroup.create({
      clientId: req.user._id,
      name: String(name).trim(),
      description: String(description || '').trim(),
      userIds: validUsers.map((u) => u._id),
      createdBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      message: 'Notification group created successfully',
      data: group.toObject()
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to create notification group',
      error: error.message
    });
  }
});

// GET /api/notifications/client/campaigns - list campaigns
router.get('/client/campaigns', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res.status(403).json({ success: false, message: 'Only client can access this endpoint' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), MAX_CAMPAIGNS_PAGE);

    const [campaigns, countRows] = await Promise.all([
      ClientNotificationCampaign.find({ clientId: req.user._id })
        .select('-userIds')   // can be thousands of ids per row; the table only needs totalRecipients
        .populate('groupId', '_id name')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      ClientNotificationCampaign.aggregate([
        { $match: { clientId: req.user._id } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ])
    ]);

    // Exact totals for the stat cards, independent of how many rows are returned
    const counts = { sent: 0, scheduled: 0, sending: 0, failed: 0 };
    for (const row of countRows) counts[row._id] = row.count;

    return res.json({ success: true, data: campaigns, counts });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch notification campaigns',
      error: error.message
    });
  }
});

// POST /api/notifications/client/campaigns - create/send campaign
router.post('/client/campaigns', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res.status(403).json({ success: false, message: 'Only client can access this endpoint' });
    }

    const {
      groupId = null,
      userIds = [],
      name,
      description,
      url = '',
      postType = 'immediate',
      scheduledFor = null
    } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Notification name is required' });
    }
    if (!description || !String(description).trim()) {
      return res.status(400).json({ success: false, message: 'Notification description is required' });
    }
    if (!['immediate', 'scheduled'].includes(postType)) {
      return res.status(400).json({ success: false, message: 'postType must be immediate or scheduled' });
    }

    if (String(name).trim().length > MAX_NAME) {
      return res.status(400).json({ success: false, message: `Notification name must be ${MAX_NAME} characters or less` });
    }
    if (String(description).trim().length > MAX_DESCRIPTION) {
      return res.status(400).json({ success: false, message: `Description must be ${MAX_DESCRIPTION} characters or less` });
    }
    if (url && !isHttpUrl(String(url).trim())) {
      return res.status(400).json({ success: false, message: 'URL must start with http:// or https://' });
    }
    if (groupId && !isObjectId(groupId)) {
      return res.status(400).json({ success: false, message: 'Invalid group' });
    }
    if (!groupId && !(Array.isArray(userIds) && userIds.every(isObjectId))) {
      return res.status(400).json({ success: false, message: 'userIds contains an invalid id' });
    }

    let targetUserIds = [];

    if (groupId) {
      const group = await ClientNotificationGroup.findOne({ _id: groupId, clientId: req.user._id }).lean();
      if (!group) {
        return res.status(404).json({ success: false, message: 'Group not found for this client' });
      }
      targetUserIds = group.userIds || [];
    } else {
      targetUserIds = Array.isArray(userIds) ? userIds : [];
    }

    if (!targetUserIds.length) {
      return res.status(400).json({ success: false, message: 'Please select users or choose a group' });
    }

    const validUsers = await User.find({
      _id: { $in: targetUserIds },
      clientId: req.user._id,
      isActive: true
    }).select('_id');

    if (!validUsers.length) {
      return res.status(400).json({ success: false, message: 'No valid users found for this client' });
    }

    let scheduleDate = null;
    if (postType === 'scheduled') {
      if (!scheduledFor) {
        return res.status(400).json({ success: false, message: 'Scheduled date and time is required' });
      }
      // Expect an ISO string with timezone (the dashboard sends UTC). A bare "2026-11-01T22:00" would be read in
      // the server's timezone and fire hours early/late for the person who scheduled it.
      scheduleDate = new Date(scheduledFor);
      if (Number.isNaN(scheduleDate.getTime())) {
        return res.status(400).json({ success: false, message: 'Invalid scheduled date and time' });
      }
      if (scheduleDate.getTime() < Date.now() - 60 * 1000) {
        return res.status(400).json({ success: false, message: 'Scheduled time must be in the future' });
      }
    }

    const campaign = await ClientNotificationCampaign.create({
      clientId: req.user._id,
      groupId: groupId || null,
      userIds: validUsers.map((u) => u._id),
      name: String(name).trim(),
      description: String(description).trim(),
      url: String(url || '').trim(),
      postType,
      scheduledFor: scheduleDate,
      status: 'scheduled',
      totalRecipients: validUsers.length,
      createdBy: req.user._id
    });

    if (postType === 'immediate') {
      // Send only this campaign (atomically claimed). Before, this ran every client's due campaigns inside the
      // request, and silently did nothing if the 30s scheduler happened to be running, leaving it "scheduled".
      await sendClientNotificationCampaignNow(campaign._id);
    }

    const latestCampaign = await ClientNotificationCampaign.findById(campaign._id)
      .select('-userIds')
      .populate('groupId', '_id name')
      .lean();

    const delivered = latestCampaign?.status === 'sent';
    return res.status(201).json({
      success: true,
      message: postType === 'immediate'
        ? (delivered ? 'Notification posted successfully' : 'Notification could not be delivered')
        : 'Notification scheduled successfully',
      data: latestCampaign
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to create notification campaign',
      error: error.message
    });
  }
});

export default router;
