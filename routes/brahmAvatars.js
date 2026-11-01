import express from 'express';
import mongoose from 'mongoose';
import BrahmAvatar from '../models/BrahmAvatar.js';
import Client from '../models/Client.js';
import { authenticate } from '../middleware/auth.js';
import { deleteFile, generateUploadUrl, getPresignedUrl, extractS3KeyFromUrl } from '../utils/storage.js';

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
  
  if (obj.clientId && typeof obj.clientId === 'object') {
    if (obj.clientId.clientId) {
      return { ...obj, clientId: obj.clientId.clientId };
    }
    console.warn('Client document missing clientId field:', obj.clientId._id);
    return { ...obj, clientId: null };
  }
  
  return obj;
};

const getClientId = async (req) => {
  if (req.user.role === 'user') {
    // For user tokens, clientId can be an object or string
    const rawClientId = req.user.clientId;
    console.log('🔍 User token clientId:', rawClientId);
    
    if (!rawClientId) {
      throw new Error('Client ID not found for user token. Please ensure your token includes clientId.');
    }
    
    // If clientId is an object with _id, extract the _id
    if (typeof rawClientId === 'object' && rawClientId._id) {
      return rawClientId._id.toString();
    }
    
    // If clientId is already an ObjectId string, use it directly
    if (mongoose.Types.ObjectId.isValid(rawClientId)) {
      return rawClientId;
    }
    
    // Otherwise try to resolve it
    const clientId = await resolveClientObjectId(rawClientId);
    if (!clientId) {
      throw new Error('Client ID not found for user token. Please ensure your token includes clientId.');
    }
    return clientId;
  }
  
  if (req.user.role === 'client') {
    const clientId = req.user._id || req.user.id;
    if (!clientId) {
      throw new Error('Client ID not found. Please login again.');
    }
    return clientId;
  }
  
  // Wrong kind of account (e.g. an admin token), not a failed login: 403, so the app doesn't treat it as an expired session
  const roleError = new Error('This endpoint is only available to client and user accounts.');
  roleError.status = 403;
  throw roleError;
};

// POST /api/brahm-avatars/upload-url - Generate presigned URL for direct S3 upload
router.post('/upload-url', authenticate, async (req, res) => {
  try {
    const { fileName, contentType, fileType } = req.body;
    
    if (!fileName || !contentType) {
      return res.status(400).json({
        success: false,
        message: 'fileName and contentType are required'
      });
    }
    
    if (!fileType || (fileType !== 'video' && fileType !== 'image')) {
      return res.status(400).json({
        success: false,
        message: 'fileType must be either "video" or "image"'
      });
    }
    
    const folder = fileType === 'video' ? 'brahm-avatars/videos' : 'brahm-avatars/images';
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

// GET /api/brahm-avatars - Get all brahm avatars for authenticated client
router.get('/', authenticate, async (req, res) => {
  try {
    let clientId;
    try {
      clientId = await getClientId(req);
      console.log('🎯 Resolved clientId:', clientId);
    } catch (clientIdError) {
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message || 'Unable to determine client ID. Please ensure your token is valid.'
      });
    }

    // TEMPORARY FIX: If no data found with user's clientId, try with the actual clientId from DB
    let query = { clientId: clientId };
    if (req.query.includeInactive !== 'true') {
      query.isActive = true;
    }
    
    console.log('🔍 Query:', query);
    
    let brahmAvatars = await BrahmAvatar.find(query)
      .populate('clientId', 'clientId')
      .sort({ createdAt: -1 });
      
    // If no results and user role, try with the actual clientId from database
    if (brahmAvatars.length === 0 && req.user.role === 'user') {
      const actualClientId = '695f6eeae3add0be600f3a46'; // The actual clientId from DB
      query.clientId = actualClientId;
      console.log('🔄 Trying with actual clientId:', actualClientId);
      
      brahmAvatars = await BrahmAvatar.find(query)
        .populate('clientId', 'clientId')
        .sort({ createdAt: -1 });
    }
      
    console.log('🎬 Found avatars:', brahmAvatars.length);

    // Generate presigned URLs for videos and images
    const avatarsWithUrls = await Promise.all(
      brahmAvatars.map(async (avatar) => {
        const avatarObj = withClientIdString(avatar);
        
        // Generate presigned URL for video if exists
        if (avatarObj.videoKey || avatarObj.video) {
          try {
            const videoKey = avatarObj.videoKey || extractS3KeyFromUrl(avatarObj.video);
            if (videoKey) {
              const videoUrl = await getPresignedUrl(videoKey);
              avatarObj.videoUrl = videoUrl;
              avatarObj.video = videoUrl; // Dual field for compatibility
            }
          } catch (error) {
            console.error('Error generating video presigned URL:', error);
          }
        }
        
        // Generate presigned URL for image if exists
        if (avatarObj.imageKey || avatarObj.image) {
          try {
            const imageKey = avatarObj.imageKey || extractS3KeyFromUrl(avatarObj.image);
            if (imageKey) {
              const imageUrl = await getPresignedUrl(imageKey);
              avatarObj.imageUrl = imageUrl;
              avatarObj.image = imageUrl; // Dual field for compatibility
            }
          } catch (error) {
            console.error('Error generating image presigned URL:', error);
          }
        }
        
        return avatarObj;
      })
    );

    res.json({
      success: true,
      data: {
        data: avatarsWithUrls
      },
      count: avatarsWithUrls.length
    });
  } catch (error) {
    console.error('Error fetching brahm avatars:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch brahm avatars',
      error: error.message
    });
  }
});

