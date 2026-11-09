import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import Sankalp from '../models/Sankalp.js';
import Client from '../models/Client.js';
import { authenticate } from '../middleware/auth.js';
import { uploadFile, deleteFile, generateUploadUrl, getPresignedUrl, extractS3KeyFromUrl } from '../utils/storage.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

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
    return { ...obj, clientId: null };
  }
  return obj;
};

const getClientId = async (req) => {
  if (req.user.role === 'user') {
    const rawClientId = req.decodedClientId || req.user.clientId?._id || req.user.clientId || req.user.tokenClientId || req.user.clientId?.clientId;
    const clientId = await resolveClientObjectId(rawClientId);
    if (!clientId) {
      throw new Error('Client ID not found for user token.');
    }
    return clientId;
  }
  if (req.user.role === 'client') {
    const clientId = req.user._id || req.user.id;
    if (!clientId) {
      throw new Error('Client ID not found.');
    }
    return clientId;
  }
  throw new Error('Invalid role.');
};

// GET /api/sankalp - Get all sankalpas (public for users, filtered by clientId for clients)
router.get('/', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const { search, category, subcategory, sortBy } = req.query;
    let sankalpas = [];

    // Build filter query
    const buildFilter = (baseFilter) => {
      const filter = { ...baseFilter };
      
      // Search by title or description
      if (search) {
        filter.$or = [
          { title: { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } }
        ];
      }
      
      // Filter by category
      if (category) {
        filter.category = category;
      }
      
      // Filter by subcategory
      if (subcategory) {
        filter.subcategory = subcategory;
      }
      
      return filter;
    };

    // Determine sort order
    let sortOrder = { createdAt: -1 }; // Default: newest first
    if (sortBy === 'popular') {
      sortOrder = { participantsCount: -1 };
    } else if (sortBy === 'karma') {
      sortOrder = { karmaPointsPerDay: -1 };
    } else if (sortBy === 'duration') {
      sortOrder = { totalDays: 1 };
    }

    if (authHeader && authHeader.startsWith('Bearer ')) {
      // Authenticated request
      try {
        // Manually authenticate
        const token = authHeader.replace('Bearer ', '');
        const jwt = await import('jsonwebtoken');
        const decoded = jwt.default.verify(token, process.env.JWT_SECRET);
        
        if (decoded.role === 'user') {
          // For users, get sankalpas by their clientId
          const clientId = decoded.clientId;
          if (clientId) {
            const filter = buildFilter({ clientId, status: 'Active', visibility: 'Public' });
            sankalpas = await Sankalp.find(filter)
              .populate('clientId', 'clientId')
              .sort(sortOrder);
          } else {
            // No clientId, return all public
            const filter = buildFilter({ status: 'Active', visibility: 'Public' });
            sankalpas = await Sankalp.find(filter)
              .populate('clientId', 'clientId')
              .sort(sortOrder);
          }
        } else if (decoded.role === 'client') {
          // For clients, get their own sankalpas
          const clientId = decoded.userId || decoded.id;
          const filter = buildFilter({ clientId });
          sankalpas = await Sankalp.find(filter)
            .populate('clientId', 'clientId')
            .sort(sortOrder);
        }
      } catch (error) {
        console.error('Auth error, falling back to public:', error.message);
        // If authentication fails, fall back to public sankalpas
        const filter = buildFilter({ status: 'Active', visibility: 'Public' });
        sankalpas = await Sankalp.find(filter)
          .populate('clientId', 'clientId')
          .sort(sortOrder);
      }
    } else {
      // Unauthenticated request - return only public sankalpas
      const filter = buildFilter({ status: 'Active', visibility: 'Public' });
      sankalpas = await Sankalp.find(filter)
        .populate('clientId', 'clientId')
        .sort(sortOrder);
    }

    // Ensure sankalpas is an array
    if (!Array.isArray(sankalpas)) {
      sankalpas = [];
    }

    const sankalpasWithUrls = await Promise.all(
      sankalpas.map(async (sankalp) => {
        const sankalpObj = withClientIdString(sankalp);
        if (sankalpObj.bannerImageKey || sankalpObj.bannerImage) {
          try {
            const imageKey = sankalpObj.bannerImageKey || extractS3KeyFromUrl(sankalpObj.bannerImage);
            if (imageKey) {
              sankalpObj.bannerImage = await getPresignedUrl(imageKey);
            }
          } catch (error) {
            console.error('Error generating presigned URL:', error);
          }
        }
        return sankalpObj;
      })
    );

    res.json({
      success: true,
      data: sankalpasWithUrls,
      count: sankalpasWithUrls.length
    });
  } catch (error) {
    console.error('Error fetching sankalpas:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch sankalpas',
      error: error.message
    });
  }
});

