import express from 'express';
import mongoose from 'mongoose';
import LiveAvatar from '../models/LiveAvatar.js';
import Client from '../models/Client.js';
import { authenticate } from '../middleware/auth.js';
import { uploadFile, deleteFile, generateUploadUrl, getPresignedUrl, extractS3KeyFromUrl } from '../utils/storage.js';

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
    const rawClientId = req.decodedClientId || req.user.clientId?._id || req.user.clientId || req.user.tokenClientId || req.user.clientId?.clientId;
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

// POST /api/live-avatars/upload-url - Generate presigned URL for direct S3 upload
router.post('/upload-url', authenticate, async (req, res) => {
  try {
    const { fileName, contentType, fileType } = req.body;
    
    if (!fileName || !contentType) {
      return res.status(400).json({
        success: false,
        message: 'fileName and contentType are required'
      });
    }
    
    const folder = fileType === 'video' ? 'live-avatars/videos' : 'live-avatars/images';
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

// POST /api/live-avatars/direct - Create live avatar with direct S3 URLs
router.post('/direct', authenticate, async (req, res) => {
  try {
    const { name, description, agentId, gender, category, link, videoUrl, imageUrl, videoKey: vKey, imageKey: iKey } = req.body;
    
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message
      });
    }
    
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

    if (!agentId || agentId.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Agent ID is required'
      });
    }
    
    const avatarData = {
      name: name.trim(),
      description: description.trim(),
      agentId: agentId.trim(),
      gender: gender || 'Male',
      category: category || 'Deity',
      link: link ? link.trim() : '',
      clientId: clientId,
      videoUrl: videoUrl || undefined,
      videoKey: vKey || (videoUrl ? extractS3KeyFromUrl(videoUrl) : undefined),
      imageUrl: imageUrl || undefined,
      imageKey: iKey || (imageUrl ? extractS3KeyFromUrl(imageUrl) : undefined)
    };
    
    const avatar = new LiveAvatar(avatarData);
    await avatar.save();
    
    // Generate presigned URLs for the new avatar
    const avatarObj = withClientIdString(await avatar.populate('clientId', 'clientId'));
    
    // Generate presigned URL for video if exists
    if (avatarObj.videoKey || avatarObj.videoUrl) {
      try {
        const videoKey = avatarObj.videoKey || extractS3KeyFromUrl(avatarObj.videoUrl);
        if (videoKey) {
          avatarObj.videoUrl = await getPresignedUrl(videoKey);
        }
      } catch (error) {
        console.error('Error generating video presigned URL:', error);
      }
    }
    
    // Generate presigned URL for image if exists
    if (avatarObj.imageKey || avatarObj.imageUrl) {
      try {
        const imageKey = avatarObj.imageKey || extractS3KeyFromUrl(avatarObj.imageUrl);
        if (imageKey) {
          avatarObj.imageUrl = await getPresignedUrl(imageKey);
        }
      } catch (error) {
        console.error('Error generating image presigned URL:', error);
      }
    }
    
    res.status(201).json({
      success: true,
      message: 'Live avatar created successfully',
      data: avatarObj
    });
  } catch (error) {
    console.error('Error creating live avatar:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create live avatar',
      error: error.message
    });
  }
});

