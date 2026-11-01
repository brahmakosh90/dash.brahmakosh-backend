import express from 'express';
import Prathana from '../models/Prathana.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { getPresignedUrl, generateUploadUrl } from '../utils/storage.js';

import { cacheGet } from '../utils/responseCache.js';
const router = express.Router();

// POST /api/prathanas/upload-url - Generate presigned URL for direct S3 upload
router.post('/upload-url', authenticate, async (req, res) => {
  try {
    const { fileName, contentType, fileType } = req.body;
    
    if (!fileName || !contentType) {
      return res.status(400).json({
        success: false,
        message: 'fileName and contentType are required'
      });
    }
    
    const folder = fileType === 'video' ? 'prathanas/videos' : 'prathanas/images';
    const { uploadUrl, fileUrl, key } = await generateUploadUrl(fileName, contentType, folder);
    
    res.json({
      success: true,
      data: { uploadUrl, fileUrl, key, fileKey: key }
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

// Get all prathanas for a client
router.get('/', authenticate, authorize('client','user'), cacheGet({ ttlSeconds: 30, tag: 'prathanas', perUser: true }), async (req, res) => {
  try {
    const clientId = req.user.role === 'client' ? req.user._id : req.user.clientId;
    
    const prathanas = await Prathana.find({ 
      clientId: clientId,
      isActive: true 
    }).populate('clientId', 'clientId').sort({ createdAt: -1 });

    // Generate presigned URLs for active prathanas
    const prathanasWithUrls = await Promise.all(
      prathanas.map(async (prathana) => {
        const prathanaObj = prathana.toObject();
        
        // Convert clientId to string format
        if (prathanaObj.clientId && typeof prathanaObj.clientId === 'object') {
          prathanaObj.clientId = prathanaObj.clientId.clientId || prathanaObj.clientId._id;
        }
        
        if (prathana.videoKey) {
          try {
            prathanaObj.videoUrl = await getPresignedUrl(prathana.videoKey, 604800);
          } catch (error) {
            console.error('Error generating video presigned URL:', error);
          }
        }
        
        if (prathana.thumbnailKey) {
          try {
            prathanaObj.thumbnailUrl = await getPresignedUrl(prathana.thumbnailKey, 604800);
          } catch (error) {
            console.error('Error generating thumbnail presigned URL:', error);
          }
        }
        
        return prathanaObj;
      })
    );

    res.json({
      success: true,
      data: prathanasWithUrls
    });
  } catch (error) {
    console.error('Error fetching prathanas:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching prathanas'
    });
  }
});

// Get single prathana
router.get('/:id', authenticate, authorize('client','user'), async (req, res) => {
  try {
    const clientId = req.user.role === 'client' ? req.user._id : req.user.clientId;
    
    const prathana = await Prathana.findOne({
      _id: req.params.id,
      clientId: clientId
    }).populate('clientId', 'clientId');

    if (!prathana) {
      return res.status(404).json({
        success: false,
        message: 'Prathana not found'
      });
    }

    const prathanaObj = prathana.toObject();
    
    // Convert clientId to string format
    if (prathanaObj.clientId && typeof prathanaObj.clientId === 'object') {
      prathanaObj.clientId = prathanaObj.clientId.clientId || prathanaObj.clientId._id;
    }
    
    // Generate presigned URLs
    if (prathana.videoKey) {
      try {
        prathanaObj.videoUrl = await getPresignedUrl(prathana.videoKey, 604800);
      } catch (error) {
        console.error('Error generating video presigned URL:', error);
      }
    }
    
    if (prathana.thumbnailKey) {
      try {
        prathanaObj.thumbnailUrl = await getPresignedUrl(prathana.thumbnailKey, 604800);
      } catch (error) {
        console.error('Error generating thumbnail presigned URL:', error);
      }
    }

    res.json({
      success: true,
      data: prathanaObj
    });
  } catch (error) {
    console.error('Error fetching prathana:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching prathana'
    });
  }
});

// Create new prathana
router.post('/', authenticate, authorize('client','user'), async (req, res) => {
  try {
    const { name, text, category, duration, videoKey, thumbnailKey, youtubeLink } = req.body;
    
    const clientId = req.user.role === 'client' ? req.user._id : req.user.clientId;

    const prathana = new Prathana({
      name,
      text,
      category,
      duration,
      videoKey,
      thumbnailKey,
      youtubeLink,
      clientId: clientId
    });

    await prathana.save();
    await prathana.populate('clientId', 'clientId');

    const prathanaObj = prathana.toObject();
    
    // Convert clientId to string format
    if (prathanaObj.clientId && typeof prathanaObj.clientId === 'object') {
      prathanaObj.clientId = prathanaObj.clientId.clientId || prathanaObj.clientId._id;
    }
    
    // Generate presigned URLs for response
    if (prathana.videoKey) {
      try {
        prathanaObj.videoUrl = await getPresignedUrl(prathana.videoKey, 604800);
      } catch (error) {
        console.error('Error generating video presigned URL:', error);
      }
    }
    
    if (prathana.thumbnailKey) {
      try {
        prathanaObj.thumbnailUrl = await getPresignedUrl(prathana.thumbnailKey, 604800);
      } catch (error) {
        console.error('Error generating thumbnail presigned URL:', error);
      }
    }

    res.status(201).json({
      success: true,
      message: 'Prathana created successfully',
      data: prathanaObj
    });
  } catch (error) {
    console.error('Error creating prathana:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating prathana'
    });
  }
});

// Update prathana
router.put('/:id', authenticate, authorize('client','user'), async (req, res) => {
  try {
    const { name, text, category, duration, videoKey, thumbnailKey, youtubeLink } = req.body;
    
    const clientId = req.user.role === 'client' ? req.user._id : req.user.clientId;

    const prathana = await Prathana.findOne({
      _id: req.params.id,
      clientId: clientId
    });

    if (!prathana) {
      return res.status(404).json({
        success: false,
        message: 'Prathana not found'
      });
    }

    // Update fields
    prathana.name = name;
    prathana.text = text;
    prathana.category = category;
    prathana.duration = duration;
    prathana.youtubeLink = youtubeLink;

    // Update video if provided
    if (videoKey) {
      prathana.videoKey = videoKey;
    }

    // Update thumbnail if provided
    if (thumbnailKey) {
      prathana.thumbnailKey = thumbnailKey;
    }

    await prathana.save();
    await prathana.populate('clientId', 'clientId');

    const prathanaObj = prathana.toObject();
    
    // Convert clientId to string format
    if (prathanaObj.clientId && typeof prathanaObj.clientId === 'object') {
      prathanaObj.clientId = prathanaObj.clientId.clientId || prathanaObj.clientId._id;
    }
    
    // Generate presigned URLs for response
    if (prathana.videoKey) {
      try {
        prathanaObj.videoUrl = await getPresignedUrl(prathana.videoKey, 604800);
      } catch (error) {
        console.error('Error generating video presigned URL:', error);
      }
    }
    
    if (prathana.thumbnailKey) {
      try {
        prathanaObj.thumbnailUrl = await getPresignedUrl(prathana.thumbnailKey, 604800);
      } catch (error) {
        console.error('Error generating thumbnail presigned URL:', error);
      }
    }

    res.json({
      success: true,
      message: 'Prathana updated successfully',
      data: prathanaObj
    });
  } catch (error) {
    console.error('Error updating prathana:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating prathana'
    });
  }
});

// Toggle prathana status
router.patch('/:id/toggle-status', authenticate, authorize('client','user'), async (req, res) => {
  try {
    const clientId = req.user.role === 'client' ? req.user._id : req.user.clientId;
    
    const prathana = await Prathana.findOne({
      _id: req.params.id,
      clientId: clientId
    });

    if (!prathana) {
      return res.status(404).json({
        success: false,
        message: 'Prathana not found'
      });
    }

    prathana.isActive = !prathana.isActive;
    await prathana.save();

    res.json({
      success: true,
      message: `Prathana ${prathana.isActive ? 'enabled' : 'disabled'} successfully`,
      data: { isActive: prathana.isActive }
    });
  } catch (error) {
    console.error('Error toggling prathana status:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating prathana status'
    });
  }
});

// Delete prathana
router.delete('/:id', authenticate, authorize('client','user'), async (req, res) => {
  try {
    const clientId = req.user.role === 'client' ? req.user._id : req.user.clientId;
    
    const prathana = await Prathana.findOne({
      _id: req.params.id,
      clientId: clientId
    });

    if (!prathana) {
      return res.status(404).json({
        success: false,
        message: 'Prathana not found'
      });
    }

    await Prathana.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Prathana deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting prathana:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting prathana'
    });
  }
});

export default router;