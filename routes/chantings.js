import express from 'express';
import mongoose from 'mongoose';
import Chanting from '../models/Chanting.js';
import Client from '../models/Client.js';
import { authenticate } from '../middleware/auth.js';
import { deleteFile, generateUploadUrl, getPresignedUrl, extractS3KeyFromUrl } from '../utils/storage.js';
import { sanitizeMantraText } from '../utils/mantraText.js';

const router = express.Router();

// Helper functions
const resolveClientObjectId = async (candidate) => {
  if (!candidate) return null;
  if (mongoose.Types.ObjectId.isValid(candidate)) return candidate;
  const client = await Client.findOne({ clientId: candidate }).select('_id');
  return client?._id || null;
};

const withClientIdString = (doc) => {
  if (!doc) return doc;
  const obj = doc.toObject ? doc.toObject() : doc;
  
  // If clientId is populated with Client document
  if (obj.clientId && typeof obj.clientId === 'object') {
    // Extract clientId string field (CLI-ABC123 format)
    if (obj.clientId.clientId) {
      return { ...obj, clientId: obj.clientId.clientId };
    }
    // Fallback: If clientId field missing in Client document
    console.warn('Client document missing clientId field:', obj.clientId._id);
    return { ...obj, clientId: null };
  }
  
  return obj;
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
  
  // For client role, their _id IS the clientId (no need to resolve)
  if (req.user.role === 'client') {
    const clientId = req.user._id || req.user.id;
    if (!clientId) {
      throw new Error('Client ID not found. Please login again.');
    }
    return clientId; // Return the ObjectId directly
  }
  
  throw new Error('Invalid role for this operation.');
};

// POST /api/chantings/upload-url - Generate presigned URL for direct S3 upload
router.post('/upload-url', authenticate, async (req, res) => {
  try {
    const { fileName, contentType, fileType } = req.body;
    
    if (!fileName || !contentType) {
      return res.status(400).json({
        success: false,
        message: 'fileName and contentType are required'
      });
    }
    
    if (!['video', 'image', 'audio'].includes(fileType)) {
      return res.status(400).json({
        success: false,
        message: 'fileType must be "video", "image" or "audio"'
      });
    }
    
    const folder = fileType === 'video' ? 'chantings/videos' : fileType === 'audio' ? 'chantings/audio' : 'chantings/images';
    const { uploadUrl, fileUrl, key } = await generateUploadUrl(fileName, contentType, folder);
    
    res.json({
      success: true,
      data: { uploadUrl, fileUrl, key }
    });
  } catch (error) {
    console.error('Error generating upload URL:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate upload URL',
      error: error.message
    });
  }
});

// GET /api/chantings - Get all chantings for authenticated client
router.get('/', authenticate, async (req, res) => {
  try {
    console.log('=== CHANTING GET REQUEST START ===');
    console.log('User info:', {
      id: req.user?._id?.toString(),
      role: req.user?.role,
      email: req.user?.email
    });
    
    let clientId;
    try {
      clientId = await getClientId(req);
      console.log('Resolved client ID for query:', clientId?.toString());
    } catch (clientIdError) {
      console.error('Client ID resolution error in GET:', clientIdError);
      return res.status(401).json({
        success: false,
        message: clientIdError.message || 'Unable to determine client ID. Please ensure your token is valid.'
      });
    }

    const query = { clientId: clientId, isActive: true };
    console.log('MongoDB query:', query);

    const chantings = await Chanting.find(query)
      .populate('clientId', 'clientId')
      .sort({ createdAt: -1 });
    
    console.log('Found chantings:', chantings.length);
    console.log('Chanting details:', chantings.map(c => ({
      id: c._id.toString(),
      name: c.name,
      malaCount: c.malaCount,
      totalCount: c.totalCount,
      hasVideo: !!c.videoUrl,
      hasImage: !!c.imageUrl,
      clientId: c.clientId?.toString()
    })));

    const chantingsWithUrls = await Promise.all(
      chantings.map(async (chanting) => {
        const chantingObj = withClientIdString(chanting);
        
        // Generate presigned URL for video if exists
        if (chantingObj.videoKey || chantingObj.videoUrl) {
          try {
            // Use stored key if available, otherwise extract from URL
            const videoKey = chantingObj.videoKey || extractS3KeyFromUrl(chantingObj.videoUrl);
            if (videoKey) {
              chantingObj.videoUrl = await getPresignedUrl(videoKey);
            }
          } catch (error) {
            console.error('Error generating video presigned URL:', error);
          }
        }
        
        // Generate presigned URL for image if exists
        if (chantingObj.imageKey || chantingObj.imageUrl) {
          try {
            // Use stored key if available, otherwise extract from URL
            const imageKey = chantingObj.imageKey || extractS3KeyFromUrl(chantingObj.imageUrl);
            if (imageKey) {
              chantingObj.imageUrl = await getPresignedUrl(imageKey);
            }
          } catch (error) {
            console.error('Error generating image presigned URL:', error);
          }
        }
        
        return chantingObj;
      })
    );

    res.json({
      success: true,
      data: chantingsWithUrls,
      count: chantingsWithUrls.length
    });
  } catch (error) {
    console.error('Error fetching chantings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch chantings',
      error: error.message
    });
  }
});

