import express from 'express';
import UserSankalp from '../models/UserSankalp.js';
import Sankalp from '../models/Sankalp.js';
import User from '../models/User.js';
import { authenticate } from '../middleware/auth.js';
import notificationService from '../services/notificationService.js';

const router = express.Router();

// GET /api/user-sankalp - Get all user sankalpas (same as my-sankalpas)
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    const { status } = req.query;

    const query = { userId };
    if (status) query.status = status;

    const userSankalpas = await UserSankalp.find(query)
      .populate({ path: 'sankalpId', populate: { path: 'clientId', select: 'clientId' } })
      .populate({ path: 'clientId', select: 'clientId' })
      .sort({ createdAt: -1 });

    const { getPresignedUrl } = await import('../utils/storage.js');
    const sankalpasWithUrls = await Promise.all(
      userSankalpas.map(async (us) => {
        const obj = us.toObject();
        
        // Skip if sankalp was deleted
        if (!obj.sankalpId) {
          return null;
        }
        
        if (obj.sankalpId?.bannerImageKey || obj.sankalpId?.bannerImage) {
          try {
            const imageKey = obj.sankalpId.bannerImageKey || obj.sankalpId.bannerImage;
            if (imageKey) {
              obj.sankalpId.bannerImage = await getPresignedUrl(imageKey);
            }
          } catch (error) {
            console.error('Error generating presigned URL:', error);
          }
        }
        if (obj.clientId && typeof obj.clientId === 'object' && obj.clientId.clientId) {
          obj.clientId = obj.clientId.clientId;
        }
        if (obj.sankalpId?.clientId && typeof obj.sankalpId.clientId === 'object' && obj.sankalpId.clientId.clientId) {
          obj.sankalpId.clientId = obj.sankalpId.clientId.clientId;
        }
        return obj;
      })
    );

    // Filter out null entries (deleted sankalpas)
    const validSankalpas = sankalpasWithUrls.filter(s => s !== null);

    res.json({
      success: true,
      data: validSankalpas,
      count: validSankalpas.length
    });
  } catch (error) {
    console.error('Error fetching sankalpas:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch sankalpas', error: error.message });
  }
});

