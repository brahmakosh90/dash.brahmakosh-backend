import express from 'express';
import Chapter from '../models/Chapter.js';
import { authenticate } from '../middleware/auth.js';
import multer from 'multer';
import { uploadFile, getPresignedUrl } from '../utils/storage.js';

import { cacheGet } from '../utils/responseCache.js';
const router = express.Router();

// Configure multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Helper to get actual clientId
const getClientId = async (user, decodedClientId) => {
  let clientId;
  
  if (user.role === 'client') {
    clientId = user.clientId; // For client role, use the clientId field directly
  } else if (user.role === 'user') {
    clientId = user.clientId?.clientId || user.tokenClientId || decodedClientId;
    
    // Convert ObjectId to actual clientId
    if (clientId && clientId.length === 24 && /^[0-9a-fA-F]{24}$/.test(clientId)) {
      const Client = (await import('../models/Client.js')).default;
      const client = await Client.findById(clientId);
      if (client?.clientId) clientId = client.clientId;
    }
  } else {
    clientId = user._id;
  }
  
  return clientId;
};

// GET all chapters
router.get('/', authenticate, cacheGet({ ttlSeconds: 30, tag: 'chapters', perUser: true }), async (req, res) => {
  try {
    const { includeInactive } = req.query;
    
    const actualClientId = await getClientId(req.user, req.decodedClientId);
    
    // Check all chapters in database first
    const allChapters = await Chapter.find({});
    
    // TEMPORARY FIX: If no chapters found with string clientId, try ObjectId
    let filter = { clientId: actualClientId };
    let chapters = await Chapter.find(filter).sort({ chapterNumber: 1 });
    
    if (chapters.length === 0 && actualClientId) {
      // Try to find client by clientId and use their ObjectId
      const Client = (await import('../models/Client.js')).default;
      const client = await Client.findOne({ clientId: actualClientId });
      if (client) {
        // Query with ObjectId but convert to string for comparison
        const chaptersWithObjectId = await Chapter.find({ clientId: client._id }).sort({ chapterNumber: 1 });
        
        // Update chapters to use correct clientId format
        if (chaptersWithObjectId.length > 0) {
          const updateResult = await Chapter.updateMany(
            { clientId: client._id },
            { clientId: actualClientId }
          );
          // Reload chapters with updated clientId
          chapters = await Chapter.find({ clientId: actualClientId }).sort({ chapterNumber: 1 });
        }
      }
    }
    
    // Apply status filter
    if (!includeInactive || includeInactive !== 'true') {
      chapters = chapters.filter(ch => ch.status === 'active');
    }
    
    // Generate presigned URLs for images
    const chaptersWithSignedUrls = await Promise.all(
      chapters.map(async (chapter) => {
        const chapterObj = chapter.toObject();
        if (chapterObj.imageUrl) {
          try {
            const { getPresignedUrl } = await import('../utils/storage.js');
            chapterObj.imageUrl = await getPresignedUrl(chapterObj.imageUrl);
          } catch (error) {
            console.error('Error generating presigned URL:', error);
          }
        }
        return chapterObj;
      })
    );
    
    res.json({
      success: true,
      data: chaptersWithSignedUrls,
      total: chaptersWithSignedUrls.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch chapters',
      error: error.message
    });
  }
});

// GET single chapter by ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const actualClientId = await getClientId(req.user, req.decodedClientId);
    
    const chapter = await Chapter.findOne({ 
      _id: req.params.id, 
      clientId: actualClientId 
    });
    
    if (!chapter) {
      return res.status(404).json({
        success: false,
        message: 'Chapter not found'
      });
    }
    
    // Generate presigned URL for image
    const chapterObj = chapter.toObject();
    if (chapterObj.imageUrl) {
      try {
        const { getPresignedUrl } = await import('../utils/storage.js');
        chapterObj.imageUrl = await getPresignedUrl(chapterObj.imageUrl);
      } catch (error) {
        console.error('Error generating presigned URL:', error);
      }
    }
    
    res.json({
      success: true,
      data: chapterObj
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch chapter',
      error: error.message
    });
  }
});

