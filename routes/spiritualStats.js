import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import SpiritualSession from '../models/SpiritualSession.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Helper function to format name from email
const formatNameFromEmail = (email) => {
  if (!email) return null;
  
  const username = email.split('@')[0];
  // Remove numbers and special characters, split by common separators
  const cleanName = username
    .replace(/[0-9]/g, '') // Remove numbers
    .replace(/[._-]/g, ' ') // Replace separators with spaces
    .replace(/([a-z])([A-Z])/g, '$1 $2') // Add space before capital letters
    .split(' ')
    .filter(word => word.length > 0)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
  
  return cleanName || username;
};

// Get user spiritual stats (for SpiritualStats.jsx - user side)
const getUserStats = async (req, res) => {
  try {
    // Check if user is authenticated
    if (!req.user || !req.user._id) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    // Always show only current user's sessions
    const userId = req.user._id || req.user.userId;
    const { category } = req.query;

    // Query only current user's sessions
    let query = { userId };
    if (category && category !== 'all') {
      query.type = category;
    }

    // These reads don't depend on each other: run them together instead of one after another.
    // (All sessions belong to this one user, so the old per-session populate of userId was an extra query for nothing.)
    const User = (await import('../models/User.js')).default;
    const KarmaPointsTransaction = (await import('../models/KarmaPointsTransaction.js')).default;
    const RewardRedemption = (await import('../models/RewardRedemption.js')).default;
    const UserSankalp = (await import('../models/UserSankalp.js')).default;

    const [sessions, currentUser, userSankalpas, bonusTransactions, redemptions] = await Promise.all([
      SpiritualSession.find(query).sort({ createdAt: -1 }).lean(),
      User.findById(userId).select('email profile.name profile.dob karmaPoints fullName').lean(),
      UserSankalp.find({ userId }).select('karmaEarned completionBonusEarned').lean(),
      KarmaPointsTransaction.find({ userId }).select('amount').lean(),
      RewardRedemption.find({ userId, status: 'completed' }).select('karmaPointsSpent').lean()
    ]);

    // Same shape the populate used to attach to each session's userId
    if (currentUser) {
      const userBrief = {
        _id: currentUser._id,
        email: currentUser.email,
        fullName: currentUser.fullName,
        profile: { name: currentUser.profile?.name, dob: currentUser.profile?.dob }
      };
      sessions.forEach((s) => { s.userId = userBrief; });
    }
    
    // Calculate total stats based on role
    const totalSessions = sessions.length;
    const completedSessions = sessions.filter(s => {
      const sessionStatus = s.status || (s.completionPercentage >= 100 ? 'completed' : 
                            s.completionPercentage >= 50 ? 'incomplete' : 'interrupted');
      return sessionStatus === 'completed';
    }).length;
    const incompleteSessions = sessions.filter(s => {
      const sessionStatus = s.status || (s.completionPercentage >= 100 ? 'completed' : 
                            s.completionPercentage >= 50 ? 'incomplete' : 'interrupted');
      return sessionStatus === 'incomplete';
    }).length;
    const totalMinutes = sessions.reduce((sum, session) => {
      // Only count duration for non-chanting activities
      return sum + (session.type !== 'chanting' ? (session.actualDuration || 0) : 0);
    }, 0);
    
    // Calculate karma points breakdown
    const totalKarmaFromActivities = sessions.reduce((sum, session) => sum + (session.karmaPoints || 0), 0);
    
    // Use User.karmaPoints as source of truth (already includes activities + sankalp + bonus - spent)
    const totalKarmaPoints = currentUser?.karmaPoints || 0;
    
    // Calculate sankalp karma points for breakdown only
    const totalSankalpKarma = userSankalpas.reduce((sum, us) => {
      return sum + (us.karmaEarned || 0) + (us.completionBonusEarned || 0);
    }, 0);
    
    // Calculate bonus points from transactions
    const totalBonusPoints = bonusTransactions.reduce((sum, tx) => sum + (tx.amount || 0), 0);

    // Calculate spent points from redemptions
    const totalSpentPoints = redemptions.reduce((sum, r) => sum + (r.karmaPointsSpent || 0), 0);
    const averageCompletion = sessions.length > 0 ?
      sessions.reduce((sum, session) => sum + (session.completionPercentage || 100), 0) / sessions.length : 0;
    
    // Calculate category-wise stats
    const categoryStats = {};
    sessions.forEach(session => {
      const category = session.type || 'meditation';
      if (!categoryStats[category]) {
        categoryStats[category] = {
          sessions: 0,
          completed: 0,
          incomplete: 0,
          minutes: 0,
          karmaPoints: 0,
          averageCompletion: 0
        };
      }
      categoryStats[category].sessions++;
      
      const sessionStatus = session.status || 
        (session.completionPercentage >= 100 ? 'completed' : 
         session.completionPercentage >= 50 ? 'incomplete' : 'interrupted');
      
      if (sessionStatus === 'completed') {
        categoryStats[category].completed++;
      } else {
        categoryStats[category].incomplete++;
      }
      
      // Only count duration for non-chanting activities
      if (session.type !== 'chanting') {
        categoryStats[category].minutes += session.actualDuration || 0;
      }
      categoryStats[category].karmaPoints += session.karmaPoints || 0;
    });
    
    // Add bonus and redemption stats to categoryStats
    categoryStats.bonus = {
      count: bonusTransactions.length,
      totalBonusPoints: totalBonusPoints
    };
    
    categoryStats.redemption = {
      count: redemptions.length,
      totalRedeemPoints: totalSpentPoints
    };
    
    // Calculate average completion for each category
    Object.keys(categoryStats).forEach(category => {
      const categorySessions = sessions.filter(s => s.type === category);
      if (categorySessions.length > 0) {
        const totalCompletion = categorySessions.reduce((sum, s) => {
          // For chanting, use stored completion percentage
          // For others, calculate from duration if needed
          const sessionCompletion = s.completionPercentage !== undefined ? s.completionPercentage :
                                   (s.targetDuration > 0 ? Math.round((s.actualDuration / s.targetDuration) * 100) : 100);
          return sum + sessionCompletion;
        }, 0);
        categoryStats[category].averageCompletion = Math.round(totalCompletion / categorySessions.length);
      }
    });
    
    // Calculate current streak
    let currentStreak = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const uniqueDates = [...new Set(sessions.map(session => {
      const date = new Date(session.createdAt);
      date.setHours(0, 0, 0, 0);
      return date.getTime();
    }))].sort((a, b) => b - a);
    
    for (let i = 0; i < uniqueDates.length; i++) {
      const sessionDate = new Date(uniqueDates[i]);
      const daysDiff = Math.floor((today - sessionDate) / (1000 * 60 * 60 * 24));
      
      if (daysDiff === i) {
        currentStreak++;
      } else {
        break;
      }
    }
    
    // Get recent activities based on role
    const { getPresignedUrl } = await import('../utils/storage.js');
    // Sessions are newest-first and only `limit` are returned: don't build/sign the rest (users can have thousands)
    const activityLimit = Math.min(parseInt(req.query.limit) || 500, 500);
    const recentActivities = await Promise.all(sessions.slice(0, activityLimit).map(async session => {
      const completionPercentage = session.completionPercentage !== undefined ? session.completionPercentage :
                                  (session.targetDuration > 0 ? Math.round((session.actualDuration / session.targetDuration) * 100) : 100);

      let status = session.status || 'completed';
      if (!session.status && session.type !== 'chanting') {
        if (completionPercentage < 100) {
          status = completionPercentage >= 50 ? 'incomplete' : 'interrupted';
        }
      }

      // Generate presigned URLs with 7 days expiry (max allowed)
      let videoUrl = '';
      let audioUrl = '';

      try {
        if (session.videoKey) {
          videoUrl = await getPresignedUrl(session.videoKey, 604800); // 7 days
        }
        if (session.audioKey) {
          audioUrl = await getPresignedUrl(session.audioKey, 604800); // 7 days
        }
      } catch (error) {
        console.error('Error generating presigned URLs for session:', session._id, error);
      }

      let activityData = {
        id: session._id,
        userId: session.userId, // Add user ID
        title: session.title || `${session.type} Session`,
        type: session.type || 'meditation',
        status: status,
        completionPercentage: completionPercentage,
        karmaPoints: session.karmaPoints || 0,
        emotion: session.emotion,
        isActive: session.isActive !== undefined ? session.isActive : true,
        createdAt: session.createdAt,
        chantingName: session.chantingName,
        videoUrl,
        audioUrl,
        userDetails: {
          email: session.userId?.email || `No-Email-${session._id}`,
          name: session.userId?.profile?.name || 
                session.userId?.fullName || 
                session.userId?.businessName || 
                formatNameFromEmail(session.userId?.email) ||
                `User-${session._id}`,
          dob: session.userId?.profile?.dob || null
        }
      };
      
      // Add duration fields only for non-chanting activities
      if (session.type !== 'chanting') {
        activityData.targetDuration = session.targetDuration || 0;
        activityData.actualDuration = session.actualDuration || 0;
      } else {
        // Add chant count for chanting activities
        activityData.chantCount = session.chantCount || 0;
      }
      
      return activityData;
    }));
    
    const limitedActivities = recentActivities;
    
    // User details already fetched above as currentUser
    const stats = {
      totalStats: {
        sessions: totalSessions,
        completed: completedSessions,
        incomplete: incompleteSessions,
        minutes: totalMinutes,
        karmaPoints: totalKarmaPoints,
        karmaPointsBreakdown: {
          fromActivities: totalKarmaFromActivities,
          fromSankalp: totalSankalpKarma,
          bonus: totalBonusPoints,
          spent: totalSpentPoints,
          total: totalKarmaPoints
        },
        streak: currentStreak,
        averageCompletion: Math.round(averageCompletion)
      },
      categoryStats,
      recentActivities: limitedActivities,
      userDetails: {
        email: currentUser?.email || 'Unknown',
        name: currentUser?.profile?.name || 'Unknown User',
        dob: currentUser?.profile?.dob || null
      }
    };

    res.status(200).set('Content-Type', 'application/json').send(JSON.stringify({
      success: true,
      data: stats
    }, null, 2));
  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Get all users spiritual stats (for SpiritualManagement.jsx - client side)
const getAllUsersStats = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 500;
    const { category } = req.query;
    const skip = (page - 1) * limit;
    
    console.log('[All Users Stats] Page:', page, 'Limit:', limit, 'Category:', category);
    
    let query = {};
    if (category && category !== 'all') {
      query.type = category;
    }
    
    let sessions = await SpiritualSession.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean();
    const totalSessions = await SpiritualSession.countDocuments(query);
    
    const allSessions = await SpiritualSession.find(query).select('status completionPercentage actualDuration karmaPoints type').lean();
    
    const completedSessions = allSessions.filter(s => {
      const sessionStatus = s.status || (s.completionPercentage >= 100 ? 'completed' : 
                            s.completionPercentage >= 50 ? 'incomplete' : 'interrupted');
      return sessionStatus === 'completed';
    }).length;
    
    const incompleteSessions = allSessions.filter(s => {
      const sessionStatus = s.status || (s.completionPercentage >= 100 ? 'completed' : 
                            s.completionPercentage >= 50 ? 'incomplete' : 'interrupted');
      return sessionStatus === 'incomplete';
    }).length;
    
    const totalMinutes = allSessions.reduce((sum, session) => {
      return sum + (session.type !== 'chanting' ? (session.actualDuration || 0) : 0);
    }, 0);
    
    const totalKarmaFromActivities = allSessions.reduce((sum, session) => sum + (session.karmaPoints || 0), 0);
    
    // Calculate bonus and spent points for all users
    const KarmaPointsTransaction = (await import('../models/KarmaPointsTransaction.js')).default;
    const RewardRedemption = (await import('../models/RewardRedemption.js')).default;
    
    const allBonusTransactions = await KarmaPointsTransaction.find({});
    const totalBonusPoints = allBonusTransactions.reduce((sum, tx) => sum + (tx.amount || 0), 0);
    
    const allRedemptions = await RewardRedemption.find({ status: 'completed' });
    const totalSpentPoints = allRedemptions.reduce((sum, r) => sum + (r.karmaPointsSpent || 0), 0);
    
    const totalKarmaPoints = Math.max(0, totalKarmaFromActivities + totalBonusPoints - totalSpentPoints);
    const averageCompletion = allSessions.length > 0 ? 
      allSessions.reduce((sum, session) => sum + (session.completionPercentage || 100), 0) / allSessions.length : 0;
    
    // Calculate category-wise stats
    const categoryStats = {};
    sessions.forEach(session => {
      const category = session.type || 'meditation';
      if (!categoryStats[category]) {
        categoryStats[category] = {
          sessions: 0,
          completed: 0,
          incomplete: 0,
          minutes: 0,
          karmaPoints: 0,
          averageCompletion: 0
        };
      }
      categoryStats[category].sessions++;
      
      const sessionStatus = session.status || 
        (session.completionPercentage >= 100 ? 'completed' : 
         session.completionPercentage >= 50 ? 'incomplete' : 'interrupted');
      
      if (sessionStatus === 'completed') {
        categoryStats[category].completed++;
      } else {
        categoryStats[category].incomplete++;
      }
      
      if (session.type !== 'chanting') {
        categoryStats[category].minutes += session.actualDuration || 0;
      }
      categoryStats[category].karmaPoints += session.karmaPoints || 0;
    });
    
    // Add bonus and redemption stats to categoryStats
    categoryStats.bonus = {
      count: allBonusTransactions.length,
      totalBonusPoints: totalBonusPoints
    };
    
    categoryStats.redemption = {
      count: allRedemptions.length,
      totalRedeemPoints: totalSpentPoints
    };
    
    // Calculate average completion for each category
    Object.keys(categoryStats).forEach(category => {
      const categorySessions = sessions.filter(s => s.type === category);
      if (categorySessions.length > 0) {
        const totalCompletion = categorySessions.reduce((sum, s) => {
          const sessionCompletion = s.completionPercentage !== undefined ? s.completionPercentage :
                                   (s.targetDuration > 0 ? Math.round((s.actualDuration / s.targetDuration) * 100) : 100);
          return sum + sessionCompletion;
        }, 0);
        categoryStats[category].averageCompletion = Math.round(totalCompletion / categorySessions.length);
      }
    });
    
    // Try to populate with User model first
    try {
      sessions = await SpiritualSession.populate(sessions, {
        path: 'userId',
        select: 'email profile.name profile.dob fullName'
      });
    } catch (error) {
      // If User model fails, try Client model
      try {
        const Client = (await import('../models/Client.js')).default;
        sessions = await SpiritualSession.populate(sessions, {
          path: 'userId',
          model: Client,
          select: 'email fullName businessName'
        });
      } catch (clientError) {
        console.log('Both User and Client model populate failed');
      }
    }
    
    // Generate presigned URLs for video/audio
    const { getPresignedUrl } = await import('../utils/storage.js');
    const recentActivities = await Promise.all(sessions.map(async session => {
      const completionPercentage = session.completionPercentage !== undefined ? session.completionPercentage :
                                  (session.targetDuration > 0 ? Math.round((session.actualDuration / session.targetDuration) * 100) : 100);
      
      let status = session.status || 'completed';
      if (!session.status && session.type !== 'chanting') {
        if (completionPercentage < 100) {
          status = completionPercentage >= 50 ? 'incomplete' : 'interrupted';
        }
      }
      
      // Generate presigned URLs with 7 days expiry
      let videoUrl = session.videoUrl || '';
      let audioUrl = session.audioUrl || '';
      
      try {
        if (session.videoKey) {
          videoUrl = await getPresignedUrl(session.videoKey, 604800); // 7 days
        }
        if (session.audioKey) {
          audioUrl = await getPresignedUrl(session.audioKey, 604800); // 7 days
        }
      } catch (error) {
        console.error('Error generating presigned URLs for session:', session._id, error);
      }
      
      let activityData = {
        id: session._id,
        userId: session.userId,
        title: session.title || `${session.type} Session`,
        type: session.type || 'meditation',
        status: status,
        completionPercentage: completionPercentage,
        karmaPoints: session.karmaPoints || 0,
        emotion: session.emotion,
        isActive: session.isActive !== undefined ? session.isActive : true,
        createdAt: session.createdAt,
        chantingName: session.chantingName,
        videoUrl,
        audioUrl,
        userDetails: {
          email: session.userId?.email || `No-Email-${session._id}`,
          name: session.userId?.profile?.name || 
                session.userId?.fullName || 
                session.userId?.businessName || 
                formatNameFromEmail(session.userId?.email) ||
                `User-${session._id}`,
          dob: session.userId?.profile?.dob || null
        }
      };
      
      if (session.type !== 'chanting') {
        activityData.targetDuration = session.targetDuration || 0;
        activityData.actualDuration = session.actualDuration || 0;
      } else {
        activityData.chantCount = session.chantCount || 0;
      }
      
      return activityData;
    }));
    
    console.log('[All Users Stats] Returning', recentActivities.length, 'activities for category:', category);
    
    const stats = {
      totalStats: {
        sessions: totalSessions,
        completed: completedSessions,
        incomplete: incompleteSessions,
        minutes: totalMinutes,
        karmaPoints: totalKarmaPoints,
        karmaPointsBreakdown: {
          fromActivities: totalKarmaFromActivities,
          bonus: totalBonusPoints,
          spent: totalSpentPoints,
          total: totalKarmaPoints
        },
        streak: 0,
        averageCompletion: Math.round(averageCompletion)
      },
      categoryStats,
      recentActivities,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalSessions / limit),
        totalRecords: totalSessions,
        limit: limit,
        hasMore: skip + sessions.length < totalSessions
      },
      userDetails: {
        email: 'All Users',
        name: 'All Users Data',
        dob: null
      }
    };

    res.status(200).set('Content-Type', 'application/json').send(JSON.stringify({
      success: true,
      data: stats
    }, null, 2));
  } catch (error) {
    console.error('Get all users stats error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Routes
router.get('/', getUserStats); // For SpiritualStats.jsx (user side)
router.get('/all-users', getAllUsersStats); // For SpiritualManagement.jsx (client side)
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Get sessions for specific user only
    const sessions = await SpiritualSession.find({ userId }).sort({ createdAt: -1 });
    
    if (sessions.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No sessions found for this user'
      });
    }
    
    // Get user details for the specific user
    const User = (await import('../models/User.js')).default;
    let userDetails = null;
    try {
      userDetails = await User.findById(userId).select('email profile.name profile.dob fullName');
    } catch (error) {
      try {
        const Client = (await import('../models/Client.js')).default;
        userDetails = await Client.findById(userId).select('email fullName businessName');
      } catch (clientError) {
        console.log('User not found in User or Client collections');
      }
    }
    
    // Calculate stats for this specific user
    const completedSessions = sessions.filter(s => {
      const sessionStatus = s.status || (s.completionPercentage >= 100 ? 'completed' : 
                            s.completionPercentage >= 50 ? 'incomplete' : 'interrupted');
      return sessionStatus === 'completed';
    }).length;
    const incompleteSessions = sessions.filter(s => {
      const sessionStatus = s.status || (s.completionPercentage >= 100 ? 'completed' : 
                            s.completionPercentage >= 50 ? 'incomplete' : 'interrupted');
      return sessionStatus === 'incomplete';
    }).length;
    const interruptedSessions = sessions.filter(s => {
      const sessionStatus = s.status || (s.completionPercentage >= 100 ? 'completed' : 
                            s.completionPercentage >= 50 ? 'incomplete' : 'interrupted');
      return sessionStatus === 'interrupted';
    }).length;
    const totalSessions = completedSessions + incompleteSessions + interruptedSessions;
    const totalMinutes = sessions.reduce((sum, session) => {
      return sum + (session.type !== 'chanting' ? (session.actualDuration || 0) : 0);
    }, 0);
    const totalKarmaPoints = sessions.reduce((sum, session) => sum + (session.karmaPoints || 0), 0);
    
    // Calculate average completion for all sessions
    const averageCompletion = sessions.length > 0 ? 
      sessions.reduce((sum, session) => {
        const sessionCompletion = session.completionPercentage !== undefined ? session.completionPercentage :
                                 (session.targetDuration > 0 ? Math.round((session.actualDuration / session.targetDuration) * 100) : 100);
        return sum + sessionCompletion;
      }, 0) / sessions.length : 0;
    
    // Calculate category-wise stats for this user
    const categoryStats = {};
    sessions.forEach(session => {
      const category = session.type || 'meditation';
      if (!categoryStats[category]) {
        categoryStats[category] = {
          sessions: 0,
          completed: 0,
          incomplete: 0,
          minutes: 0,
          karmaPoints: 0,
          averageCompletion: 0
        };
      }
      categoryStats[category].sessions++;
      
      const sessionStatus = session.status || 
        (session.completionPercentage >= 100 ? 'completed' : 
         session.completionPercentage >= 50 ? 'incomplete' : 'interrupted');
      
      if (sessionStatus === 'completed') {
        categoryStats[category].completed++;
      } else {
        categoryStats[category].incomplete++;
      }
      
      if (session.type !== 'chanting') {
        categoryStats[category].minutes += session.actualDuration || 0;
      }
      categoryStats[category].karmaPoints += session.karmaPoints || 0;
    });
    
    // Calculate average completion for each category
    Object.keys(categoryStats).forEach(category => {
      const categorySessions = sessions.filter(s => s.type === category);
      if (categorySessions.length > 0) {
        const totalCompletion = categorySessions.reduce((sum, s) => {
          const sessionCompletion = s.completionPercentage !== undefined ? s.completionPercentage :
                                   (s.targetDuration > 0 ? Math.round((s.actualDuration / s.targetDuration) * 100) : 100);
          return sum + sessionCompletion;
        }, 0);
        categoryStats[category].averageCompletion = Math.round(totalCompletion / categorySessions.length);
      }
    });
    
    // Get recent activities for this user
    const { getPresignedUrl } = await import('../utils/storage.js');
    const recentActivities = await Promise.all(sessions.map(async session => {
      const completionPercentage = session.completionPercentage !== undefined ? session.completionPercentage :
                                  (session.targetDuration > 0 ? Math.round((session.actualDuration / session.targetDuration) * 100) : 100);
      
      let status = session.status || 'completed';
      if (!session.status && session.type !== 'chanting') {
        if (completionPercentage < 100) {
          status = completionPercentage >= 50 ? 'incomplete' : 'interrupted';
        }
      }
      
      // Generate presigned URLs with 7 days expiry (max allowed)
      let videoUrl = '';
      let audioUrl = '';
      
      try {
        if (session.videoKey) {
          videoUrl = await getPresignedUrl(session.videoKey, 604800); // 7 days
        }
        if (session.audioKey) {
          audioUrl = await getPresignedUrl(session.audioKey, 604800); // 7 days
        }
      } catch (error) {
        console.error('Error generating presigned URLs for session:', session._id, error);
      }
      
      let activityData = {
        id: session._id,
        title: session.title || `${session.type} Session`,
        type: session.type || 'meditation',
        status: status,
        completionPercentage: completionPercentage,
        karmaPoints: session.karmaPoints || 0,
        emotion: session.emotion,
        isActive: session.isActive !== undefined ? session.isActive : true,
        createdAt: session.createdAt,
        videoUrl,
        audioUrl,
        userDetails: {
          email: userDetails?.email || 'Unknown',
          name: userDetails?.profile?.name || 
                userDetails?.fullName || 
                userDetails?.businessName || 
                formatNameFromEmail(userDetails?.email) ||
                'Unknown User',
          dob: userDetails?.profile?.dob || null
        }
      };
      
      if (session.type !== 'chanting') {
        activityData.targetDuration = session.targetDuration || 0;
        activityData.actualDuration = session.actualDuration || 0;
      } else {
        activityData.chantCount = session.chantCount || 0;
      }
      
      return activityData;
    }));
    
    const stats = {
      totalStats: {
        sessions: totalSessions,
        completed: completedSessions,
        incomplete: incompleteSessions,
        interrupted: interruptedSessions,
        minutes: totalMinutes,
        karmaPoints: totalKarmaPoints,
        averageCompletion: Math.round(averageCompletion)
      },
      categoryStats,
      recentActivities,
      userDetails: {
        email: userDetails?.email || 'Unknown',
        name: userDetails?.profile?.name || userDetails?.fullName || userDetails?.businessName || 'Unknown User',
        dob: userDetails?.profile?.dob || null
      }
    };

    res.status(200).set('Content-Type', 'application/json').send(JSON.stringify({
      success: true,
      data: stats
    }, null, 2));
  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Save spiritual session
