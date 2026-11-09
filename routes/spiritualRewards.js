import mongoose from 'mongoose';
import express from 'express';
import SpiritualReward from '../models/SpiritualReward.js';
import User from '../models/User.js';
import { generateUploadUrl, deleteFile, getPresignedUrl } from '../utils/storage.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Helper function to get clientId
const getClientId = (req) => {
  // For client role, clientId is directly available in CLI-XXXXXX format
  if (req.user.role === 'client' && req.user.clientId) {
    return req.user.clientId;
  }
  
  // For user role, get from populated clientId or token
  if (req.user.role === 'user') {
    if (req.user.clientId && req.user.clientId.clientId) {
      return req.user.clientId.clientId;
    }
    if (req.user.tokenClientId) {
      return req.user.tokenClientId;
    }
  }

  // For admin/super_admin, clientId query param se lo (optional filter)
  if (req.user.role === 'admin' || req.user.role === 'super_admin') {
    return req.query.clientId || null;
  }
  
  throw new Error('Unable to determine clientId');
};

// Get single reward by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const clientId = getClientId(req);
    const userId = req.user._id || req.user.userId || req.user.id;

    // Fetch user's karma points
    let userKarmaPoints = 0;
    if (userId && req.user.role === 'user') {
      const user = await User.findById(userId).select('karmaPoints');
      if (user) {
        userKarmaPoints = user.karmaPoints || 0;
      }
    }

    const reward = await SpiritualReward.findOne({ _id: id, clientId });
    if (!reward) {
      return res.status(404).json({
        success: false,
        message: 'Reward not found'
      });
    }

    const rewardObj = reward.toObject();

    // Generate presigned URLs
    if (rewardObj.photoKey || rewardObj.photoUrl) {
      try {
        const photoKey = rewardObj.photoKey || rewardObj.photoUrl;
        if (photoKey) {
          rewardObj.image = await getPresignedUrl(photoKey);
        }
      } catch (error) {
        console.error('Failed to generate photo presigned URL:', error);
      }
    }

    if (rewardObj.bannerKey || rewardObj.bannerUrl) {
      try {
        const bannerKey = rewardObj.bannerKey || rewardObj.bannerUrl;
        if (bannerKey) {
          rewardObj.banner = await getPresignedUrl(bannerKey);
        }
      } catch (error) {
        console.error('Failed to generate banner presigned URL:', error);
      }
    }

    res.status(200).json({
      success: true,
      message: 'Reward fetched successfully',
      data: rewardObj,
      userKarmaPoints: userKarmaPoints
    });
  } catch (error) {
    console.error('Get reward error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch reward',
      error: error.message
    });
  }
});

