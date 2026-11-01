import express from 'express';
import PujaPadhati from '../models/PujaPadhati.js';
import { getPresignedUrl, generateUploadUrl } from '../utils/storage.js';

import { cacheGet } from '../utils/responseCache.js';
const router = express.Router();

// GET all pujas with filtering and sorting
router.get('/', cacheGet({ ttlSeconds: 120, tag: 'puja' }), async (req, res) => {
  try {
    const { status, category, subcategory, clientId } = req.query;
    const filter = {};
    
    if (clientId) filter.clientId = clientId;
    if (status) filter.status = status;
    if (category) filter.category = category;
    if (subcategory) filter.subcategory = subcategory;
    
    const pujas = await PujaPadhati.find(filter)
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();
    
    // Generate presigned URLs for thumbnails, audio, and video
    const pujasWithSignedUrls = await Promise.all(
      pujas.map(async (puja) => {
        if (puja.thumbnailKey) {
          try {
            puja.thumbnailUrl = await getPresignedUrl(puja.thumbnailKey);
          } catch (error) {
            console.error(`Error generating presigned URL for ${puja.thumbnailKey}:`, error);
          }
        } else if (puja.thumbnailUrl && puja.thumbnailUrl.includes('s3.amazonaws.com')) {
          // Fallback: If thumbnailKey missing but URL exists, try to extract key
          try {
            const url = new URL(puja.thumbnailUrl);
            const key = url.pathname.substring(1);
            puja.thumbnailUrl = await getPresignedUrl(key);
          } catch (error) {
            console.error(`Error extracting key from URL:`, error);
          }
        }
        
        // Generate presigned URL for audio
        if (puja.audioKey) {
          try {
            puja.audioUrl = await getPresignedUrl(puja.audioKey);
          } catch (error) {
            console.error(`Error generating presigned URL for audio ${puja.audioKey}:`, error);
          }
        }
        
        // Generate presigned URL for video
        if (puja.videoKey) {
          try {
            puja.videoUrl = await getPresignedUrl(puja.videoKey);
          } catch (error) {
            console.error(`Error generating presigned URL for video ${puja.videoKey}:`, error);
          }
        }
        
        return puja;
      })
    );
    
    res.json(pujasWithSignedUrls);
  } catch (error) {
    console.error('Error fetching pujas:', error);
    res.status(500).json({ error: 'Failed to fetch pujas', message: error.message });
  }
});

// GET single puja by ID
router.get('/:id', async (req, res) => {
  try {
    const puja = await PujaPadhati.findById(req.params.id).lean();
    
    if (!puja) {
      return res.status(404).json({ error: 'Puja not found' });
    }
    
    // Generate presigned URL for thumbnail
    if (puja.thumbnailKey) {
      try {
        puja.thumbnailUrl = await getPresignedUrl(puja.thumbnailKey);
      } catch (error) {
        console.error(`Error generating presigned URL for ${puja.thumbnailKey}:`, error);
      }
    } else if (puja.thumbnailUrl && puja.thumbnailUrl.includes('s3.amazonaws.com')) {
      // Fallback: If thumbnailKey missing but URL exists, try to extract key
      try {
        const url = new URL(puja.thumbnailUrl);
        const key = url.pathname.substring(1);
        puja.thumbnailUrl = await getPresignedUrl(key);
      } catch (error) {
        console.error(`Error extracting key from URL:`, error);
      }
    }
    
    // Generate presigned URL for audio
    if (puja.audioKey) {
      try {
        puja.audioUrl = await getPresignedUrl(puja.audioKey);
      } catch (error) {
        console.error(`Error generating presigned URL for audio ${puja.audioKey}:`, error);
      }
    }
    
    // Generate presigned URL for video
    if (puja.videoKey) {
      try {
        puja.videoUrl = await getPresignedUrl(puja.videoKey);
      } catch (error) {
        console.error(`Error generating presigned URL for video ${puja.videoKey}:`, error);
      }
    }
    
    res.json(puja);
  } catch (error) {
    console.error('Error fetching puja:', error);
    res.status(500).json({ error: 'Failed to fetch puja', message: error.message });
  }
});

// GET presigned URL for S3 upload
router.post('/upload-url', async (req, res) => {
  try {
    const { fileName, fileType } = req.body;
    
    if (!fileName || !fileType) {
      return res.status(400).json({ error: 'fileName and fileType are required' });
    }
    
    const timestamp = Date.now();
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `puja-padhati/${timestamp}-${sanitizedFileName}`;
    const { uploadUrl, fileUrl } = await generateUploadUrl(fileName, fileType, 'puja-padhati');
    res.json({ uploadUrl, fileUrl, key });
  } catch (error) {
    console.error('Error generating upload URL:', error);
    res.status(500).json({ error: 'Failed to generate upload URL', message: error.message });
  }
});

