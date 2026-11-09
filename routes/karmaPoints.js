import express from 'express';
import User from '../models/User.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// GET /api/karma-points - Get karma points for authenticated user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user._id || req.user.userId;
    
    const user = await User.findById(userId).select('karmaPoints').lean();
    const karmaPoints = user?.karmaPoints || 0;
    
    res.json({ 
      karmaPoints,
      breakdown: {
        total: karmaPoints,
        available: karmaPoints
      }
    });
  } catch (error) {
    console.error('[Karma Points] Error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