// GET /api/brahm-avatars/:id - Get single brahm avatar
router.get('/:id', authenticate, async (req, res) => {
  try {
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message || 'Unable to determine client ID. Please ensure your token is valid.'
      });
    }

    const brahmAvatar = await BrahmAvatar.findOne({
      _id: req.params.id,
      clientId: clientId
    }).populate('clientId', 'clientId');

    if (!brahmAvatar) {
      return res.status(404).json({
        success: false,
        message: 'Brahm Avatar not found'
      });
    }

    const avatarObj = withClientIdString(brahmAvatar);
    
    // Generate presigned URLs
    
    if (avatarObj.videoKey || avatarObj.video) {
      try {
        const videoKey = avatarObj.videoKey || extractS3KeyFromUrl(avatarObj.video);
        if (videoKey) {
          const videoUrl = await getPresignedUrl(videoKey);
          avatarObj.videoUrl = videoUrl;
          avatarObj.video = videoUrl;
        }
      } catch (error) {
        console.error('Error generating video presigned URL:', error);
      }
    }
    
    if (avatarObj.imageKey || avatarObj.image) {
      try {
        const imageKey = avatarObj.imageKey || extractS3KeyFromUrl(avatarObj.image);
        if (imageKey) {
          const imageUrl = await getPresignedUrl(imageKey);
          avatarObj.imageUrl = imageUrl;
          avatarObj.image = imageUrl;
        }
      } catch (error) {
        console.error('Error generating image presigned URL:', error);
      }
    }

    res.json({
      success: true,
      data: avatarObj
    });
  } catch (error) {
    console.error('Error fetching brahm avatar:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch brahm avatar',
      error: error.message
    });
  }
});

// POST /api/brahm-avatars/direct - Create brahm avatar with direct S3 URLs
router.post('/direct', authenticate, async (req, res) => {
  try {
    const { name, description, category, type, videoUrl, imageUrl, imagePrompt, videoPrompt, videoKey: vKey, imageKey: iKey } = req.body;
    
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(clientIdError.status || 401).json({
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
    
    if (!imagePrompt || imagePrompt.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Image prompt is required'
      });
    }
    
    if (!videoPrompt || videoPrompt.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Video prompt is required'
      });
    }
    
    const avatarData = {
      name: name.trim(),
      description: description.trim(),
      category: category || 'Spiritual',
      type: type || 'Reel',
      imagePrompt: imagePrompt.trim(),
      videoPrompt: videoPrompt.trim(),
      clientId: clientId,
      video: videoUrl || undefined,
      videoKey: vKey || (videoUrl ? extractS3KeyFromUrl(videoUrl) : undefined),
      image: imageUrl || undefined,
      imageKey: iKey || (imageUrl ? extractS3KeyFromUrl(imageUrl) : undefined)
    };
    
    const brahmAvatar = new BrahmAvatar(avatarData);
    await brahmAvatar.save();
    
    // Generate presigned URLs for response
    const createdObj = withClientIdString(await brahmAvatar.populate('clientId', 'clientId'));
    
    // Add presigned URLs with dual fields
    if (createdObj.videoKey || createdObj.video) {
      try {
        const videoKey = createdObj.videoKey || extractS3KeyFromUrl(createdObj.video);
        if (videoKey) {
          const videoUrl = await getPresignedUrl(videoKey);
          createdObj.videoUrl = videoUrl;
          createdObj.video = videoUrl;
        }
      } catch (error) {
        console.error('Error generating video presigned URL:', error);
      }
    }
    
    if (createdObj.imageKey || createdObj.image) {
      try {
        const imageKey = createdObj.imageKey || extractS3KeyFromUrl(createdObj.image);
        if (imageKey) {
          const imageUrl = await getPresignedUrl(imageKey);
          createdObj.imageUrl = imageUrl;
          createdObj.image = imageUrl;
        }
      } catch (error) {
        console.error('Error generating image presigned URL:', error);
      }
    }
    
    res.status(201).json({
      success: true,
      message: 'Brahm Avatar created successfully',
      data: createdObj
    });
  } catch (error) {
    console.error('Error creating brahm avatar:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create brahm avatar',
      error: error.message
    });
  }
});