router.post('/save-session', async (req, res) => {
  try {
    const userId = req.user._id || req.user.userId;
    const { type, title, targetDuration, actualDuration, karmaPoints, emotion, status, completionPercentage, chantCount, chantingName, videoUrl, audioUrl, videoKey, audioKey } = req.body;
    
    // Basic validation - all activities need userId, type, title
    if (!userId || !type || !title) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: userId, type, title'
      });
    }
    
    let sessionData = {
      userId,
      type,
      title,
      karmaPoints: karmaPoints || 0,
      emotion
    };
    
    // Add video/audio URLs and keys if provided
    if (videoUrl) sessionData.videoUrl = videoUrl;
    if (audioUrl) sessionData.audioUrl = audioUrl;
    if (videoKey) sessionData.videoKey = videoKey;
    if (audioKey) sessionData.audioKey = audioKey;
    
    if (type === 'chanting') {
      // For chanting: use chantCount, chantingName, status, completionPercentage
      // Duration fields will be null/undefined
      sessionData.chantCount = chantCount || 0;
      sessionData.chantingName = chantingName || title;
      sessionData.status = status || 'completed';
      sessionData.completionPercentage = completionPercentage || 100;
      sessionData.targetDuration = null;
      sessionData.actualDuration = null;
    } else {
      // For other activities: use duration fields, calculate status
      sessionData.targetDuration = targetDuration || 0;
      sessionData.actualDuration = actualDuration || 0;
      
      const calculatedCompletion = targetDuration > 0 ? Math.round((actualDuration / targetDuration) * 100) : 100;
      let calculatedStatus = 'completed';
      
      if (calculatedCompletion < 100) {
        calculatedStatus = calculatedCompletion >= 50 ? 'incomplete' : 'interrupted';
      }
      
      sessionData.status = calculatedStatus;
      sessionData.completionPercentage = calculatedCompletion;
      sessionData.chantCount = 0;
    }
    
    const newSession = new SpiritualSession(sessionData);
    await newSession.save();
    
    // ✅ AUTO-UPDATE: User's karma points (sessions + bonus - redemptions)
    const User = (await import('../models/User.js')).default;
    const RewardRedemption = (await import('../models/RewardRedemption.js')).default;
    const KarmaPointsTransaction = (await import('../models/KarmaPointsTransaction.js')).default;
    
    // Calculate total earned karma points from all sessions
    const sessions = await SpiritualSession.find({ userId });
    const totalEarnedFromSessions = sessions.reduce((sum, session) => sum + (session.karmaPoints || 0), 0);
    
    // Calculate total bonus points from transactions
    const bonusTransactions = await KarmaPointsTransaction.find({ userId });
    const totalBonusPoints = bonusTransactions.reduce((sum, tx) => sum + (tx.amount || 0), 0);
    
    // Calculate total spent karma points from redemptions (only completed status)
    const redemptions = await RewardRedemption.find({ userId, status: 'completed' });
    const totalSpentKarmaPoints = redemptions.reduce((sum, redemption) => sum + (redemption.karmaPointsSpent || 0), 0);
    
    // Final balance = earned from sessions + bonus - spent
    const finalKarmaPoints = Math.max(0, totalEarnedFromSessions + totalBonusPoints - totalSpentKarmaPoints);
    
    // Update User.karmaPoints with total balance
    await User.findByIdAndUpdate(userId, { karmaPoints: finalKarmaPoints });
    
    res.json({
      success: true,
      message: `Session saved successfully (${newSession.status})`,
      data: {
        ...newSession.toObject(),
        statusMessage: getStatusMessage(newSession.status, newSession.completionPercentage),
        totalKarmaPoints: finalKarmaPoints // Return updated balance
      }
    });
  } catch (error) {
    console.error('Save session error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Helper function to get status message
const getStatusMessage = (status, completionPercentage) => {
  switch (status) {
    case 'completed':
      return '✅ Session completed successfully!';
    case 'incomplete':
      return `⚠️ Session partially completed (${completionPercentage}%)`;
    case 'interrupted':
      return `❌ Session interrupted early (${completionPercentage}%)`;
    default:
      return 'Session saved';
  }
};

// Add sample data for testing (remove in production)
router.post('/add-sample-data', async (req, res) => {
  try {
    const userId = req.user._id || req.user.userId;
    
    // First clear existing sample data to avoid duplicates
    await SpiritualSession.deleteMany({ 
      userId,
      title: { $in: ['Morning Meditation', 'Evening Prayer', 'Gayatri Mantra'] }
    });
    
    const sampleSessions = [
      {
        userId,
        type: 'meditation',
        title: 'Morning Meditation',
        targetDuration: 15,
        actualDuration: 15,
        karmaPoints: 45,
        emotion: 'calm',
        createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)
      },
      {
        userId,
        type: 'prayer',
        title: 'Evening Prayer',
        targetDuration: 10,
        actualDuration: 10,
        karmaPoints: 30,
        emotion: 'peaceful',
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
      },
      {
        userId,
        type: 'chanting',
        title: 'Gayatri Mantra',
        karmaPoints: 60,
        emotion: 'focused',
        chantCount: 108,
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
      }
    ];
    
    await SpiritualSession.insertMany(sampleSessions);
    
    res.json({
      success: true,
      message: 'Sample data added successfully (duplicates removed)'
    });
  } catch (error) {
    console.error('Add sample data error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Clean duplicate sessions (for admin use)
router.post('/clean-duplicates', async (req, res) => {
  try {
    // Remove duplicate sessions with same userId, type, title, and createdAt (within 1 minute)
    const sessions = await SpiritualSession.find({}).sort({ createdAt: -1 });
    const duplicates = [];
    const seen = new Set();
    
    sessions.forEach(session => {
      const key = `${session.userId}-${session.type}-${session.title}-${Math.floor(new Date(session.createdAt).getTime() / 60000)}`;
      if (seen.has(key)) {
        duplicates.push(session._id);
      } else {
        seen.add(key);
      }
    });
    
    if (duplicates.length > 0) {
      await SpiritualSession.deleteMany({ _id: { $in: duplicates } });
    }
    
    res.json({
      success: true,
      message: `Removed ${duplicates.length} duplicate sessions`
    });
  } catch (error) {
    console.error('Clean duplicates error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Recalculate karma points for current user
router.post('/recalculate-karma', async (req, res) => {
  try {
    const userId = req.user._id || req.user.userId;
    const User = (await import('../models/User.js')).default;
    const RewardRedemption = (await import('../models/RewardRedemption.js')).default;
    
    // Get all sessions
    const sessions = await SpiritualSession.find({ userId });
    const totalEarned = sessions.reduce((sum, s) => sum + (s.karmaPoints || 0), 0);
    
    // Get all completed redemptions
    const redemptions = await RewardRedemption.find({ userId, status: 'completed' });
    const totalSpent = redemptions.reduce((sum, r) => sum + (r.karmaPointsSpent || 0), 0);
    
    // Calculate balance
    const balance = Math.max(0, totalEarned - totalSpent);
    
    // NOTE: Do NOT update User.karmaPoints - it should only store bonus points
    
    res.json({
      success: true,
      message: 'Karma points recalculated successfully',
      data: {
        totalSessions: sessions.length,
        totalEarned,
        totalRedemptions: redemptions.length,
        totalSpent,
        currentBalance: balance,
        sessions: sessions.map(s => ({ id: s._id, title: s.title, points: s.karmaPoints })),
        redemptions: redemptions.map(r => ({ id: r._id, points: r.karmaPointsSpent, status: r.status }))
      }
    });
  } catch (error) {
    console.error('Recalculate karma error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Debug karma points - show detailed breakdown
router.get('/debug-karma', async (req, res) => {
  try {
    const userId = req.user._id || req.user.userId;
    const User = (await import('../models/User.js')).default;
    const RewardRedemption = (await import('../models/RewardRedemption.js')).default;
    
    // Get user current karma points
    const user = await User.findById(userId).select('karmaPoints email');
    
    // Get all sessions
    const sessions = await SpiritualSession.find({ userId }).sort({ createdAt: -1 });
    const totalEarned = sessions.reduce((sum, s) => sum + (s.karmaPoints || 0), 0);
    
    // Get ALL redemptions (not just completed)
    const allRedemptions = await RewardRedemption.find({ userId }).sort({ redeemedAt: -1 });
    const completedRedemptions = allRedemptions.filter(r => r.status === 'completed');
    const totalSpent = completedRedemptions.reduce((sum, r) => sum + (r.karmaPointsSpent || 0), 0);
    
    // Calculate what it should be
    const calculatedBalance = Math.max(0, totalEarned - totalSpent);
    
    res.json({
      success: true,
      data: {
        userEmail: user.email,
        currentKarmaPointsInDB: user.karmaPoints,
        calculatedBalance,
        difference: user.karmaPoints - calculatedBalance,
        sessions: {
          total: sessions.length,
          totalEarned,
          list: sessions.map(s => ({
            id: s._id,
            title: s.title,
            type: s.type,
            points: s.karmaPoints,
            date: s.createdAt
          }))
        },
        redemptions: {
          total: allRedemptions.length,
          completed: completedRedemptions.length,
          totalSpent,
          list: allRedemptions.map(r => ({
            id: r._id,
            points: r.karmaPointsSpent,
            status: r.status,
            date: r.redeemedAt
          }))
        }
      }
    });
  } catch (error) {
    console.error('Debug karma error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Delete all test redemptions for current user (MUST BE BEFORE /:sessionId route)
router.delete('/clear-redemptions', async (req, res) => {
  try {
    const userId = req.user._id || req.user.userId;
    const RewardRedemption = (await import('../models/RewardRedemption.js')).default;
    const User = (await import('../models/User.js')).default;
    
    // Delete all redemptions
    const result = await RewardRedemption.deleteMany({ userId });
    
    // Recalculate karma points (only from sessions now)
    const sessions = await SpiritualSession.find({ userId });
    const totalEarned = sessions.reduce((sum, s) => sum + (s.karmaPoints || 0), 0);
    
    // NOTE: Do NOT update User.karmaPoints - it should only store bonus points
    
    res.json({
      success: true,
      message: `Deleted ${result.deletedCount} redemptions and reset karma points`,
      data: {
        deletedRedemptions: result.deletedCount,
        newKarmaBalance: totalEarned
      }
    });
  } catch (error) {
    console.error('Clear redemptions error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Migrate existing data to add isActive field
router.post('/migrate-active-field', async (req, res) => {
  try {
    const result = await SpiritualSession.updateMany(
      { isActive: { $exists: false } },
      { $set: { isActive: true } }
    );
    
    res.json({
      success: true,
      message: `Updated ${result.modifiedCount} sessions with isActive field`
    });
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Toggle session status (enable/disable)
router.patch('/:sessionId/toggle', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await SpiritualSession.findById(sessionId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    // If isActive doesn't exist, default to true, then toggle
    const currentStatus = session.isActive !== undefined ? session.isActive : true;
    session.isActive = !currentStatus;
    await session.save();
    
    res.json({
      success: true,
      data: session,
      message: `Session ${session.isActive ? 'enabled' : 'disabled'} successfully`
    });
  } catch (error) {
    console.error('Toggle session status error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Delete session
router.delete('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await SpiritualSession.findByIdAndDelete(sessionId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Session deleted successfully'
    });
  } catch (error) {
    console.error('Delete session error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

export default router;