// POST create chapter
router.post('/', authenticate, upload.single('image'), async (req, res) => {
  try {
    const { name, chapterNumber, description, shlokaCount, status } = req.body;
    
    const actualClientId = await getClientId(req.user, req.decodedClientId);
    
    // Check if chapter number already exists (check both string and ObjectId formats)
    let existingChapter = await Chapter.findOne({ 
      chapterNumber: parseInt(chapterNumber),
      clientId: actualClientId 
    });
    
    // If not found with string clientId, try ObjectId format
    if (!existingChapter && actualClientId) {
      const Client = (await import('../models/Client.js')).default;
      const client = await Client.findOne({ clientId: actualClientId });
      if (client) {
        existingChapter = await Chapter.findOne({ 
          chapterNumber: parseInt(chapterNumber),
          clientId: client._id 
        });
      }
    }
    
    if (existingChapter) {
      return res.status(400).json({
        success: false,
        message: `Chapter ${chapterNumber} already exists`
      });
    }
    
    let imageUrl = null;
    if (req.file) {
      const uploadResult = await uploadFile(req.file, 'chapters');
      imageUrl = uploadResult.key || uploadResult.url;
    }
    
    const chapter = new Chapter({
      name,
      chapterNumber: parseInt(chapterNumber),
      description,
      shlokaCount: parseInt(shlokaCount),
      imageUrl,
      status,
      clientId: actualClientId
    });
    
    await chapter.save();
    
    // Generate presigned URL for response
    const responseChapter = chapter.toObject();
    if (responseChapter.imageUrl) {
      try {
        const { getPresignedUrl } = await import('../utils/storage.js');
        responseChapter.imageUrl = await getPresignedUrl(responseChapter.imageUrl);
      } catch (error) {
        console.error('Error generating presigned URL for response:', error);
      }
    }
    
    res.status(201).json({
      success: true,
      message: 'Chapter created successfully',
      data: responseChapter
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to create chapter',
      error: error.message
    });
  }
});

// DELETE chapter
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const actualClientId = await getClientId(req.user, req.decodedClientId);
    
    const chapter = await Chapter.findOneAndDelete({ 
      _id: req.params.id, 
      clientId: actualClientId 
    });
    
    if (!chapter) {
      return res.status(404).json({
        success: false,
        message: 'Chapter not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Chapter deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete chapter',
      error: error.message
    });
  }
});

// PUT update chapter
router.put('/:id', authenticate, upload.single('image'), async (req, res) => {
  try {
    const { name, chapterNumber, description, shlokaCount, status } = req.body;
    
    const actualClientId = await getClientId(req.user, req.decodedClientId);
    
    const updateData = {
      name,
      chapterNumber: parseInt(chapterNumber),
      description,
      shlokaCount: parseInt(shlokaCount),
      status
    };
    
    // Handle image upload if provided
    if (req.file) {
      const uploadResult = await uploadFile(req.file, 'chapters');
      updateData.imageUrl = uploadResult.key || uploadResult.url;
    }
    
    const chapter = await Chapter.findOneAndUpdate(
      { _id: req.params.id, clientId: actualClientId },
      updateData,
      { new: true }
    );
    
    if (!chapter) {
      return res.status(404).json({
        success: false,
        message: 'Chapter not found'
      });
    }
    
    // Generate presigned URL for response
    const responseChapter = chapter.toObject();
    if (responseChapter.imageUrl) {
      try {
        const { getPresignedUrl } = await import('../utils/storage.js');
        responseChapter.imageUrl = await getPresignedUrl(responseChapter.imageUrl);
      } catch (error) {
        console.error('Error generating presigned URL for response:', error);
      }
    }
    
    res.json({
      success: true,
      message: 'Chapter updated successfully',
      data: responseChapter
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update chapter',
      error: error.message
    });
  }
});

// PATCH toggle chapter status
router.patch('/:id/toggle-status', authenticate, async (req, res) => {
  try {
    const actualClientId = await getClientId(req.user, req.decodedClientId);
    
    const chapter = await Chapter.findOne({ 
      _id: req.params.id, 
      clientId: actualClientId 
    });
    
    if (!chapter) {
      return res.status(404).json({
        success: false,
        message: 'Chapter not found'
      });
    }
    
    chapter.status = chapter.status === 'active' ? 'inactive' : 'active';
    await chapter.save();
    
    // Generate presigned URL for response
    const responseChapter = chapter.toObject();
    if (responseChapter.imageUrl) {
      try {
        const { getPresignedUrl } = await import('../utils/storage.js');
        responseChapter.imageUrl = await getPresignedUrl(responseChapter.imageUrl);
      } catch (error) {
        console.error('Error generating presigned URL for toggle response:', error);
      }
    }
    
    res.json({
      success: true,
      message: `Chapter ${chapter.status === 'active' ? 'enabled' : 'disabled'} successfully`,
      data: responseChapter
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to toggle chapter status',
      error: error.message
    });
  }
});

// POST upload chapter image
router.post('/:id/upload-image', authenticate, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided'
      });
    }
    
    const actualClientId = await getClientId(req.user, req.decodedClientId);
    
    const uploadResult = await uploadFile(req.file, 'chapters');
    
    const chapter = await Chapter.findOneAndUpdate(
      { _id: req.params.id, clientId: actualClientId },
      { imageUrl: uploadResult.key || uploadResult.url },
      { new: true }
    );
    
    if (!chapter) {
      return res.status(404).json({
        success: false,
        message: 'Chapter not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Image uploaded successfully',
      data: chapter,
      imageUrl: uploadResult.key || uploadResult.url
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to upload image',
      error: error.message
    });
  }
});

export default router;