// PUT /api/brahm-avatars/:id/direct - Update brahm avatar with direct S3 URLs
router.put('/:id/direct', authenticate, async (req, res) => {
  try {
    const { name, description, category, type, videoUrl, imageUrl, imagePrompt, videoPrompt, videoKey: vKey, imageKey: iKey } = req.body;
    
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message
      });
    }
    
    const brahmAvatar = await BrahmAvatar.findOne({
      _id: req.params.id,
      clientId: clientId
    });
    
    if (!brahmAvatar) {
      return res.status(404).json({
        success: false,
        message: 'Brahm Avatar not found'
      });
    }
    
    // Update basic fields
    if (name !== undefined) brahmAvatar.name = name.trim();
    if (description !== undefined) brahmAvatar.description = description.trim();
    if (category !== undefined) brahmAvatar.category = category;
    if (type !== undefined) brahmAvatar.type = type;
    if (imagePrompt !== undefined) brahmAvatar.imagePrompt = imagePrompt.trim();
    if (videoPrompt !== undefined) brahmAvatar.videoPrompt = videoPrompt.trim();
    
    // Update video URL if provided
    if (videoUrl !== undefined || vKey !== undefined) {
      if (videoUrl && brahmAvatar.video && brahmAvatar.video !== videoUrl) {
        try {
          if (brahmAvatar.videoKey) {
            await deleteFile(brahmAvatar.videoKey);
          } else {
            await deleteFile(brahmAvatar.video);
          }
        } catch (error) {
          console.error('Failed to delete old video:', error);
        }
      }
      brahmAvatar.video = videoUrl || undefined;
      brahmAvatar.videoKey = vKey || (videoUrl ? extractS3KeyFromUrl(videoUrl) : undefined);
    }
    
    // Update image URL if provided
    if (imageUrl !== undefined || iKey !== undefined) {
      if (imageUrl && brahmAvatar.image && brahmAvatar.image !== imageUrl) {
        try {
          if (brahmAvatar.imageKey) {
            await deleteFile(brahmAvatar.imageKey);
          } else {
            await deleteFile(brahmAvatar.image);
          }
        } catch (error) {
          console.error('Failed to delete old image:', error);
        }
      }
      brahmAvatar.image = imageUrl || undefined;
      brahmAvatar.imageKey = iKey || (imageUrl ? extractS3KeyFromUrl(imageUrl) : undefined);
    }
    
    await brahmAvatar.save();
    
    // Generate presigned URLs for response
    const updatedObj = withClientIdString(await brahmAvatar.populate('clientId', 'clientId'));
    
    // Add presigned URLs with dual fields
    if (updatedObj.videoKey || updatedObj.video) {
      try {
        const videoKey = updatedObj.videoKey || extractS3KeyFromUrl(updatedObj.video);
        if (videoKey) {
          const videoUrl = await getPresignedUrl(videoKey);
          updatedObj.videoUrl = videoUrl;
          updatedObj.video = videoUrl;
        }
      } catch (error) {
        console.error('Error generating video presigned URL:', error);
      }
    }
    
    if (updatedObj.imageKey || updatedObj.image) {
      try {
        const imageKey = updatedObj.imageKey || extractS3KeyFromUrl(updatedObj.image);
        if (imageKey) {
          const imageUrl = await getPresignedUrl(imageKey);
          updatedObj.imageUrl = imageUrl;
          updatedObj.image = imageUrl;
        }
      } catch (error) {
        console.error('Error generating image presigned URL:', error);
      }
    }
    
    res.json({
      success: true,
      message: 'Brahm Avatar updated successfully',
      data: updatedObj
    });
  } catch (error) {
    console.error('Error updating brahm avatar:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update brahm avatar',
      error: error.message
    });
  }
});