// POST /api/user-sankalp/join - Join a sankalp
router.post('/join', authenticate, async (req, res) => {
  try {
    const { sankalpId, customDays, reminderTime } = req.body;
    const userId = req.user._id;

    if (!sankalpId) {
      return res.status(400).json({ success: false, message: 'Sankalp ID required' });
    }

    // Validate custom days
    if (customDays && (customDays < 1 || customDays > 365)) {
      return res.status(400).json({ success: false, message: 'Custom days must be between 1 and 365' });
    }

    // Check if sankalp exists
    const sankalp = await Sankalp.findById(sankalpId);
    if (!sankalp) {
      return res.status(404).json({ success: false, message: 'Sankalp not found' });
    }

    // Check if already joined (any status - user can only join once)
    const existing = await UserSankalp.findOne({ userId, sankalpId });
    if (existing) {
      // Return 200 with already joined status instead of 400 error
      const populated = await existing.populate([
        { path: 'sankalpId', populate: { path: 'clientId', select: 'clientId' } },
        { path: 'clientId', select: 'clientId' }
      ]);
      const response = populated.toObject();
      
      // Generate presigned URL for banner
      if (response.sankalpId?.bannerImageKey) {
        try {
          const { getPresignedUrl } = await import('../utils/storage.js');
          response.sankalpId.bannerImage = await getPresignedUrl(response.sankalpId.bannerImageKey);
        } catch (error) {
          console.error('Error generating presigned URL:', error);
        }
      }
      
      // Format clientIds
      if (response.clientId && typeof response.clientId === 'object' && response.clientId.clientId) {
        response.clientId = response.clientId.clientId;
      }
      if (response.sankalpId?.clientId && typeof response.sankalpId.clientId === 'object' && response.sankalpId.clientId.clientId) {
        response.sankalpId.clientId = response.sankalpId.clientId.clientId;
      }
      
      return res.status(200).json({
        success: true,
        alreadyJoined: true,
        message: 'Already joined this sankalp',
        data: response
      });
    }

    // Use custom days if provided, otherwise use sankalp's default
    const totalDays = customDays || sankalp.totalDays;

    // Calculate end date
    const startDate = new Date();
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + totalDays);

    // Initialize daily reports
    const dailyReports = [];
    for (let i = 0; i < totalDays; i++) {
      const reportDate = new Date(startDate);
      reportDate.setDate(reportDate.getDate() + i);
      dailyReports.push({
        day: i + 1,
        date: reportDate,
        status: 'not_reported'
      });
    }

    // Create user sankalp
    const userSankalp = new UserSankalp({
      userId,
      sankalpId,
      clientId: sankalp.clientId,
      startDate,
      endDate,
      totalDays,
      customDays: customDays || undefined,
      reminderTime: reminderTime || undefined,
      dailyReports
    });

    await userSankalp.save();

    // Update participants count AFTER successful save
    await Sankalp.findByIdAndUpdate(sankalpId, { $inc: { participantsCount: 1 } });

    // Populate and format response
    const populated = await userSankalp.populate([
      { path: 'sankalpId', populate: { path: 'clientId', select: 'clientId' } },
      { path: 'clientId', select: 'clientId' }
    ]);
    const response = populated.toObject();
    
    // Generate presigned URL for banner
    if (response.sankalpId?.bannerImageKey) {
      try {
        const { getPresignedUrl } = await import('../utils/storage.js');
        response.sankalpId.bannerImage = await getPresignedUrl(response.sankalpId.bannerImageKey);
      } catch (error) {
        console.error('Error generating presigned URL:', error);
      }
    }
    
    // Format root clientId
    if (response.clientId && typeof response.clientId === 'object' && response.clientId.clientId) {
      response.clientId = response.clientId.clientId;
    }
    
    // Format nested sankalpId.clientId
    if (response.sankalpId?.clientId && typeof response.sankalpId.clientId === 'object' && response.sankalpId.clientId.clientId) {
      response.sankalpId.clientId = response.sankalpId.clientId.clientId;
    }

    res.status(201).json({
      success: true,
      message: 'Successfully joined sankalp',
      data: response
    });
  } catch (error) {
    console.error('Error joining sankalp:', error);
    res.status(500).json({ success: false, message: 'Failed to join sankalp', error: error.message });
  }
});

// GET /api/user-sankalp/my-sankalpas - Get user's sankalpas
router.get('/my-sankalpas', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    const { status } = req.query;

    const query = { userId };
    if (status) query.status = status;

    const userSankalpas = await UserSankalp.find(query)
      .populate({ path: 'sankalpId', populate: { path: 'clientId', select: 'clientId' } })
      .populate({ path: 'clientId', select: 'clientId' })
      .sort({ createdAt: -1 });

    // Generate presigned URLs for banners
    const { getPresignedUrl } = await import('../utils/storage.js');
    const sankalpasWithUrls = await Promise.all(
      userSankalpas.map(async (us) => {
        const obj = us.toObject();
        
        // Skip if sankalp was deleted
        if (!obj.sankalpId) {
          return null;
        }
        
        if (obj.sankalpId?.bannerImageKey || obj.sankalpId?.bannerImage) {
          try {
            const imageKey = obj.sankalpId.bannerImageKey || obj.sankalpId.bannerImage;
            if (imageKey) {
              obj.sankalpId.bannerImage = await getPresignedUrl(imageKey);
            }
          } catch (error) {
            console.error('Error generating presigned URL:', error);
          }
        }
        // Format root clientId
        if (obj.clientId && typeof obj.clientId === 'object' && obj.clientId.clientId) {
          obj.clientId = obj.clientId.clientId;
        }
        // Format nested sankalpId.clientId
        if (obj.sankalpId?.clientId && typeof obj.sankalpId.clientId === 'object' && obj.sankalpId.clientId.clientId) {
          obj.sankalpId.clientId = obj.sankalpId.clientId.clientId;
        }
        return obj;
      })
    );

    // Filter out null entries (deleted sankalpas)
    const validSankalpas = sankalpasWithUrls.filter(s => s !== null);

    res.json({
      success: true,
      data: validSankalpas,
      count: validSankalpas.length
    });
  } catch (error) {
    console.error('Error fetching my sankalpas:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch sankalpas', error: error.message });
  }
});

