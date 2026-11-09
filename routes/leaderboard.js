import express from 'express';
import UserSankalp from '../models/UserSankalp.js';
import User from '../models/User.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// GET /api/leaderboard/sankalpas - Top sankalp completers
router.get('/sankalpas', authenticate, async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    
    // Aggregate completed sankalpas by user
    const leaderboard = await UserSankalp.aggregate([
      { $match: { status: 'completed' } },
      { 
        $group: { 
          _id: '$userId', 
          completedCount: { $sum: 1 },
          totalKarma: { $sum: { $add: ['$karmaEarned', '$completionBonusEarned'] } }
        } 
      },
      { $sort: { completedCount: -1, totalKarma: -1 } },
      { $limit: parseInt(limit) }
    ]);

    // Populate user details
    const leaderboardWithUsers = await Promise.all(
      leaderboard.map(async (entry) => {
        const user = await User.findById(entry._id).select('name email karmaPoints');
        return {
          rank: leaderboard.indexOf(entry) + 1,
          user: {
            _id: user._id,
            name: user.name,
            karmaPoints: user.karmaPoints
          },
          completedSankalpas: entry.completedCount,
          totalKarmaFromSankalpas: entry.totalKarma
        };
      })
    );

    res.json({
      success: true,
      data: leaderboardWithUsers
    });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch leaderboard', error: error.message });
  }
});

// GET /api/leaderboard/karma - Top karma earners
router.get('/karma', authenticate, async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    
    const leaderboard = await User.find()
      .select('name email karmaPoints')
      .sort({ karmaPoints: -1 })
      .limit(parseInt(limit));

    const leaderboardData = leaderboard.map((user, index) => ({
      rank: index + 1,
      user: {
        _id: user._id,
        name: user.name,
        karmaPoints: user.karmaPoints
      }
    }));

    res.json({
      success: true,
      data: leaderboardData
    });
  } catch (error) {
    console.error('Error fetching karma leaderboard:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch leaderboard', error: error.message });
  }
});

export default router;
