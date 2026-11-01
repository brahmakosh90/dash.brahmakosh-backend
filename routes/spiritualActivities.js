import express from 'express';
import mongoose from 'mongoose';
import SpiritualActivity from '../models/SpiritualActivity.js';
import Client from '../models/Client.js';
import multer from 'multer';
import { uploadFile, deleteFile, getPresignedUrl, extractS3KeyFromUrl } from '../utils/storage.js';
import { authenticate } from '../middleware/auth.js';

import { cacheGet } from '../utils/responseCache.js';
const router = express.Router();

const resolveClientObjectId = async (candidate) => {
  if (!candidate) return null;
  if (mongoose.Types.ObjectId.isValid(candidate)) return candidate;
  const client = await Client.findOne({ clientId: candidate }).select('_id');
  return client?._id || null;
};

const getClientId = async (req) => {
  if (req.user.role === 'user') {
    const rawClientId = req.decodedClientId || req.user.clientId?._id || req.user.clientId || req.user.tokenClientId || req.user.clientId?.clientId;
    const clientId = await resolveClientObjectId(rawClientId);
    if (!clientId) {
      throw new Error('Client ID not found for user token. Please ensure your token includes clientId.');
    }
    return clientId;
  }
  const rawClientId = req.user._id || req.user.id || req.user.clientId;
  const clientId = await resolveClientObjectId(rawClientId);
  if (!clientId) {
    throw new Error('Client ID not found. Please login again.');
  }
  return clientId;
};

const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// GET all spiritual activities
router.get('/', authenticate, cacheGet({ ttlSeconds: 30, tag: 'activities', perUser: true }), async (req, res) => {
  try {
    const query = { isDeleted: false };
    
    if (req.query.includeInactive !== 'true') {
      query.isActive = true;
    }
    const activities = await SpiritualActivity.find(query)
      .populate('clientId', 'clientId')
      .sort({ createdAt: -1 });
    
    const activitiesWithUrls = await Promise.all(
      activities.map(async (activity) => {
        const activityObj = activity.toObject();
        if (activityObj.imageKey || activityObj.image) {
          try {
            const imageKey = activityObj.imageKey || extractS3KeyFromUrl(activityObj.image);
            if (imageKey) {
              activityObj.image = await getPresignedUrl(imageKey, 604800);
            }
          } catch (error) {
            console.error('Error generating image presigned URL:', error);
          }
        }
        return activityObj;
      })
    );
    
    res.json({ success: true, data: activitiesWithUrls, count: activitiesWithUrls.length });
  } catch (error) {
    console.error('Get spiritual activities error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET single spiritual activity
router.get('/:id', authenticate, async (req, res) => {
  try {
    const activity = await SpiritualActivity.findOne({
      _id: req.params.id,
      isDeleted: false
    }).populate('clientId', 'clientId');
    
    if (!activity) {
      return res.status(404).json({ success: false, message: 'Spiritual activity not found' });
    }
    
    const activityObj = activity.toObject();
    if (activityObj.imageKey || activityObj.image) {
      try {
        const imageKey = activityObj.imageKey || extractS3KeyFromUrl(activityObj.image);
        if (imageKey) {
          activityObj.image = await getPresignedUrl(imageKey, 604800);
        }
      } catch (error) {
        console.error('Error generating image presigned URL:', error);
      }
    }
    
    res.json({ success: true, data: activityObj });
  } catch (error) {
    console.error('Get spiritual activity error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// CREATE new spiritual activity
router.post('/', authenticate, async (req, res) => {
  try {
    const { title, description } = req.body;
    
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(401).json({
        success: false,
        message: clientIdError.message || 'Unable to determine client ID. Please ensure your token is valid.'
      });
    }
    
    if (!['client', 'user'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Client or user role required.'
      });
    }
    
    if (!title || !description) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: title and description are required' 
      });
    }
    
    const newActivity = new SpiritualActivity({
      title,
      description,
      clientId: clientId
    });
    
    const savedActivity = await newActivity.save();
    await savedActivity.populate('clientId', 'clientId');
    res.status(201).json({ success: true, data: savedActivity });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Upload image for spiritual activity
router.post('/:id/upload-image', authenticate, upload.single('image'), async (req, res) => {
  try {
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(401).json({
        success: false,
        message: clientIdError.message || 'Unable to determine client ID. Please ensure your token is valid.'
      });
    }
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided'
      });
    }

    const activity = await SpiritualActivity.findOne({
      _id: req.params.id,
      isDeleted: false
    }).populate('clientId', 'clientId');
    
    if (!activity) {
      return res.status(404).json({
        success: false,
        message: 'Spiritual activity not found'
      });
    }

    const uploadResult = await uploadFile(req.file, 'spiritual-activities/images');
    const imageKey = uploadResult.key;

    activity.image = uploadResult.url || null;
    activity.imageKey = imageKey;
    await activity.save();

    // Generate presigned URL for immediate use
    const presignedUrl = await getPresignedUrl(imageKey, 604800);

    res.json({
      success: true,
      message: 'Image uploaded successfully',
      data: {
        imageUrl: presignedUrl,
        imageKey: imageKey,
      }
    });
  } catch (error) {
    console.error('Upload image error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload image',
      error: error.message
    });
  }
});

// UPDATE spiritual activity
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { title, description, isActive } = req.body;
    
    if (!['client', 'user'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Client or user role required.'
      });
    }
    
    const activity = await SpiritualActivity.findOne({
      _id: req.params.id,
      isDeleted: false
    });
    
    if (!activity) {
      return res.status(404).json({ success: false, message: 'Spiritual activity not found' });
    }
    
    const updateData = {};
    
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (isActive !== undefined) updateData.isActive = Boolean(isActive);
    
    const updatedActivity = await SpiritualActivity.findOneAndUpdate(
      {
        _id: req.params.id,
        isDeleted: false
      },
      updateData,
      { new: true, runValidators: false }
    ).populate('clientId', 'clientId');
    
    if (!updatedActivity) {
      return res.status(404).json({ success: false, message: 'Spiritual activity not found' });
    }
    
    res.json({ success: true, data: updatedActivity });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// DELETE spiritual activity (soft delete)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    if (!['client', 'user'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Client or user role required.'
      });
    }
    
    const activity = await SpiritualActivity.findOne({
      _id: req.params.id,
      isDeleted: false
    });
    
    if (!activity) {
      return res.status(404).json({ success: false, message: 'Spiritual activity not found' });
    }
    
    activity.isDeleted = true;
    await activity.save();
    
    res.json({ success: true, message: 'Spiritual activity deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// TOGGLE enable/disable (isActive)
router.patch('/:id/toggle', authenticate, async (req, res) => {
  try {
    if (!['client', 'user'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Client or user role required.'
      });
    }
    
    const activity = await SpiritualActivity.findOne({
      _id: req.params.id,
      isDeleted: false
    }).populate('clientId', 'clientId');
    
    if (!activity) {
      return res.status(404).json({ success: false, message: 'Spiritual activity not found' });
    }
    
    activity.isActive = !activity.isActive;
    const updatedActivity = await activity.save();
    
    res.json({ 
      success: true, 
      data: updatedActivity,
      message: `Spiritual activity ${updatedActivity.isActive ? 'enabled' : 'disabled'} successfully`
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;