// POST create new puja
router.post('/', async (req, res) => {
  try {
    const {
      pujaName,
      category,
      subcategory,
      purpose,
      description,
      bestDay,
      duration,
      language,
      thumbnailUrl,
      thumbnailKey,
      pujaVidhi,
      samagriList,
      mantras,
      specialInstructions,
      muhurat,
      audioUrl,
      audioKey,
      videoUrl,
      videoKey,
      clientId,
      status,
      sortOrder
    } = req.body;
    
    // Validation
    if (!pujaName || !category) {
      return res.status(400).json({ error: 'pujaName and category are required' });
    }
    
    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }
    
    // Auto-generate sortOrder if not provided
    let finalSortOrder = sortOrder ? Number(sortOrder) : 0;
    if (!sortOrder) {
      const maxSortOrder = await PujaPadhati.findOne({ clientId }).sort({ sortOrder: -1 }).select('sortOrder');
      finalSortOrder = maxSortOrder ? maxSortOrder.sortOrder + 1 : 1;
    }
    
    const puja = new PujaPadhati({
      pujaName,
      category,
      subcategory,
      purpose,
      description,
      bestDay,
      duration: duration ? Number(duration) : undefined,
      language: language || 'Hindi',
      thumbnailUrl,
      thumbnailKey,
      pujaVidhi: pujaVidhi || [],
      samagriList: samagriList || [],
      mantras: mantras || [],
      specialInstructions,
      muhurat,
      audioUrl,
      audioKey,
      videoUrl,
      videoKey,
      clientId,
      status: status || 'Active',
      sortOrder: finalSortOrder
    });
    
    await puja.save();
    
    res.status(201).json(puja);
  } catch (error) {
    console.error('Error creating puja:', error);
    res.status(500).json({ error: 'Failed to create puja', message: error.message });
  }
});

// PUT update puja
router.put('/:id', async (req, res) => {
  try {
    const {
      pujaName,
      category,
      subcategory,
      purpose,
      description,
      bestDay,
      duration,
      language,
      thumbnailUrl,
      thumbnailKey,
      pujaVidhi,
      samagriList,
      mantras,
      specialInstructions,
      muhurat,
      audioUrl,
      audioKey,
      videoUrl,
      videoKey,
      status,
      sortOrder
    } = req.body;
    
    const updateData = {};
    
    if (pujaName !== undefined) updateData.pujaName = pujaName;
    if (category !== undefined) updateData.category = category;
    if (subcategory !== undefined) updateData.subcategory = subcategory;
    if (purpose !== undefined) updateData.purpose = purpose;
    if (description !== undefined) updateData.description = description;
    if (bestDay !== undefined) updateData.bestDay = bestDay;
    if (duration !== undefined) updateData.duration = Number(duration);
    if (language !== undefined) updateData.language = language;
    if (thumbnailUrl !== undefined) updateData.thumbnailUrl = thumbnailUrl;
    if (thumbnailKey !== undefined) updateData.thumbnailKey = thumbnailKey;
    if (pujaVidhi !== undefined) updateData.pujaVidhi = pujaVidhi;
    if (samagriList !== undefined) updateData.samagriList = samagriList;
    if (mantras !== undefined) updateData.mantras = mantras;
    if (specialInstructions !== undefined) updateData.specialInstructions = specialInstructions;
    if (muhurat !== undefined) updateData.muhurat = muhurat;
    if (audioUrl !== undefined) updateData.audioUrl = audioUrl;
    if (audioKey !== undefined) updateData.audioKey = audioKey;
    if (videoUrl !== undefined) updateData.videoUrl = videoUrl;
    if (videoKey !== undefined) updateData.videoKey = videoKey;
    if (status !== undefined) updateData.status = status;
    if (sortOrder !== undefined) updateData.sortOrder = Number(sortOrder);
    
    const puja = await PujaPadhati.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!puja) {
      return res.status(404).json({ error: 'Puja not found' });
    }
    
    res.json(puja);
  } catch (error) {
    console.error('Error updating puja:', error);
    res.status(500).json({ error: 'Failed to update puja', message: error.message });
  }
});

// PATCH toggle status
router.patch('/:id/toggle-status', async (req, res) => {
  try {
    const puja = await PujaPadhati.findById(req.params.id);
    
    if (!puja) {
      return res.status(404).json({ error: 'Puja not found' });
    }
    
    // Toggle between Active and Inactive
    puja.status = puja.status === 'Active' ? 'Inactive' : 'Active';
    await puja.save();
    
    res.json({ message: 'Status toggled successfully', data: puja });
  } catch (error) {
    console.error('Error toggling status:', error);
    res.status(500).json({ error: 'Failed to toggle status', message: error.message });
  }
});

// DELETE puja
router.delete('/:id', async (req, res) => {
  try {
    const puja = await PujaPadhati.findByIdAndDelete(req.params.id);
    
    if (!puja) {
      return res.status(404).json({ error: 'Puja not found' });
    }
    
    res.json({ message: 'Puja deleted successfully', data: puja });
  } catch (error) {
    console.error('Error deleting puja:', error);
    res.status(500).json({ error: 'Failed to delete puja', message: error.message });
  }
});

export default router;
