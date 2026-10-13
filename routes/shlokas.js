import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import Shloka from '../models/Shloka.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { getPresignedUrl, generateUploadUrl, uploadBuffer, extractS3KeyFromUrl } from '../utils/storage.js';

const router = express.Router();

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('Only audio files are allowed'), false);
  }
});

const withSignedUrl = async (shloka) => {
  const obj = shloka.toObject ? shloka.toObject() : { ...shloka };
  if (obj.audioUrl) {
    try { obj.audioUrl = await getPresignedUrl(obj.audioUrl); } catch {}
  }
  return obj;
};

// Helper function to get clientId from user and request
const getClientId = (user, req = null) => {
  // If user.clientId is an object (populated), get the clientId field
  if (typeof user.clientId === 'object' && user.clientId?.clientId) {
    return user.clientId.clientId;
  }
  // If user.clientId is already a string (CLI-XXXXXX format)
  if (typeof user.clientId === 'string') {
    return user.clientId;
  }
  // Fallback to tokenClientId
  return user.tokenClientId;
};

// GET all shlokas with pagination and filters
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      chapterNumber, 
      status, 
      isActive,
      search 
    } = req.query;

    const filter = { clientId: getClientId(req.user, req) };
    
    if (chapterNumber) filter.chapterNumber = parseInt(chapterNumber);
    if (status) filter.status = status;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    
    if (search) {
      filter.$or = [
        { sanskritShloka: { $regex: search, $options: 'i' } },
        { hindiMeaning: { $regex: search, $options: 'i' } },
        { englishMeaning: { $regex: search, $options: 'i' } },
        { shlokaIndex: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const shlokas = await Shloka.find(filter)
      .sort({ chapterNumber: 1, shlokaIndex: 1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Shloka.countDocuments(filter);

    const shlokaData = await Promise.all(shlokas.map(withSignedUrl));

    res.json({
      success: true,
      data: shlokaData,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        totalItems: total,
        itemsPerPage: parseInt(limit)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching shlokas',
      error: error.message
    });
  }
});

// Debug route to check user object
router.get('/debug/user', authMiddleware, async (req, res) => {
  const clientId = getClientId(req.user, req);
  res.json({
    user: req.user,
    extractedClientId: clientId,
    tokenClientId: req.user.tokenClientId,
    clientIdObject: req.user.clientId,
    decodedClientId: req.decodedClientId
  });
});

// GET single shloka by ID
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const shloka = await Shloka.findOne({
      _id: req.params.id,
      clientId: getClientId(req.user, req)
    });

    if (!shloka) {
      return res.status(404).json({
        success: false,
        message: 'Shloka not found'
      });
    }

    res.json({
      success: true,
      data: await withSignedUrl(shloka)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching shloka',
      error: error.message
    });
  }
});

// POST create new shloka
router.post('/', authMiddleware, uploadAudio.single('audio'), async (req, res) => {
  try {
    const {
      chapterNumber,
      chapterName,
      section,
      shlokaNumber,
      shlokaIndex,
      sanskritShloka,
      hindiMeaning,
      englishMeaning,
      sanskritTransliteration,
      explanation,
      tags,
      status,
      isActive
    } = req.body;

    // Check if shloka already exists for this chapter
    const existingShloka = await Shloka.findOne({
      chapterNumber: parseInt(chapterNumber),
      shlokaNumber: shlokaNumber.toString(),
      clientId: getClientId(req.user, req)
    });

    if (existingShloka) {
      return res.status(400).json({
        success: false,
        message: `Shloka ${shlokaNumber} already exists in Chapter ${chapterNumber}`
      });
    }

    const shlokaData = {
      chapterNumber: parseInt(chapterNumber),
      chapterName: chapterName || `Chapter ${chapterNumber}`,
      section,
      shlokaNumber: shlokaNumber.toString(),
      sanskritShloka,
      hindiMeaning,
      englishMeaning,
      sanskritTransliteration: sanskritTransliteration || '',
      explanation: explanation || '',
      tags: tags || '',
      status: status || 'draft',
      isActive: isActive === true || isActive === 'true',
      clientId: getClientId(req.user, req)
    };

    if (req.file) {
      const ext = req.file.originalname.split('.').pop();
      const audioKey = `geeta-shloka/audio/${Date.now()}.${ext}`;
      await uploadBuffer(req.file.buffer, audioKey, req.file.mimetype);
      shlokaData.audioUrl = audioKey;
    }
    
    const shloka = new Shloka(shlokaData);
    await shloka.save();

    res.status(201).json({
      success: true,
      message: 'Shloka created successfully',
      data: await withSignedUrl(shloka)
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Shloka with this number already exists in the chapter'
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Error creating shloka',
      error: error.message
    });
  }
});