// GET /api/chantings/:id - Get single chanting
router.get('/:id', authenticate, async (req, res) => {
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

    const chanting = await Chanting.findOne({
      _id: req.params.id,
      clientId: clientId,
      isActive: true
    }).populate('clientId', 'clientId');

    if (!chanting) {
      return res.status(404).json({
        success: false,
        message: 'Chanting not found'
      });
    }

    const chantingObj = withClientIdString(chanting);
    const cvk = chantingObj.videoKey || extractS3KeyFromUrl(chantingObj.videoUrl);
    if (cvk) { try { chantingObj.videoUrl = await getPresignedUrl(cvk); } catch(e) {} }
    const cik = chantingObj.imageKey || extractS3KeyFromUrl(chantingObj.imageUrl);
    if (cik) { try { chantingObj.imageUrl = await getPresignedUrl(cik); } catch(e) {} }
    res.json({ success: true, data: chantingObj });
  } catch (error) {
    console.error('Error fetching chanting:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch chanting',
      error: error.message
    });
  }
});

// POST /api/chantings/direct - Create chanting with direct S3 URLs
router.post('/direct', authenticate, async (req, res) => {
  try {
    console.log('=== CHANTING CREATE REQUEST ===');
    console.log('User:', req.user._id, 'Role:', req.user.role);
    console.log('Request body:', req.body);
    
    const { name, description, malaCount, videoUrl, imageUrl, link, duration, videoKey: vKey, imageKey: iKey, audioUrl, audioKey: aKey, mantraText } = req.body;
    
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(401).json({
        success: false,
        message: clientIdError.message
      });
    }
    
    // Validation
    if (!name || name.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Name is required'
      });
    }
    
    if (!description || description.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Description is required'
      });
    }
    
    if (!malaCount || typeof malaCount !== 'number') {
      return res.status(400).json({
        success: false,
        message: 'Mala count is required and must be a number'
      });
    }
    
    if (malaCount < 1 || malaCount > 108) {
      return res.status(400).json({
        success: false,
        message: 'Mala count must be between 1 and 108'
      });
    }
    
    const chantingData = {
      name: name.trim(),
      description: description.trim(),
      malaCount: malaCount,
      clientId: clientId,
      videoUrl: videoUrl || undefined,
      videoKey: vKey || (videoUrl ? extractS3KeyFromUrl(videoUrl) : undefined),
      imageUrl: imageUrl || undefined,
      imageKey: iKey || (imageUrl ? extractS3KeyFromUrl(imageUrl) : undefined),
      link: link ? link.trim() : undefined,
      duration: duration || undefined,
      audioUrl: audioUrl || undefined,
      audioKey: aKey || (audioUrl ? extractS3KeyFromUrl(audioUrl) : undefined),
      ...(mantraText !== undefined && { mantraText: sanitizeMantraText(mantraText) })
    };
    
    console.log('Files:', { video: !!videoUrl, image: !!imageUrl });
    
    const chanting = new Chanting(chantingData);
    await chanting.save();
    
    console.log('✅ Chanting created:', chanting._id);
    
    res.status(201).json({
      success: true,
      message: 'Chanting created successfully',
      data: withClientIdString(await chanting.populate('clientId', 'clientId'))
    });
  } catch (error) {
    console.error('Error creating chanting:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create chanting',
      error: error.message
    });
  }
});