// Get all rewards
router.get('/', authenticateToken, async (req, res) => {
  try {
    const clientId = getClientId(req);
    const userId = req.user._id || req.user.userId || req.user.id;
    
    console.log('=== GET REWARDS DEBUG ===');
    console.log('User from token:', {
      userId: userId,
      role: req.user.role,
      clientId: req.user.clientId,
      email: req.user.email
    });
    console.log('Generated clientId:', clientId);
    
    // Fetch user's karma points
    let userKarmaPoints = 0;
    if (userId && req.user.role === 'user') {
      const user = await User.findById(userId).select('karmaPoints');
      if (user) {
        userKarmaPoints = user.karmaPoints || 0;
      }
    }
    
    const query = clientId ? { clientId } : {};
    const rewards = await SpiritualReward.find(query)
      .sort({ createdAt: -1 });

    console.log('Found rewards count:', rewards.length);
    console.log('User karma points:', userKarmaPoints);

    // Generate presigned URLs for images
    const rewardsWithPresignedUrls = await Promise.all(
      rewards.map(async (reward) => {
        const rewardObj = reward.toObject();
        
        // Generate presigned URLs for photo and banner
        if (rewardObj.photoKey || rewardObj.photoUrl) {
          try {
            const photoKey = rewardObj.photoKey || rewardObj.photoUrl;
            if (photoKey) {
              rewardObj.photoKey = photoKey;
              rewardObj.image = await getPresignedUrl(photoKey);
            }
          } catch (error) {
            console.error('Failed to generate photo presigned URL:', error);
          }
        }
        
        if (rewardObj.bannerKey || rewardObj.bannerUrl) {
          try {
            const bannerKey = rewardObj.bannerKey || rewardObj.bannerUrl;
            if (bannerKey) {
              rewardObj.bannerKey = bannerKey;
              rewardObj.banner = await getPresignedUrl(bannerKey);
            }
          } catch (error) {
            console.error('Failed to generate banner presigned URL:', error);
          }
        }
        
        const { photoUrl, bannerUrl, ...cleanRewardObj } = rewardObj;
        
        return {
          _id: cleanRewardObj._id,
          title: cleanRewardObj.title,
          description: cleanRewardObj.description,
          category: cleanRewardObj.category,
          subcategory: cleanRewardObj.subcategory,
          karmaPointsRequired: cleanRewardObj.karmaPointsRequired,
          numberOfDevotees: cleanRewardObj.numberOfDevotees,
          devoteeMessage: cleanRewardObj.devoteeMessage,
          greetings: cleanRewardObj.greetings,
          isActive: cleanRewardObj.isActive,
          clientId: cleanRewardObj.clientId,
          createdBy: cleanRewardObj.createdBy,
          createdAt: cleanRewardObj.createdAt,
          updatedAt: cleanRewardObj.updatedAt,
          image: rewardObj.image,
          imageKey: rewardObj.photoKey,
          banner: rewardObj.banner,
          bannerKey: rewardObj.bannerKey
        };
      })
    );

    res.status(200).json({
      success: true,
      message: 'Rewards fetched successfully',
      data: rewardsWithPresignedUrls,
      userKarmaPoints: userKarmaPoints
    });
  } catch (error) {
    console.error('Get rewards error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch rewards',
      error: error.message
    });
  }
});

// Create new reward
router.post('/', authenticateToken, async (req, res) => {
  try {
    const clientId = getClientId(req);
    // Try different possible userId fields and convert to string
    const userId = (req.user._id || req.user.userId || req.user.id)?.toString();
    
    console.log('=== CREATE REWARD DEBUG ===');
    console.log('Full req.user object:', JSON.stringify(req.user, null, 2));
    console.log('Extracted userId:', userId);
    console.log('UserId type:', typeof userId);
    console.log('ClientId:', clientId);
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID not found in token'
      });
    }

    const {
      title,
      description,
      category,
      subcategory,
      karmaPointsRequired,
      numberOfDevotees,
      devoteeMessage,
      greetings,
      photoUrl,
      bannerUrl
    } = req.body;

    // Validate required fields
    if (!title || !description || !category || !subcategory) {
      return res.status(400).json({
        success: false,
        message: 'Title, description, category, and subcategory are required'
      });
    }

    // Create reward
    const reward = new SpiritualReward({
      title,
      description,
      category,
      subcategory,
      karmaPointsRequired: karmaPointsRequired || 0,
      numberOfDevotees: numberOfDevotees || 0,
      devoteeMessage,
      greetings,
      photoUrl,
      bannerUrl,
      photoKey: req.body.photoKey,
      bannerKey: req.body.bannerKey,
      clientId,
      createdBy: userId,
      createdByModel: req.user.role === 'client' ? 'Client' : req.user.role === 'user' ? 'User' : 'Admin'
    });

    console.log('Creating reward with:', {
      createdBy: userId,
      createdByModel: req.user.role === 'client' ? 'Client' : req.user.role === 'user' ? 'User' : 'Admin',
      userRole: req.user.role
    });

    await reward.save();

    res.status(201).json({
      success: true,
      message: 'Reward created successfully',
      data: reward
    });
  } catch (error) {
    console.error('Create reward error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create reward',
      error: error.message
    });
  }
});

