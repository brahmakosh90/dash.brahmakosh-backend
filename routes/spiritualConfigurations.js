import express from 'express';
import { authenticateToken } from '../middleware/authMiddleware.js';
import SpiritualConfiguration from '../models/SpiritualConfiguration.js';

const router = express.Router();

// Helper function to get default categoryId based on type
const getDefaultCategoryId = (type) => {
  const typeToCategory = {
    'meditation': '69787dfbbeaf7e42675a221d',
    'chanting': '69787dcbbeaf7e42675a2212',
    'silence': '69787d8bbeaf7e42675a2207',
    'prayer': '69787d32beaf7e42675a21f8'
  };
  return typeToCategory[type] || '';
};

const DEFAULT_CATEGORY_BY_TYPE = {
  meditation: 'Guided Meditation',
  chanting: 'Daily Chanting',
  prayer: 'Daily Ritual Prayers',
  silence: 'Silence',
  breathing: 'Breathing',
  mindfulness: 'Mindfulness',
  yoga: 'Yoga',
  gratitude: 'Gratitude',
  reflection: 'Reflection'
};

// All routes require authentication
router.use(authenticateToken);

// Create new spiritual configuration
const createConfiguration = async (req, res) => {
  try {
    const { title, duration, description, type, karmaPoints, chantingType, meditationType, prayerType, categoryId, category, subcategory } = req.body;
    
    // Get clientId based on user role
    let clientId;
    if (req.user.role === 'client') {
      clientId = req.user.clientId;
    } else if (req.user.role === 'user') {
      clientId = req.user.clientId?.clientId || req.user.tokenClientId;
    } else {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only clients and users can create configurations.'
      });
    }

    if (!clientId) {
      return res.status(400).json({
        success: false,
        message: 'Client ID not found. Please contact support.'
      });
    }

    const configuration = new SpiritualConfiguration({
      title,
      duration: duration || '15 minutes',
      description,
      type,
      karmaPoints: karmaPoints || 10,
      category: category || '',
      subcategory: subcategory || '',
      categoryId: categoryId || getDefaultCategoryId(type),
      clientId
    });
    
    if (chantingType) configuration.chantingType = chantingType;
    if (meditationType) configuration.meditationType = meditationType;
    if (prayerType) configuration.prayerType = prayerType;

    await configuration.save();

    res.status(201).json({
      success: true,
      message: 'Spiritual configuration created successfully',
      data: configuration
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// Get all configurations for a client
const getConfigurations = async (req, res) => {
  try {
    // Get clientId based on user role
    let clientId;
    if (req.user.role === 'client') {
      clientId = req.user.clientId;
    } else if (req.user.role === 'user') {
      clientId = req.user.clientId?.clientId || req.user.tokenClientId;
    }
    
    // Build query with optional filters
    const query = {
      isDeleted: false
    };
    
    // Add clientId filter if available
    if (clientId) {
      query.clientId = clientId;
    }
    
    // Handle categoryId to type mapping for backward compatibility
    if (req.query.categoryId) {
      // Map categoryId to type for existing configurations
      const categoryToTypeMap = {
        '69787dfbbeaf7e42675a221d': 'meditation',
        '69787dcbbeaf7e42675a2212': 'chanting', 
        '69787d8bbeaf7e42675a2207': 'silence',
        '69787d32beaf7e42675a21f8': 'prayer'
      };
      
      const mappedType = categoryToTypeMap[req.query.categoryId];
      if (mappedType) {
        // Get all configurations of the mapped type (both with and without categoryId)
        query.type = mappedType;
      } else {
        query.categoryId = req.query.categoryId;
      }
    }
    
    if (req.query.type) {
      query.type = req.query.type;
    }
    
    const found = await SpiritualConfiguration.find(query)
      .select('-emotion -chantingType -meditationType -prayerType -isDeleted -__v')
      .sort({ createdAt: -1 })
      .lean();

    // Older records were saved without a category, which reached the app as a blank heading.
    const configurations = found.map((c) => ({
      ...c,
      category: (c.category || '').trim() || DEFAULT_CATEGORY_BY_TYPE[c.type] || 'General'
    }));

    res.status(200).json({
      success: true,
      data: configurations,
      count: configurations.length
    });
  } catch (error) {
    console.error('[Spiritual Config] Error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Update configuration
const updateConfiguration = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, duration, description, karmaPoints, chantingType, meditationType, prayerType, categoryId, category, subcategory } = req.body;
    
    if (!['client', 'user'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only clients and users can update configurations.'
      });
    }

    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (duration !== undefined) updateData.duration = duration;
    if (description !== undefined) updateData.description = description;
    if (karmaPoints !== undefined) updateData.karmaPoints = karmaPoints;
    if (chantingType !== undefined) updateData.chantingType = chantingType;
    if (meditationType !== undefined) updateData.meditationType = meditationType;
    if (prayerType !== undefined) updateData.prayerType = prayerType;
    if (categoryId !== undefined) updateData.categoryId = categoryId;
    if (category !== undefined) updateData.category = category;
    if (subcategory !== undefined) updateData.subcategory = subcategory;
    if (req.body.audioUrl !== undefined) updateData.audioUrl = req.body.audioUrl;
    if (req.body.audioKey !== undefined) updateData.audioKey = req.body.audioKey;

    const configuration = await SpiritualConfiguration.findOneAndUpdate(
      { _id: id, isDeleted: false },
      updateData,
      { new: true, runValidators: true }
    );

    if (!configuration) {
      return res.status(404).json({
        success: false,
        message: 'Configuration not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Configuration updated successfully',
      data: configuration
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// Delete configuration (soft delete)
const deleteConfiguration = async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!['client', 'user'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only clients and users can delete configurations.'
      });
    }

    const configuration = await SpiritualConfiguration.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { isDeleted: true },
      { new: true }
    );

    if (!configuration) {
      return res.status(404).json({
        success: false,
        message: 'Configuration not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Configuration deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Toggle configuration status
const toggleConfiguration = async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!['client', 'user'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only clients and users can toggle configurations.'
      });
    }

    const configuration = await SpiritualConfiguration.findOne({
      _id: id, 
      isDeleted: false
    });

    if (!configuration) {
      return res.status(404).json({
        success: false,
        message: 'Configuration not found'
      });
    }

    configuration.isActive = !configuration.isActive;
    await configuration.save();

    res.status(200).json({
      success: true,
      message: `Configuration ${configuration.isActive ? 'enabled' : 'disabled'} successfully`,
      data: {
        isActive: configuration.isActive
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Get single configuration by ID
const getSingleConfiguration = async (req, res) => {
  try {
    const { id } = req.params;
    
    const configuration = await SpiritualConfiguration.findOne({
      _id: id,
      isDeleted: false
    });

    if (!configuration) {
      return res.status(404).json({
        success: false,
        message: 'Configuration not found'
      });
    }

    res.status(200).json({
      success: true,
      data: configuration
    });
  } catch (error) {
    console.error('[Spiritual Config] Get single error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Get unique custom types for dropdowns
const getCustomTypes = async (req, res) => {
  try {
    let clientId;
    if (req.user.role === 'client') {
      clientId = req.user.clientId;
    } else if (req.user.role === 'user') {
      clientId = req.user.clientId?.clientId || req.user.tokenClientId;
    }
    
    const query = {};
    if (clientId) query.clientId = clientId;
    
    const configurations = await SpiritualConfiguration.find(query);
    
    const customTypes = {
      chanting: [],
      meditation: [],
      prayer: []
    };
    
    configurations.forEach(config => {
      if (config.chantingType && !customTypes.chanting.includes(config.chantingType)) {
        customTypes.chanting.push(config.chantingType);
      }
      if (config.meditationType && !customTypes.meditation.includes(config.meditationType)) {
        customTypes.meditation.push(config.meditationType);
      }
      if (config.prayerType && !customTypes.prayer.includes(config.prayerType)) {
        customTypes.prayer.push(config.prayerType);
      }
    });
    
    res.status(200).json({
      success: true,
      data: customTypes
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Routes
// Distinct, non-blank categories (with counts) for one type, e.g. ?type=meditation
const getCategories = async (req, res) => {
  try {
    let clientId;
    if (req.user.role === 'client') clientId = req.user.clientId;
    else if (req.user.role === 'user') clientId = req.user.clientId?.clientId || req.user.tokenClientId;

    const query = { isDeleted: false, isActive: true };
    if (clientId) query.clientId = clientId;
    if (req.query.type) query.type = req.query.type;

    const rows = await SpiritualConfiguration.find(query).select('type category').lean();
    const counts = new Map();
    for (const r of rows) {
      const name = (r.category || '').trim() || DEFAULT_CATEGORY_BY_TYPE[r.type] || 'General';
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const data = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    res.status(200).json({ success: true, data, count: data.length });
  } catch (error) {
    console.error('[Spiritual Config] Categories error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

router.post('/', createConfiguration);
router.get('/', getConfigurations);
router.get('/custom-types', getCustomTypes);
router.get('/categories', getCategories);
router.get('/:id', getSingleConfiguration);
router.put('/:id', updateConfiguration);
router.delete('/:id', deleteConfiguration);
router.patch('/:id/toggle', toggleConfiguration);

export default router;