// PATCH /api/user-sankalp/:id/reminder-time - Update reminder time
router.patch('/:id/reminder-time', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    const { reminderTime } = req.body;

    if (!reminderTime || !/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(reminderTime)) {
      return res.status(400).json({ success: false, message: 'Valid reminderTime required (HH:MM format)' });
    }

    const userSankalp = await UserSankalp.findOne({ _id: req.params.id, userId });

    if (!userSankalp) {
      return res.status(404).json({ success: false, message: 'User sankalp not found' });
    }

    userSankalp.reminderTime = reminderTime;
    await userSankalp.save();

    res.json({
      success: true,
      message: 'Reminder time updated successfully',
      data: {
        _id: userSankalp._id,
        reminderTime: userSankalp.reminderTime
      }
    });
  } catch (error) {
    console.error('Error updating reminder time:', error);
    res.status(500).json({ success: false, message: 'Failed to update reminder time', error: error.message });
  }
});

// GET /api/user-sankalp/check-joined/:sankalpId - Check if user joined
router.get('/check-joined/:sankalpId', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    const { sankalpId } = req.params;

    const userSankalp = await UserSankalp.findOne({ userId, sankalpId });

    res.json({
      success: true,
      data: {
        isJoined: !!userSankalp,
        userSankalpId: userSankalp?._id,
        status: userSankalp?.status
      }
    });
  } catch (error) {
    console.error('Error checking joined status:', error);
    res.status(500).json({ success: false, message: 'Failed to check status', error: error.message });
  }
});

// GET /api/user-sankalp/:id - Get single user sankalp details
router.get('/:id', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    const userSankalp = await UserSankalp.findOne({ _id: req.params.id, userId })
      .populate({ path: 'sankalpId', populate: { path: 'clientId', select: 'clientId' } })
      .populate({ path: 'clientId', select: 'clientId' });

    if (!userSankalp) {
      return res.status(404).json({ success: false, message: 'User sankalp not found' });
    }

    const obj = userSankalp.toObject();
    
    // Generate presigned URL for banner
    if (obj.sankalpId?.bannerImageKey || obj.sankalpId?.bannerImage) {
      try {
        const { getPresignedUrl } = await import('../utils/storage.js');
        const imageKey = obj.sankalpId.bannerImageKey || obj.sankalpId.bannerImage;
        if (imageKey) {
          obj.sankalpId.bannerImage = await getPresignedUrl(imageKey);
        }
      } catch (error) {
        console.error('Error generating presigned URL:', error);
      }
    }
    
    // Format root clientId
    if (obj.clientId && typeof obj.clientId === 'object' && obj.clientId.clientId) {
      obj.clientId = obj.clientId.clientId;
    }
    
    // Format nested sankalpId.clientId
    if (obj.sankalpId?.clientId && typeof obj.sankalpId.clientId === 'object' && obj.sankalpId.clientId.clientId) {
      obj.sankalpId.clientId = obj.sankalpId.clientId.clientId;
    }

    res.json({ success: true, data: obj });
  } catch (error) {
    console.error('Error fetching user sankalp:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch sankalp', error: error.message });
  }
});

