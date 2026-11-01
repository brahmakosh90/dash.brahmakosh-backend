import express from 'express';
import SwapnaDecoder from '../models/SwapnaDecoder.js';
import { getPresignedUrl, generateUploadUrl } from '../utils/storage.js';
import { authenticateToken } from '../middleware/auth.js';
import rateLimit from 'express-rate-limit';
import { cacheGet } from '../utils/responseCache.js';
import {
  interpretDream,
  normalizeInterpretLanguage,
  MAX_DREAM_LENGTH,
  MAX_QUESTION_LENGTH,
  MAX_FOLLOWUP_TURNS,
} from '../services/swapnaInterpretService.js';

const router = express.Router();

// AI calls cost money: cap per logged-in user (runs after authenticateToken, so req.user exists)
const interpretLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?._id),
  validate: { keyGeneratorIpFallback: false },
  message: { success: false, error: 'RATE_LIMITED', message: 'Too many requests. Please wait a minute and try again.' },
});

// POST AI dream interpretation + follow-ups (PROTECTED, app users only) - MUST be before /:id routes
// Body: { dream, language?: 'hi'|'en', question?, history?: [{question, answer}] }
router.post('/interpret', authenticateToken, interpretLimiter, async (req, res) => {
  try {
    if (req.decodedRole !== 'user') {
      return res.status(403).json({ success: false, error: 'INVALID_ROLE', message: 'Only app users can decode dreams.' });
    }

    const dream = String(req.body?.dream ?? '').trim();
    const question = String(req.body?.question ?? '').trim();

    if (dream.length < 10) {
      return res.status(400).json({ success: false, error: 'DREAM_TOO_SHORT', message: 'Please describe your dream in a little more detail.' });
    }
    if (dream.length > MAX_DREAM_LENGTH || question.length > MAX_QUESTION_LENGTH) {
      return res.status(400).json({ success: false, error: 'INPUT_TOO_LONG', message: 'Your text is too long. Please shorten it.' });
    }

    const history = (Array.isArray(req.body?.history) ? req.body.history : [])
      .slice(-MAX_FOLLOWUP_TURNS)
      .map((t) => ({ question: String(t?.question ?? '').slice(0, MAX_QUESTION_LENGTH), answer: String(t?.answer ?? '').slice(0, 800) }))
      .filter((t) => t.question && t.answer);

    const clientId = req.user?.clientId?.clientId || req.user?.tokenClientId || undefined;

    const data = await interpretDream({
      dream,
      language: normalizeInterpretLanguage(req.body?.language),
      question: question || undefined,
      history,
      clientId,
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error interpreting dream:', error);
    res.status(500).json({ success: false, error: 'INTERPRET_FAILED', message: 'Could not decode your dream right now. Please try again.' });
  }
});

// GET search suggestions - MUST be before /:id (PUBLIC)
router.get('/search/suggestions', cacheGet({ ttlSeconds: 120, tag: 'swapna' }), async (req, res) => {
  try {
    const { q, clientId } = req.query;
    
    if (!q || q.length < 2) {
      return res.json([]);
    }
    
    const filter = { status: 'Active' };
    if (clientId) filter.clientId = clientId;
    
    const regex = new RegExp(q, 'i');
    filter.$or = [
      { symbolName: regex },
      { symbolNameHindi: regex },
      { tags: regex }
    ];
    
    const suggestions = await SwapnaDecoder.find(filter)
      .select('symbolName symbolNameHindi category')
      .limit(10)
      .lean();
    
    res.json(suggestions);
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    res.status(500).json({ error: 'Failed to fetch suggestions', message: error.message });
  }
});

// GET analytics/stats - MUST be before /:id (PROTECTED)
router.get('/analytics/stats', authenticateToken, async (req, res) => {
  try {
    const { clientId } = req.query;
    const filter = clientId ? { clientId } : {};
    
    const [totalCount, activeCount, categoryStats, topViewed] = await Promise.all([
      SwapnaDecoder.countDocuments(filter),
      SwapnaDecoder.countDocuments({ ...filter, status: 'Active' }),
      SwapnaDecoder.aggregate([
        { $match: filter },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      SwapnaDecoder.find(filter)
        .sort({ viewCount: -1 })
        .limit(10)
        .select('symbolName symbolNameHindi viewCount category')
        .lean()
    ]);
    
    res.json({
      totalCount,
      activeCount,
      inactiveCount: totalCount - activeCount,
      categoryStats,
      topViewed
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics', message: error.message });
  }
});

// GET all dream symbols with filtering, sorting, and search (PUBLIC for Active, PROTECTED for management)
router.get('/', cacheGet({ ttlSeconds: 120, tag: 'swapna' }), async (req, res) => {
  try {
    const { status, category, subcategory, clientId, search, tags } = req.query;
    const filter = {};
    
    if (clientId) filter.clientId = clientId;
    if (status) filter.status = status;
    if (category) filter.category = category;
    if (subcategory) filter.subcategory = subcategory;
    if (tags) filter.tags = { $in: tags.split(',').map(t => t.trim()) };
    
    // Text search
    if (search) {
      filter.$text = { $search: search };
    }
    
    const dreams = await SwapnaDecoder.find(filter)
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();
    
    // Generate presigned URLs for thumbnails
    const dreamsWithSignedUrls = await Promise.all(
      dreams.map(async (dream) => {
        if (dream.thumbnailKey) {
          try {
            dream.thumbnailUrl = await getPresignedUrl(dream.thumbnailKey);
          } catch (error) {
            console.error(`Error generating presigned URL for ${dream.thumbnailKey}:`, error);
          }
        } else if (dream.thumbnailUrl && dream.thumbnailUrl.includes('s3.amazonaws.com')) {
          try {
            const url = new URL(dream.thumbnailUrl);
            const key = url.pathname.substring(1);
            dream.thumbnailUrl = await getPresignedUrl(key);
          } catch (error) {
            console.error(`Error extracting key from URL:`, error);
          }
        }
        
        return dream;
      })
    );
    
    res.json(dreamsWithSignedUrls);
  } catch (error) {
    console.error('Error fetching dream symbols:', error);
    res.status(500).json({ error: 'Failed to fetch dream symbols', message: error.message });
  }
});

// GET single dream symbol by ID (PUBLIC)
router.get('/:id', async (req, res) => {
  try {
    const dream = await SwapnaDecoder.findById(req.params.id).lean();
    
    if (!dream) {
      return res.status(404).json({ error: 'Dream symbol not found' });
    }
    
    // Generate presigned URL for thumbnail
    if (dream.thumbnailKey) {
      try {
        dream.thumbnailUrl = await getPresignedUrl(dream.thumbnailKey);
      } catch (error) {
        console.error(`Error generating presigned URL for ${dream.thumbnailKey}:`, error);
      }
    } else if (dream.thumbnailUrl && dream.thumbnailUrl.includes('s3.amazonaws.com')) {
      try {
        const url = new URL(dream.thumbnailUrl);
        const key = url.pathname.substring(1);
        dream.thumbnailUrl = await getPresignedUrl(key);
      } catch (error) {
        console.error(`Error extracting key from URL:`, error);
      }
    }
    
    // Increment view count
    await SwapnaDecoder.findByIdAndUpdate(req.params.id, { $inc: { viewCount: 1 } });
    
    res.json(dream);
  } catch (error) {
    console.error('Error fetching dream symbol:', error);
    res.status(500).json({ error: 'Failed to fetch dream symbol', message: error.message });
  }
});

// POST presigned URL for S3 upload (PROTECTED)
router.post('/upload-url', authenticateToken, async (req, res) => {
  try {
    const { fileName, fileType } = req.body;
    
    if (!fileName || !fileType) {
      return res.status(400).json({ error: 'fileName and fileType are required' });
    }
    
    const timestamp = Date.now();
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const { uploadUrl, fileUrl, key } = await generateUploadUrl(fileName, fileType, 'swapna-decoder');
    res.json({ uploadUrl, fileUrl, key });
  } catch (error) {
    console.error('Error generating upload URL:', error);
    res.status(500).json({ error: 'Failed to generate upload URL', message: error.message });
  }
});

// POST create new dream symbol (PROTECTED)
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      symbolName,
      symbolNameHindi,
      category,
      subcategory,
      thumbnailUrl,
      thumbnailKey,
      shortDescription,
      detailedInterpretation,
      positiveAspects,
      negativeAspects,
      contextVariations,
      astrologicalSignificance,
      vedicReferences,
      remedies,
      relatedSymbols,
      frequencyImpact,
      timeSignificance,
      genderSpecific,
      tags,
      status,
      sortOrder
    } = req.body;

    // A client always creates symbols for itself: take the id from the token, never from the request body.
    // (Admins may still pass one explicitly.)
    const clientId = req.user?.role === 'client' ? req.user.clientId : req.body.clientId;
    
    // Validation
    if (!symbolName || !symbolNameHindi || !category) {
      return res.status(400).json({ error: 'symbolName, symbolNameHindi, and category are required' });
    }
    
    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }
    
    // Auto-generate sortOrder if not provided
    let finalSortOrder = sortOrder ? Number(sortOrder) : 0;
    if (!sortOrder) {
      const maxSortOrder = await SwapnaDecoder.findOne({ clientId }).sort({ sortOrder: -1 }).select('sortOrder');
      finalSortOrder = maxSortOrder ? maxSortOrder.sortOrder + 1 : 1;
    }
    
    // Clean up empty arrays
    const cleanedPositiveAspects = positiveAspects?.filter(a => a.point?.trim() && a.description?.trim()) || [];
    const cleanedNegativeAspects = negativeAspects?.filter(a => a.point?.trim() && a.description?.trim()) || [];
    const cleanedContextVariations = contextVariations?.filter(c => c.context?.trim() && c.meaning?.trim()) || [];
    const cleanedRelatedSymbols = relatedSymbols?.filter(s => s?.trim()) || [];
    const cleanedTags = tags?.filter(t => t?.trim()) || [];
    
    // Clean up remedies
    const cleanedRemedies = {
      mantras: remedies?.mantras?.filter(m => m?.trim()) || [],
      pujas: remedies?.pujas?.filter(p => p?.trim()) || [],
      donations: remedies?.donations?.filter(d => d?.trim()) || [],
      precautions: remedies?.precautions?.filter(p => p?.trim()) || []
    };
    
    const dream = new SwapnaDecoder({
      symbolName,
      symbolNameHindi,
      category,
      subcategory,
      thumbnailUrl,
      thumbnailKey,
      shortDescription,
      detailedInterpretation,
      positiveAspects: cleanedPositiveAspects,
      negativeAspects: cleanedNegativeAspects,
      contextVariations: cleanedContextVariations,
      astrologicalSignificance,
      vedicReferences,
      remedies: cleanedRemedies,
      relatedSymbols: cleanedRelatedSymbols,
      frequencyImpact,
      timeSignificance: timeSignificance || {},
      genderSpecific: genderSpecific || {},
      tags: cleanedTags,
      clientId,
      status: status || 'Active',
      sortOrder: finalSortOrder
    });
    
    await dream.save();
    
    res.status(201).json(dream);
  } catch (error) {
    console.error('Error creating dream symbol:', error);
    res.status(500).json({ error: 'Failed to create dream symbol', message: error.message });
  }
});

// PUT update dream symbol (PROTECTED)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const {
      symbolName,
      symbolNameHindi,
      category,
      subcategory,
      thumbnailUrl,
      thumbnailKey,
      shortDescription,
      detailedInterpretation,
      positiveAspects,
      negativeAspects,
      contextVariations,
      astrologicalSignificance,
      vedicReferences,
      remedies,
      relatedSymbols,
      frequencyImpact,
      timeSignificance,
      genderSpecific,
      tags,
      status,
      sortOrder
    } = req.body;
    
    const updateData = {};
    
    if (symbolName !== undefined) updateData.symbolName = symbolName;
    if (symbolNameHindi !== undefined) updateData.symbolNameHindi = symbolNameHindi;
    if (category !== undefined) updateData.category = category;
    if (subcategory !== undefined) updateData.subcategory = subcategory;
    if (thumbnailUrl !== undefined) updateData.thumbnailUrl = thumbnailUrl;
    if (thumbnailKey !== undefined) updateData.thumbnailKey = thumbnailKey;
    if (shortDescription !== undefined) updateData.shortDescription = shortDescription;
    if (detailedInterpretation !== undefined) updateData.detailedInterpretation = detailedInterpretation;
    if (astrologicalSignificance !== undefined) updateData.astrologicalSignificance = astrologicalSignificance;
    if (vedicReferences !== undefined) updateData.vedicReferences = vedicReferences;
    if (frequencyImpact !== undefined) updateData.frequencyImpact = frequencyImpact;
    if (status !== undefined) updateData.status = status;
    if (sortOrder !== undefined) updateData.sortOrder = Number(sortOrder);
    
    // Clean up arrays
    if (positiveAspects !== undefined) {
      updateData.positiveAspects = positiveAspects.filter(a => a.point?.trim() && a.description?.trim());
    }
    if (negativeAspects !== undefined) {
      updateData.negativeAspects = negativeAspects.filter(a => a.point?.trim() && a.description?.trim());
    }
    if (contextVariations !== undefined) {
      updateData.contextVariations = contextVariations.filter(c => c.context?.trim() && c.meaning?.trim());
    }
    if (relatedSymbols !== undefined) {
      updateData.relatedSymbols = relatedSymbols.filter(s => s?.trim());
    }
    if (tags !== undefined) {
      updateData.tags = tags.filter(t => t?.trim());
    }
    
    // Clean up remedies
    if (remedies !== undefined) {
      updateData.remedies = {
        mantras: remedies.mantras?.filter(m => m?.trim()) || [],
        pujas: remedies.pujas?.filter(p => p?.trim()) || [],
        donations: remedies.donations?.filter(d => d?.trim()) || [],
        precautions: remedies.precautions?.filter(p => p?.trim()) || []
      };
    }
    
    if (timeSignificance !== undefined) updateData.timeSignificance = timeSignificance;
    if (genderSpecific !== undefined) updateData.genderSpecific = genderSpecific;
    
    const dream = await SwapnaDecoder.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!dream) {
      return res.status(404).json({ error: 'Dream symbol not found' });
    }
    
    res.json(dream);
  } catch (error) {
    console.error('Error updating dream symbol:', error);
    res.status(500).json({ error: 'Failed to update dream symbol', message: error.message });
  }
});

// PATCH toggle status (PROTECTED)
router.patch('/:id/toggle-status', authenticateToken, async (req, res) => {
  try {
    const dream = await SwapnaDecoder.findById(req.params.id);
    
    if (!dream) {
      return res.status(404).json({ error: 'Dream symbol not found' });
    }
    
    // Toggle between Active and Inactive
    dream.status = dream.status === 'Active' ? 'Inactive' : 'Active';
    await dream.save();
    
    res.json({ message: 'Status toggled successfully', data: dream });
  } catch (error) {
    console.error('Error toggling status:', error);
    res.status(500).json({ error: 'Failed to toggle status', message: error.message });
  }
});

// DELETE dream symbol (PROTECTED)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const dream = await SwapnaDecoder.findByIdAndDelete(req.params.id);
    
    if (!dream) {
      return res.status(404).json({ error: 'Dream symbol not found' });
    }
    
    res.json({ message: 'Dream symbol deleted successfully', data: dream });
  } catch (error) {
    console.error('Error deleting dream symbol:', error);
    res.status(500).json({ error: 'Failed to delete dream symbol', message: error.message });
  }
});

export default router;