// Update reward
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const clientId = getClientId(req);

    const {
      title,
      description,
      category,
      subcategory,
      karmaPointsRequired,
      numberOfDevotees,
      devoteeMessage,
      greetings,
      photoUrl,
      bannerUrl
    } = req.body;

    const reward = await SpiritualReward.findOne({ _id: id, clientId });
    if (!reward) {
      return res.status(404).json({
        success: false,
        message: 'Reward not found'
      });
    }

    // Update fields
    if (title) reward.title = title;
    if (description) reward.description = description;
    if (category) reward.category = category;
    if (subcategory) reward.subcategory = subcategory;
    if (karmaPointsRequired !== undefined) reward.karmaPointsRequired = karmaPointsRequired;
    if (numberOfDevotees !== undefined) reward.numberOfDevotees = numberOfDevotees;
    if (devoteeMessage !== undefined) reward.devoteeMessage = devoteeMessage;
    if (greetings !== undefined) reward.greetings = greetings;
    if (photoUrl) reward.photoUrl = photoUrl;
    if (bannerUrl) reward.bannerUrl = bannerUrl;
    if (req.body.photoKey) reward.photoKey = req.body.photoKey;
    if (req.body.bannerKey) reward.bannerKey = req.body.bannerKey;

    await reward.save();

    res.status(200).json({
      success: true,
      message: 'Reward updated successfully',
      data: reward
    });
  } catch (error) {
    console.error('Update reward error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update reward',
      error: error.message
    });
  }
});

// Delete reward
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const clientId = getClientId(req);

    const reward = await SpiritualReward.findOne({ _id: id, clientId });
    if (!reward) {
      return res.status(404).json({
        success: false,
        message: 'Reward not found'
      });
    }

    // Delete files from S3 if they exist
    if (reward.photoKey) {
      try {
        await deleteFile(reward.photoKey);
      } catch (error) {
        console.error('Failed to delete photo from S3:', error);
      }
    }

    if (reward.bannerKey) {
      try {
        await deleteFile(reward.bannerKey);
      } catch (error) {
        console.error('Failed to delete banner from S3:', error);
      }
    }

    await SpiritualReward.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: 'Reward deleted successfully'
    });
  } catch (error) {
    console.error('Delete reward error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete reward',
      error: error.message
    });
  }
});

// Toggle reward status
router.patch('/:id/toggle', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const clientId = getClientId(req);

    const reward = await SpiritualReward.findOne({ _id: id, clientId });
    if (!reward) {
      return res.status(404).json({
        success: false,
        message: 'Reward not found'
      });
    }

    reward.isActive = !reward.isActive;
    await reward.save();

    res.status(200).json({
      success: true,
      message: `Reward ${reward.isActive ? 'enabled' : 'disabled'} successfully`,
      data: { isActive: reward.isActive }
    });
  } catch (error) {
    console.error('Toggle reward error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle reward status',
      error: error.message
    });
  }
});

// Get upload URL for files
router.post('/upload-url', authenticateToken, async (req, res) => {
  try {
    const { fileName, fileType, mediaType } = req.body;
    const clientId = getClientId(req);

    if (!fileName || !fileType) {
      return res.status(400).json({
        success: false,
        message: 'fileName and fileType are required'
      });
    }

    // Generate unique key
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const fileExtension = fileName.split('.').pop();
    const cleanFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_').toLowerCase();
    const key = `spiritual-rewards/${clientId}/${mediaType}/${timestamp}-${randomString}-${cleanFileName}`;

    // Generate presigned URL
    const { uploadUrl, fileUrl } = await generateUploadUrl(fileName, fileType, key);

    res.status(200).json({
      success: true,
      uploadUrl,
      fileUrl,
      key
    });
  } catch (error) {
    console.error('Get upload URL error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate upload URL',
      error: error.message
    });
  }
});

export default router;