// POST /api/user-sankalp/:id/report - Daily report
router.post('/:id/report', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    const { status, reportDay } = req.body; // 'yes' or 'no', optional reportDay

    if (!['yes', 'no'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be yes or no' });
    }

    const userSankalp = await UserSankalp.findOne({ _id: req.params.id, userId })
      .populate('sankalpId');

    if (!userSankalp) {
      return res.status(404).json({ success: false, message: 'User sankalp not found' });
    }

    if (userSankalp.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Sankalp is not active' });
    }

    // Find the report to update
    let reportIndex;
    if (reportDay) {
      // Reporting for a specific past day
      reportIndex = userSankalp.dailyReports.findIndex(r => r.day === reportDay);
      if (reportIndex === -1) {
        return res.status(400).json({ success: false, message: 'Invalid report day' });
      }
      
      // Check if already reported
      if (userSankalp.dailyReports[reportIndex].status !== 'not_reported') {
        return res.status(200).json({ 
          success: true, 
          alreadyReported: true,
          message: 'Already reported for this day',
          data: {
            _id: userSankalp._id,
            currentDay: userSankalp.currentDay,
            status: userSankalp.status,
            karmaEarned: userSankalp.karmaEarned
          }
        });
      }
      
      // Check if day is in the past (before today)
      const reportDate = new Date(userSankalp.dailyReports[reportIndex].date);
      reportDate.setHours(0, 0, 0, 0);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      if (reportDate.getTime() > today.getTime()) {
        return res.status(400).json({ success: false, message: 'Cannot report for future days' });
      }
    } else {
      // Reporting for today
      if (!userSankalp.canReportToday()) {
        return res.status(200).json({ 
          success: true, 
          alreadyReported: true,
          message: 'Already reported today',
          data: {
            _id: userSankalp._id,
            currentDay: userSankalp.currentDay,
            status: userSankalp.status,
            karmaEarned: userSankalp.karmaEarned
          }
        });
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      reportIndex = userSankalp.dailyReports.findIndex(report => {
        const reportDate = new Date(report.date);
        reportDate.setHours(0, 0, 0, 0);
        return reportDate.getTime() === today.getTime();
      });

      if (reportIndex === -1) {
        return res.status(400).json({ success: false, message: 'No report slot for today' });
      }
    }

    // Update report
    userSankalp.dailyReports[reportIndex].status = status;
    userSankalp.dailyReports[reportIndex].reportedAt = new Date();

    // Add karma points if yes
    let karmaAdded = 0;
    if (status === 'yes') {
      karmaAdded = userSankalp.sankalpId.karmaPointsPerDay;
      userSankalp.karmaEarned += karmaAdded;

      // Update user's karma points
      await User.findByIdAndUpdate(userId, { $inc: { karmaPoints: karmaAdded } });
      
      // Calculate streak
      let currentStreak = 1;
      for (let i = reportIndex - 1; i >= 0; i--) {
        if (userSankalp.dailyReports[i].status === 'yes') {
          currentStreak++;
        } else {
          break;
        }
      }
      
      // Send streak notification for milestones (7, 14, 21 days)
      if ([7, 14, 21].includes(currentStreak)) {
        await notificationService.sendStreakAlert(
          userId,
          userSankalp._id,
          currentStreak,
          userSankalp.sankalpId.title
        );
      }
    }

    // Update current day - ensure it doesn't go backwards
    userSankalp.currentDay = Math.max(userSankalp.currentDay, reportIndex + 2);

    // Check if completed - all days reported
    const allReported = userSankalp.dailyReports.every(r => r.status !== 'not_reported');
    if (allReported) {
      userSankalp.status = 'completed';
      userSankalp.completedAt = new Date();
      
      // Add completion bonus
      const bonus = userSankalp.sankalpId.completionBonusKarma;
      userSankalp.completionBonusEarned = bonus;
      await User.findByIdAndUpdate(userId, { $inc: { karmaPoints: bonus } });
      
      // Update completed count
      await Sankalp.findByIdAndUpdate(userSankalp.sankalpId._id, { $inc: { completedCount: 1 } });
      
      // Send completion notification
      const totalKarma = userSankalp.karmaEarned + bonus;
      await notificationService.sendCompletionNotification(
        userId,
        userSankalp._id,
        userSankalp.sankalpId.title,
        totalKarma
      );
    }

    await userSankalp.save();

    res.json({
      success: true,
      message: status === 'yes' ? `Report submitted! +${karmaAdded} karma points` : 'Report submitted',
      data: {
        _id: userSankalp._id,
        currentDay: userSankalp.currentDay,
        status: userSankalp.status,
        karmaEarned: userSankalp.karmaEarned,
        todayReport: userSankalp.dailyReports[reportIndex],
        karmaPointsAdded: karmaAdded,
        motivationMessage: status === 'yes' ? userSankalp.sankalpId.dailyMotivationMessage : "Don't give up! Try again tomorrow",
        ...(userSankalp.status === 'completed' && {
          completionBonusEarned: userSankalp.completionBonusEarned,
          completedAt: userSankalp.completedAt,
          totalKarmaEarned: userSankalp.karmaEarned + userSankalp.completionBonusEarned,
          completionMessage: userSankalp.sankalpId.completionMessage
        })
      }
    });
  } catch (error) {
    console.error('Error submitting report:', error);
    res.status(500).json({ success: false, message: 'Failed to submit report', error: error.message });
  }
});