// PUT /api/chantings/:id/direct - Update chanting with direct S3 URLs
router.put('/:id/direct', authenticate, async (req, res) => {
  try {
    console.log('=== CHANTING UPDATE REQUEST ===');
    console.log('Chanting ID:', req.params.id);
    console.log('Request body:', req.body);
    
    const { name, description, malaCount, videoUrl, imageUrl, link, duration, videoKey: vKey, imageKey: iKey, audioUrl, audioKey: aKey, mantraText } = req.body;
    
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(401).json({
        success: false,
        message: clientIdError.message
      });
    }
    
    const chanting = await Chanting.findOne({
      _id: req.params.id,
      clientId: clientId,
      isActive: true
    });
    
    if (!chanting) {
      return res.status(404).json({
        success: false,
        message: 'Chanting not found'
      });
    }
    
    // Update basic fields
    if (name !== undefined) chanting.name = name.trim();
    if (description !== undefined) chanting.description = description.trim();
    if (link !== undefined) chanting.link = link ? link.trim() : '';
    if (duration !== undefined) chanting.duration = duration;
    if (mantraText !== undefined) chanting.mantraText = sanitizeMantraText(mantraText);
    if (audioUrl || aKey) {
      chanting.audioUrl = audioUrl || null;
      chanting.audioKey = aKey || (audioUrl ? extractS3KeyFromUrl(audioUrl) : null);
    }
    
    // Update malaCount if provided (will trigger totalCount recalculation)
    if (malaCount !== undefined) {
      if (typeof malaCount !== 'number' || malaCount < 1 || malaCount > 108) {
        return res.status(400).json({
          success: false,
          message: 'Mala count must be a number between 1 and 108'
        });
      }
      chanting.malaCount = malaCount;
      // totalCount will be auto-calculated by pre-save hook
    }
    
    // Update video URL if provided
    if (videoUrl !== undefined || vKey !== undefined) {
      if (videoUrl && chanting.videoUrl && chanting.videoUrl !== videoUrl) {
        try {
          if (chanting.videoKey) {
            await deleteFile(chanting.videoKey);
          } else {
            await deleteFile(chanting.videoUrl);
          }
          console.log('✅ Old video deleted from S3');
        } catch (error) {
          console.error('Failed to delete old video:', error);
        }
      }
      chanting.videoUrl = videoUrl || undefined;
      chanting.videoKey = vKey || (videoUrl ? extractS3KeyFromUrl(videoUrl) : undefined);
    }
    
    // Update image URL if provided
    if (imageUrl !== undefined || iKey !== undefined) {
      if (imageUrl && chanting.imageUrl && chanting.imageUrl !== imageUrl) {
        try {
          if (chanting.imageKey) {
            await deleteFile(chanting.imageKey);
          } else {
            await deleteFile(chanting.imageUrl);
          }
          console.log('✅ Old image deleted from S3');
        } catch (error) {
          console.error('Failed to delete old image:', error);
        }
      }
      chanting.imageUrl = imageUrl || undefined;
      chanting.imageKey = iKey || (imageUrl ? extractS3KeyFromUrl(imageUrl) : undefined);
    }
    
    await chanting.save();
    console.log('✅ Chanting updated:', chanting._id);
    
    res.json({
      success: true,
      message: 'Chanting updated successfully',
      data: withClientIdString(await chanting.populate('clientId', 'clientId'))
    });
  } catch (error) {
    console.error('Error updating chanting:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update chanting',
      error: error.message
    });
  }
});

// DELETE /api/chantings/:id - Delete chanting (permanent delete)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    console.log('=== DELETE CHANTING REQUEST ===');
    console.log('Chanting ID:', req.params.id);
    
    let clientId;
    try {
      clientId = await getClientId(req);
      console.log('Client ID:', clientId?.toString());
    } catch (clientIdError) {
      return res.status(401).json({
        success: false,
        message: clientIdError.message || 'Unable to determine client ID. Please ensure your token is valid.'
      });
    }

    const chanting = await Chanting.findOneAndDelete({
      _id: req.params.id,
      clientId: clientId
    });

    if (!chanting) {
      console.log('❌ Chanting not found');
      return res.status(404).json({
        success: false,
        message: 'Chanting not found'
      });
    }

    console.log('✅ Chanting deleted from database:', chanting._id.toString());

    // Delete files from S3 (prefer keys over URLs)
    if (chanting.videoKey || chanting.videoUrl) {
      try {
        await deleteFile(chanting.videoKey || chanting.videoUrl);
        console.log('✅ Video deleted from S3');
      } catch (error) {
        console.error('Failed to delete video from S3:', error);
      }
    }
    if (chanting.imageKey || chanting.imageUrl) {
      try {
        await deleteFile(chanting.imageKey || chanting.imageUrl);
        console.log('✅ Image deleted from S3');
      } catch (error) {
        console.error('Failed to delete image from S3:', error);
      }
    }

    res.json({
      success: true,
      message: 'Chanting deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting chanting:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete chanting',
      error: error.message
    });
  }
});

// PATCH /api/chantings/:id/toggle-status - Toggle chanting status
router.patch('/:id/toggle-status', authenticate, async (req, res) => {
  try {
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(401).json({
        success: false,
        message: clientIdError.message
      });
    }

    const chanting = await Chanting.findOne({
      _id: req.params.id,
      clientId: clientId
    });

    if (!chanting) {
      return res.status(404).json({
        success: false,
        message: 'Chanting not found'
      });
    }

    chanting.isActive = !chanting.isActive;
    await chanting.save();

    res.json({
      success: true,
      message: `Chanting ${chanting.isActive ? 'enabled' : 'disabled'} successfully`,
      data: { isActive: chanting.isActive }
    });
  } catch (error) {
    console.error('Error toggling chanting status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle chanting status',
      error: error.message
    });
  }
});

export default router;
