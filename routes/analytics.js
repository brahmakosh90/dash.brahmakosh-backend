import express from 'express';
import UserSankalp from '../models/UserSankalp.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// GET /api/analytics/sankalpas - Get user's sankalp analytics
router.get('/sankalpas', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    
    const userSankalpas = await UserSankalp.find({ userId });
    
    const totalJoined = userSankalpas.length;
    const completed = userSankalpas.filter(s => s.status === 'completed').length;
    const active = userSankalpas.filter(s => s.status === 'active').length;
    const abandoned = userSankalpas.filter(s => s.status === 'abandoned').length;
    
    const totalKarmaEarned = userSankalpas.reduce((sum, s) => sum + s.karmaEarned + (s.completionBonusEarned || 0), 0);
    
    const successRate = totalJoined > 0 ? Math.round((completed / totalJoined) * 100) : 0;
    
    // Calculate total days reported
    let totalDaysReported = 0;
    let totalYes = 0;
    let totalNo = 0;
    
    userSankalpas.forEach(s => {
      s.dailyReports.forEach(r => {
        if (r.status !== 'not_reported') {
          totalDaysReported++;
          if (r.status === 'yes') totalYes++;
          if (r.status === 'no') totalNo++;
        }
      });
    });
    
    const consistency = totalDaysReported > 0 ? Math.round((totalYes / totalDaysReported) * 100) : 0;
    
    res.json({
      success: true,
      data: {
        totalJoined,
        completed,
        active,
        abandoned,
        totalKarmaEarned,
        successRate,
        totalDaysReported,
        totalYes,
        totalNo,
        consistency
      }
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch analytics', error: error.message });
  }
});

export default router;