// GET /api/user-sankalp/:id/progress - Get progress
router.get('/:id/progress', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    const userSankalp = await UserSankalp.findOne({ _id: req.params.id, userId })
      .populate({ path: 'sankalpId', populate: { path: 'clientId', select: 'clientId' } })
      .populate({ path: 'clientId', select: 'clientId' });

    if (!userSankalp) {
      return res.status(404).json({ success: false, message: 'User sankalp not found' });
    }

    const obj = userSankalp.toObject();
    
    // Generate presigned URL for banner
    if (obj.sankalpId?.bannerImageKey) {
      try {
        const { getPresignedUrl } = await import('../utils/storage.js');
        obj.sankalpId.bannerImage = await getPresignedUrl(obj.sankalpId.bannerImageKey);
      } catch (error) {
        console.error('Error generating presigned URL:', error);
      }
    }
    
    // Format root clientId
    if (obj.clientId && typeof obj.clientId === 'object' && obj.clientId.clientId) {
      obj.clientId = obj.clientId.clientId;
    }
    
    // Format nested sankalpId.clientId
    if (obj.sankalpId?.clientId && typeof obj.sankalpId.clientId === 'object' && obj.sankalpId.clientId.clientId) {
      obj.sankalpId.clientId = obj.sankalpId.clientId.clientId;
    }

    const yesCount = obj.dailyReports.filter(r => r.status === 'yes').length;
    const noCount = obj.dailyReports.filter(r => r.status === 'no').length;
    const notReportedCount = obj.dailyReports.filter(r => r.status === 'not_reported').length;
    const progressPercentage = Math.round((yesCount / obj.totalDays) * 100);

    res.json({
      success: true,
      data: {
        userSankalp: obj,
        progress: {
          yesCount,
          noCount,
          notReportedCount,
          progressPercentage,
          currentDay: obj.currentDay,
          totalDays: obj.totalDays,
          karmaEarned: obj.karmaEarned,
          completionBonusEarned: obj.completionBonusEarned
        }
      }
    });
  } catch (error) {
    console.error('Error fetching progress:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch progress', error: error.message });
  }
});

// DELETE /api/user-sankalp/:id/abandon - Abandon sankalp
router.delete('/:id/abandon', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    const userSankalp = await UserSankalp.findOne({ _id: req.params.id, userId });

    if (!userSankalp) {
      return res.status(404).json({ success: false, message: 'User sankalp not found' });
    }

    if (userSankalp.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Can only abandon active sankalpas' });
    }

    userSankalp.status = 'abandoned';
    await userSankalp.save();

    res.json({ success: true, message: 'Sankalp abandoned' });
  } catch (error) {
    console.error('Error abandoning sankalp:', error);
    res.status(500).json({ success: false, message: 'Failed to abandon sankalp', error: error.message });
  }
});

export default router;