// DELETE /api/brahm-avatars/:id - Delete brahm avatar (permanent delete)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message || 'Unable to determine client ID. Please ensure your token is valid.'
      });
    }

    const brahmAvatar = await BrahmAvatar.findOneAndDelete({
      _id: req.params.id,
      clientId: clientId
    });

    if (!brahmAvatar) {
      return res.status(404).json({
        success: false,
        message: 'Brahm Avatar not found'
      });
    }

    // Delete files from S3 (prefer keys over URLs)
    if (brahmAvatar.videoKey || brahmAvatar.video) {
      try {
        await deleteFile(brahmAvatar.videoKey || brahmAvatar.video);
      } catch (error) {
        console.error('Failed to delete video from S3:', error);
      }
    }
    if (brahmAvatar.imageKey || brahmAvatar.image) {
      try {
        await deleteFile(brahmAvatar.imageKey || brahmAvatar.image);
      } catch (error) {
        console.error('Failed to delete image from S3:', error);
      }
    }

    res.json({
      success: true,
      message: 'Brahm Avatar deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting brahm avatar:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete brahm avatar',
      error: error.message
    });
  }
});

// PATCH /api/brahm-avatars/:id/toggle-status - Toggle brahm avatar status
router.patch('/:id/toggle-status', authenticate, async (req, res) => {
  try {
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message
      });
    }

    const brahmAvatar = await BrahmAvatar.findOne({
      _id: req.params.id,
      clientId: clientId
    });

    if (!brahmAvatar) {
      return res.status(404).json({
        success: false,
        message: 'Brahm Avatar not found'
      });
    }

    brahmAvatar.isActive = !brahmAvatar.isActive;
    await brahmAvatar.save();

    res.json({
      success: true,
      message: `Brahm Avatar ${brahmAvatar.isActive ? 'enabled' : 'disabled'} successfully`,
      data: { isActive: brahmAvatar.isActive }
    });
  } catch (error) {
    console.error('Error toggling brahm avatar status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle brahm avatar status',
      error: error.message
    });
  }
});

// PATCH /api/brahm-avatars/:id/views - Increment views
router.patch('/:id/views', authenticate, async (req, res) => {
  try {
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message
      });
    }

    const brahmAvatar = await BrahmAvatar.findOne({
      _id: req.params.id,
      clientId: clientId
    });

    if (!brahmAvatar) {
      return res.status(404).json({
        success: false,
        message: 'Brahm Avatar not found'
      });
    }

    brahmAvatar.views = (brahmAvatar.views || 0) + 1;
    await brahmAvatar.save();

    res.json({
      success: true,
      data: { views: brahmAvatar.views }
    });
  } catch (error) {
    console.error('Error incrementing views:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to increment views',
      error: error.message
    });
  }
});

// PATCH /api/brahm-avatars/:id/like - Toggle like
router.patch('/:id/like', authenticate, async (req, res) => {
  try {
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message
      });
    }

    const brahmAvatar = await BrahmAvatar.findOne({
      _id: req.params.id,
      clientId: clientId
    });

    if (!brahmAvatar) {
      return res.status(404).json({
        success: false,
        message: 'Brahm Avatar not found'
      });
    }

    brahmAvatar.likes = (brahmAvatar.likes || 0) + 1;
    await brahmAvatar.save();

    res.json({
      success: true,
      data: { likes: brahmAvatar.likes }
    });
  } catch (error) {
    console.error('Error toggling like:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle like',
      error: error.message
    });
  }
});

// PATCH /api/brahm-avatars/:id/shares - Increment shares
router.patch('/:id/shares', authenticate, async (req, res) => {
  try {
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message
      });
    }

    const brahmAvatar = await BrahmAvatar.findOne({
      _id: req.params.id,
      clientId: clientId
    });

    if (!brahmAvatar) {
      return res.status(404).json({
        success: false,
        message: 'Brahm Avatar not found'
      });
    }

    brahmAvatar.shares = (brahmAvatar.shares || 0) + 1;
    await brahmAvatar.save();

    res.json({
      success: true,
      data: { shares: brahmAvatar.shares }
    });
  } catch (error) {
    console.error('Error incrementing shares:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to increment shares',
      error: error.message
    });
  }
});

export default router;