// POST /api/sankalp/upload-url - Generate presigned URL
router.post('/upload-url', authenticate, async (req, res) => {
  try {
    const { fileName, contentType } = req.body;
    if (!fileName || !contentType) {
      return res.status(400).json({
        success: false,
        message: 'fileName and contentType are required'
      });
    }
    const { uploadUrl, fileUrl, key } = await generateUploadUrl(fileName, contentType, 'sankalp/banners');
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

// GET /api/sankalp/:id - Get single sankalp (PUBLIC - no auth required)
router.get('/:id', async (req, res) => {
  try {
    const sankalp = await Sankalp.findOne({
      _id: req.params.id,
      status: 'Active',
      visibility: 'Public'
    }).populate('clientId', 'clientId');

    if (!sankalp) {
      return res.status(404).json({
        success: false,
        message: 'Sankalp not found'
      });
    }

    const sankalpObj = withClientIdString(sankalp);
    
    // Generate presigned URL for banner if exists
    if (sankalpObj.bannerImageKey || sankalpObj.bannerImage) {
      try {
            const imageKey = sankalpObj.bannerImageKey || extractS3KeyFromUrl(sankalpObj.bannerImage);
        if (imageKey) {
          sankalpObj.bannerImage = await getPresignedUrl(imageKey);
        }
      } catch (error) {
        console.error('Error generating presigned URL:', error);
      }
    }

    res.json({
      success: true,
      data: sankalpObj
    });
  } catch (error) {
    console.error('Error fetching sankalp:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch sankalp',
      error: error.message
    });
  }
});

// POST /api/sankalp - Create sankalp
router.post('/', authenticate, async (req, res) => {
  try {
    const { title, description, category, subcategory, durationType, totalDays, completionRule, karmaPointsPerDay, completionBonusKarma, bannerImage, dailyMotivationMessage, completionMessage, status, visibility, slug } = req.body;

    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(401).json({
        success: false,
        message: clientIdError.message
      });
    }

    if (!title || !description || !category) {
      return res.status(400).json({
        success: false,
        message: 'Title, description, and category are required'
      });
    }

    const sankalpData = {
      title: title.trim(),
      description: description.trim(),
      category: category.trim(),
      subcategory: subcategory?.trim() || '',
      durationType: durationType || 'Fixed',
      totalDays: totalDays || 7,
      completionRule: completionRule || 'Daily',
      karmaPointsPerDay: karmaPointsPerDay || 5,
      completionBonusKarma: completionBonusKarma || 50,
      dailyMotivationMessage: dailyMotivationMessage?.trim() || '',
      completionMessage: completionMessage?.trim() || '',
      status: status || 'Active',
      visibility: visibility || 'Public',
      slug: slug?.trim() || '',
      clientId
    };

    if (bannerImage) {
      sankalpData.bannerImage = bannerImage;
      sankalpData.bannerImageKey = extractS3KeyFromUrl(bannerImage);
    }

    const sankalp = new Sankalp(sankalpData);
    await sankalp.save();

    res.status(201).json({
      success: true,
      message: 'Sankalp created successfully',
      data: withClientIdString(await sankalp.populate('clientId', 'clientId'))
    });
  } catch (error) {
    console.error('Error creating sankalp:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create sankalp',
      error: error.message
    });
  }
});