// PUT update shloka
router.put('/:id', authMiddleware, uploadAudio.single('audio'), async (req, res) => {
  try {
    const {
      chapterNumber,
      chapterName,
      section,
      shlokaNumber,
      shlokaIndex,
      sanskritShloka,
      hindiMeaning,
      englishMeaning,
      sanskritTransliteration,
      explanation,
      tags,
      status,
      isActive
    } = req.body;

    // Check if trying to update to existing shloka number in same chapter
    if (chapterNumber && shlokaNumber) {
      const existingShloka = await Shloka.findOne({
        chapterNumber: parseInt(chapterNumber),
        shlokaNumber: shlokaNumber.toString(),
        clientId: getClientId(req.user, req),
        _id: { $ne: req.params.id }
      });

      if (existingShloka) {
        return res.status(400).json({
          success: false,
          message: `Shloka ${shlokaNumber} already exists in Chapter ${chapterNumber}`
        });
      }
    }

    const updateData = {
      chapterNumber: parseInt(chapterNumber),
      chapterName,
      section,
      shlokaNumber: shlokaNumber.toString(),
      shlokaIndex,
      sanskritShloka,
      hindiMeaning,
      englishMeaning,
      sanskritTransliteration: sanskritTransliteration || '',
      explanation: explanation || '',
      tags: tags || '',
      status: status || 'draft',
      isActive: isActive === true || isActive === 'true'
    };

    if (req.file) {
      const ext = req.file.originalname.split('.').pop();
      const audioKey = `geeta-shloka/audio/${Date.now()}.${ext}`;
      await uploadBuffer(req.file.buffer, audioKey, req.file.mimetype);
      updateData.audioUrl = audioKey;
    }

    const shloka = await Shloka.findOneAndUpdate(
      { _id: req.params.id, clientId: getClientId(req.user, req) },
      updateData,
      { new: true, runValidators: true }
    );

    if (!shloka) {
      return res.status(404).json({
        success: false,
        message: 'Shloka not found'
      });
    }

    res.json({
      success: true,
      message: 'Shloka updated successfully',
      data: await withSignedUrl(shloka)
    });
  } catch (error) {
    console.error('PUT /shlokas/:id error:', error.message, error.stack);
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Shloka with this number already exists in the chapter'
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Error updating shloka',
      error: error.message
    });
  }
});

// PATCH toggle status
router.patch('/:id/status', authMiddleware, async (req, res) => {
  try {
    const shloka = await Shloka.findOne({
      _id: req.params.id,
      clientId: getClientId(req.user, req)
    });

    if (!shloka) {
      return res.status(404).json({
        success: false,
        message: 'Shloka not found'
      });
    }

    shloka.status = shloka.status === 'published' ? 'draft' : 'published';
    await shloka.save();

    res.json({
      success: true,
      message: `Shloka status changed to ${shloka.status}`,
      data: shloka
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating shloka status',
      error: error.message
    });
  }
});

// PATCH toggle active status
router.patch('/:id/active', authMiddleware, async (req, res) => {
  try {
    const shloka = await Shloka.findOne({
      _id: req.params.id,
      clientId: getClientId(req.user, req)
    });

    if (!shloka) {
      return res.status(404).json({
        success: false,
        message: 'Shloka not found'
      });
    }

    shloka.isActive = !shloka.isActive;
    await shloka.save();

    res.json({
      success: true,
      message: `Shloka ${shloka.isActive ? 'activated' : 'deactivated'}`,
      data: shloka
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating shloka active status',
      error: error.message
    });
  }
});

// DELETE shloka
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const shloka = await Shloka.findOneAndDelete({
      _id: req.params.id,
      clientId: getClientId(req.user, req)
    });

    if (!shloka) {
      return res.status(404).json({
        success: false,
        message: 'Shloka not found'
      });
    }

    res.json({
      success: true,
      message: 'Shloka deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting shloka',
      error: error.message
    });
  }
});

// GET shlokas by chapter
router.get('/chapter/:chapterNumber', authMiddleware, async (req, res) => {
  try {
    const { chapterNumber } = req.params;
    const { status, isActive } = req.query;

    const filter = {
      chapterNumber: parseInt(chapterNumber),
      clientId: getClientId(req.user, req)
    };

    if (status) filter.status = status;
    if (isActive !== undefined) filter.isActive = isActive === 'true';

    const shlokas = await Shloka.find(filter)
      .sort({ shlokaIndex: 1 });

    const shlokaData = await Promise.all(shlokas.map(withSignedUrl));

    res.json({
      success: true,
      data: shlokaData,
      count: shlokaData.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching chapter shlokas',
      error: error.message
    });
  }
});

// GET shloka statistics
router.get('/stats/overview', authMiddleware, async (req, res) => {
  try {
    const clientId = getClientId(req.user, req);
    const totalShlokas = await Shloka.countDocuments({ clientId });
    const publishedShlokas = await Shloka.countDocuments({ 
      clientId, 
      status: 'published' 
    });
    const draftShlokas = await Shloka.countDocuments({ 
      clientId, 
      status: 'draft' 
    });
    const activeShlokas = await Shloka.countDocuments({ 
      clientId, 
      isActive: true 
    });

    // Chapter-wise count
    const chapterStats = await Shloka.aggregate([
      { $match: { clientId } },
      {
        $group: {
          _id: '$chapterNumber',
          count: { $sum: 1 },
          published: {
            $sum: { $cond: [{ $eq: ['$status', 'published'] }, 1, 0] }
          }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    res.json({
      success: true,
      data: {
        total: totalShlokas,
        published: publishedShlokas,
        draft: draftShlokas,
        active: activeShlokas,
        chapterStats
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching shloka statistics',
      error: error.message
    });
  }
});

export default router;