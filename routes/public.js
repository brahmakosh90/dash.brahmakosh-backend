import express from 'express';
import LiveAvatar from '../models/LiveAvatar.js';
import { extractS3KeyFromUrl, getPresignedUrl } from '../utils/storage.js';
import dailyPredictionRoutes from './public/dailyPrediction.js';

import { cacheGet } from '../utils/responseCache.js';
const router = express.Router();

router.use('/', dailyPredictionRoutes);
// GET /api/public/live-avatars - Get all active live avatars (public endpoint)
router.get('/live-avatars', cacheGet({ ttlSeconds: 60, tag: 'liveavatar' }), async (req, res) => {
  try {
    // Find all active avatars that are enabled
    const avatars = await LiveAvatar.find({
      status: 'active',
      isActive: true
    })
    .populate('clientId', 'clientId businessName')
    .sort({ createdAt: -1 });

    const avatarsWithUrls = await Promise.all(
      avatars.map(async (avatar) => {
        const avatarObj = avatar.toObject();
        
        if (avatarObj.videoKey || avatarObj.videoUrl) {
          try {
            const videoKey = avatarObj.videoKey || extractS3KeyFromUrl(avatarObj.videoUrl);
            if (videoKey) avatarObj.videoUrl = await getPresignedUrl(videoKey);
          } catch (error) {
            console.error('Error generating video presigned URL:', error);
          }
        }
        
        if (avatarObj.imageKey || avatarObj.imageUrl) {
          try {
            const imageKey = avatarObj.imageKey || extractS3KeyFromUrl(avatarObj.imageUrl);
            if (imageKey) avatarObj.imageUrl = await getPresignedUrl(imageKey);
          } catch (error) {
            console.error('Error generating image presigned URL:', error);
          }
        }
        
        // Add client info
        if (avatarObj.clientId && typeof avatarObj.clientId === 'object') {
          avatarObj.clientName = avatarObj.clientId.businessName || 'Unknown Client';
          avatarObj.clientId = avatarObj.clientId.clientId || avatarObj.clientId._id;
        }
        
        return avatarObj;
      })
    );

    res.json({
      success: true,
      data: avatarsWithUrls,
      count: avatarsWithUrls.length
    });
  } catch (error) {
    console.error('Error fetching public live avatars:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch live avatars',
      error: error.message
    });
  }
});

export default router;