// PUT /api/sankalp/:id - Update sankalp
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { title, description, category, subcategory, durationType, totalDays, completionRule, karmaPointsPerDay, completionBonusKarma, bannerImage, dailyMotivationMessage, completionMessage, status, visibility, slug } = req.body;

    let clientId;
    try {
      clientId = await getClientId(req);
    } catch (clientIdError) {
      return res.status(401).json({
        success: false,
        message: clientIdError.message
      });
    }

    const sankalp = await Sankalp.findOne({
      _id: req.params.id,
      clientId
    });

    if (!sankalp) {
      return res.status(404).json({
        success: false,
        message: 'Sankalp not found'
      });
    }

    if (title) sankalp.title = title.trim();
    if (description) sankalp.description = description.trim();
    if (category) sankalp.category = category.trim();
    if (subcategory !== undefined) sankalp.subcategory = subcategory.trim();
    if (durationType) sankalp.durationType = durationType;
    if (totalDays) sankalp.totalDays = totalDays;
    if (completionRule) sankalp.completionRule = completionRule;
    if (karmaPointsPerDay !== undefined) sankalp.karmaPointsPerDay = karmaPointsPerDay;
    if (completionBonusKarma !== undefined) sankalp.completionBonusKarma = completionBonusKarma;
    if (dailyMotivationMessage !== undefined) sankalp.dailyMotivationMessage = dailyMotivationMessage.trim();
    if (completionMessage !== undefined) sankalp.completionMessage = completionMessage.trim();
    if (status) sankalp.status = status;
    if (visibility) sankalp.visibility = visibility;
    if (slug !== undefined) sankalp.slug = slug.trim();

    if (bannerImage) {
      if (sankalp.bannerImage && sankalp.bannerImage !== bannerImage) {
        try {
          await deleteFile(sankalp.bannerImageKey || sankalp.bannerImage);
        } catch (error) {
          console.error('Failed to delete old banner:', error);
        }
      }
      sankalp.bannerImage = bannerImage;
      sankalp.bannerImageKey = extractS3KeyFromUrl(bannerImage);
    }

    await sankalp.save();

    res.json({
      success: true,
      message: 'Sankalp updated successfully',
      data: withClientIdString(await sankalp.populate('clientId', 'clientId'))
    });
  } catch (error) {
    console.error('Error updating sankalp:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update sankalp',
      error: error.message
    });
  }
});

// DELETE /api/sankalp/:id - Delete sankalp
router.delete('/:id', authenticate, async (req, res) => {
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

    const sankalp = await Sankalp.findOneAndDelete({
      _id: req.params.id,
      clientId
    });

    if (!sankalp) {
      return res.status(404).json({
        success: false,
        message: 'Sankalp not found'
      });
    }

    if (sankalp.bannerImageKey || sankalp.bannerImage) {
      try {
        await deleteFile(sankalp.bannerImageKey || sankalp.bannerImage);
      } catch (error) {
        console.error('Failed to delete banner from S3:', error);
      }
    }

    res.json({
      success: true,
      message: 'Sankalp deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting sankalp:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete sankalp',
      error: error.message
    });
  }
});

// PATCH /api/sankalp/:id/toggle-status - Toggle status
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

    const sankalp = await Sankalp.findOne({
      _id: req.params.id,
      clientId
    });

    if (!sankalp) {
      return res.status(404).json({
        success: false,
        message: 'Sankalp not found'
      });
    }

    sankalp.status = sankalp.status === 'Active' ? 'Inactive' : 'Active';
    await sankalp.save();

    res.json({
      success: true,
      message: `Sankalp ${sankalp.status === 'Active' ? 'enabled' : 'disabled'} successfully`,
      data: { status: sankalp.status }
    });
  } catch (error) {
    console.error('Error toggling status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle status',
      error: error.message
    });
  }
});

export default router;