// GET /api/public/live-avatars - Get all active live avatars (public endpoint)
router.get('/public', async (req, res) => {
  try {
    const query = { isActive: true };
    const avatars = await LiveAvatar.find(query)
      .populate('clientId', 'clientId')
      .sort({ createdAt: -1 });

    // Generate presigned URLs for images and videos
    const avatarsWithUrls = await Promise.all(
      avatars.map(async (avatar) => {
        const avatarObj = withClientIdString(avatar);
        
        // Generate presigned URL for video if exists
        if (avatarObj.videoKey || avatarObj.videoUrl) {
          try {
            const videoKey = avatarObj.videoKey || extractS3KeyFromUrl(avatarObj.videoUrl);
            if (videoKey) {
              avatarObj.videoUrl = await getPresignedUrl(videoKey);
            }
          } catch (error) {
            console.error('Error generating video presigned URL:', error);
          }
        }
        
        // Generate presigned URL for image if exists
        if (avatarObj.imageKey || avatarObj.imageUrl) {
          try {
            const imageKey = avatarObj.imageKey || extractS3KeyFromUrl(avatarObj.imageUrl);
            if (imageKey) {
              avatarObj.imageUrl = await getPresignedUrl(imageKey);
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

// GET /api/live-avatars - Get all live avatars for authenticated client
router.get('/', authenticate, async (req, res) => {
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

    const query = { clientId: clientId };
    const avatars = await LiveAvatar.find(query)
      .populate('clientId', 'clientId')
      .sort({ createdAt: -1 });

    // Generate presigned URLs for images and videos
    const avatarsWithUrls = await Promise.all(
      avatars.map(async (avatar) => {
        const avatarObj = withClientIdString(avatar);
        
        // Ensure category field exists (backward compatibility)
        if (!avatarObj.category) {
          avatarObj.category = 'Deity';
          // Update in database
          await LiveAvatar.updateOne(
            { _id: avatarObj._id },
            { $set: { category: 'Deity' } }
          );
        }
        
        // Generate presigned URL for video if exists
        if (avatarObj.videoKey || avatarObj.videoUrl) {
          try {
            const videoKey = avatarObj.videoKey || extractS3KeyFromUrl(avatarObj.videoUrl);
            if (videoKey) {
              avatarObj.videoUrl = await getPresignedUrl(videoKey);
            }
          } catch (error) {
            console.error('Error generating video presigned URL:', error);
          }
        }
        
        // Generate presigned URL for image if exists
        if (avatarObj.imageKey || avatarObj.imageUrl) {
          try {
            const imageKey = avatarObj.imageKey || extractS3KeyFromUrl(avatarObj.imageUrl);
            if (imageKey) {
              avatarObj.imageUrl = await getPresignedUrl(imageKey);
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
      data: avatarsWithUrls,
      count: avatarsWithUrls.length
    });
  } catch (error) {
    console.error('Error fetching live avatars:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch live avatars',
      error: error.message
    });
  }
});

// PUT /api/live-avatars/:id/direct - Update live avatar with direct S3 URLs
router.put('/:id/direct', authenticate, async (req, res) => {
  try {
    const { name, description, agentId, gender, category, link, videoUrl, imageUrl, videoKey: vKey, imageKey: iKey } = req.body;
    
    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(clientIdError.status || 401).json({
        success: false,
        message: clientIdError.message
      });
    }
    
    const avatar = await LiveAvatar.findOne({
      _id: req.params.id,
      clientId: clientId,
      isActive: true
    });
    
    if (!avatar) {
      return res.status(404).json({
        success: false,
        message: 'Live avatar not found'
      });
    }
    
    if (name) avatar.name = name.trim();
    if (description) avatar.description = description.trim();
    if (agentId) avatar.agentId = agentId.trim();
    if (gender) avatar.gender = gender;
    if (category) avatar.category = category;
    if (link !== undefined) avatar.link = link.trim();
    
    // Update video URL if provided
    if (videoUrl || vKey) {
      if (videoUrl && avatar.videoUrl && avatar.videoUrl !== videoUrl) {
        try {
          if (avatar.videoKey) {
            await deleteFile(avatar.videoKey);
          } else {
            await deleteFile(avatar.videoUrl);
          }
        } catch (error) {
          console.error('Failed to delete old video:', error);
        }
      }
      avatar.videoUrl = videoUrl || null;
      avatar.videoKey = vKey || (videoUrl ? extractS3KeyFromUrl(videoUrl) : null);
    }
    
    // Update image URL if provided
    if (imageUrl || iKey) {
      if (imageUrl && avatar.imageUrl && avatar.imageUrl !== imageUrl) {
        try {
          await deleteFile(avatar.imageKey || avatar.imageUrl);
        } catch (error) {
          console.error('Failed to delete old image:', error);
        }
      }
      avatar.imageUrl = imageUrl || null;
      avatar.imageKey = iKey || (imageUrl ? extractS3KeyFromUrl(imageUrl) : null);
    }
    
    await avatar.save();
    
    // Generate presigned URLs for the updated avatar
    const avatarObj = withClientIdString(await avatar.populate('clientId', 'clientId'));
    
    // Generate presigned URL for video if exists
    if (avatarObj.videoKey || avatarObj.videoUrl) {
      try {
        const videoKey = avatarObj.videoKey || extractS3KeyFromUrl(avatarObj.videoUrl);
        if (videoKey) {
          avatarObj.videoUrl = await getPresignedUrl(videoKey);
        }
      } catch (error) {
        console.error('Error generating video presigned URL:', error);
      }
    }
    
    // Generate presigned URL for image if exists
    if (avatarObj.imageKey || avatarObj.imageUrl) {
      try {
        const imageKey = avatarObj.imageKey || extractS3KeyFromUrl(avatarObj.imageUrl);
        if (imageKey) {
          avatarObj.imageUrl = await getPresignedUrl(imageKey);
        }
      } catch (error) {
        console.error('Error generating image presigned URL:', error);
      }
    }
    
    res.json({
      success: true,
      message: 'Live avatar updated successfully',
      data: avatarObj
    });
  } catch (error) {
    console.error('Error updating live avatar:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update live avatar',
      error: error.message
    });
  }
});

// DELETE /api/live-avatars/:id - Delete live avatar
router.delete('/:id', authenticate, async (req, res) => {
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

    const avatar = await LiveAvatar.findOneAndDelete({
      _id: req.params.id,
      clientId: clientId
    });

    if (!avatar) {
      return res.status(404).json({
        success: false,
        message: 'Live avatar not found'
      });
    }

    // Delete files from S3
    if (avatar.videoKey || avatar.videoUrl) {
      try {
        await deleteFile(avatar.videoKey || avatar.videoUrl);
      } catch (error) {
        console.error('Failed to delete video from S3:', error);
      }
    }
    if (avatar.imageKey || avatar.imageUrl) {
      try {
        await deleteFile(avatar.imageKey || avatar.imageUrl);
      } catch (error) {
        console.error('Failed to delete image from S3:', error);
      }
    }

    res.json({
      success: true,
      message: 'Live avatar deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting live avatar:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete live avatar',
      error: error.message
    });
  }
});

// PATCH /api/live-avatars/:id/toggle-status - Toggle live avatar status
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

    const avatar = await LiveAvatar.findOne({
      _id: req.params.id,
      clientId: clientId
    });

    if (!avatar) {
      return res.status(404).json({
        success: false,
        message: 'Live avatar not found'
      });
    }

    avatar.isActive = !avatar.isActive;
    await avatar.save();

    res.json({
      success: true,
      message: `Live avatar ${avatar.isActive ? 'enabled' : 'disabled'} successfully`,
      data: { isActive: avatar.isActive }
    });
  } catch (error) {
    console.error('Error toggling live avatar status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle live avatar status',
      error: error.message
    });
  }
});

export default router;