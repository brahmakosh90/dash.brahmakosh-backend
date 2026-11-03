import express from 'express';
import PujaPadhati from '../models/PujaPadhati.js';
import { generateUploadUrl, extractS3KeyFromUrl } from '../utils/storage.js';
import { withSignedMedia, isOwnStorageUrl } from '../utils/mediaUrls.js';

import { cacheGet } from '../utils/responseCache.js';
const router = express.Router();

const MEDIA_KINDS = ['thumbnail', 'audio', 'video'];

// A storage key must always describe the file the URL/upload points to. The dashboard used to send a new URL
// next to the OLD key (or a key that never existed), so the signed URL kept showing the old / a missing file.
//  - key sent                      -> use it
//  - only a URL of our own storage -> derive the key from it
//  - only some other URL (or none) -> no key, so the stored URL is served as is
const resolveKey = (url, key) => {
  if (typeof key === 'string' && key.trim()) return key.trim();
  if (typeof url === 'string' && url.trim() && isOwnStorageUrl(url)) {
    const extracted = extractS3KeyFromUrl(url);
    // R2 path-style URLs carry the bucket name as the first path segment; it is not part of the key
    const bucket = process.env.R2_BUCKET;
    return extracted && bucket && extracted.startsWith(`${bucket}/`) ? extracted.slice(bucket.length + 1) : extracted;
  }
  return null;
};

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
      .select('-pujaVidhi -samagriList -mantras -specialInstructions -muhurat -audioUrl -audioKey -videoUrl -videoKey')
      .lean();
    
    // Fresh signed URLs for thumbnail, audio and video (resolved from the stored key, or from our own storage URL)
    const pujasWithSignedUrls = await Promise.all(pujas.map((puja) => withSignedMedia(puja, MEDIA_KINDS)));

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
    
    res.json(await withSignedMedia(puja, MEDIA_KINDS));
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
    
    // `key` must be the one generateUploadUrl signed the upload for; a separately built key points at a file that does not exist
    const { uploadUrl, fileUrl, key } = await generateUploadUrl(fileName, fileType, 'puja-padhati');
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
      thumbnailKey: resolveKey(thumbnailUrl, thumbnailKey),
      pujaVidhi: pujaVidhi || [],
      samagriList: samagriList || [],
      mantras: mantras || [],
      specialInstructions,
      muhurat,
      audioUrl,
      audioKey: resolveKey(audioUrl, audioKey),
      videoUrl,
      videoKey: resolveKey(videoUrl, videoKey),
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
    if (thumbnailUrl !== undefined || thumbnailKey !== undefined) {
      updateData.thumbnailUrl = thumbnailUrl ?? null;
      updateData.thumbnailKey = resolveKey(thumbnailUrl, thumbnailKey);
    }
    if (pujaVidhi !== undefined) updateData.pujaVidhi = pujaVidhi;
    if (samagriList !== undefined) updateData.samagriList = samagriList;
    if (mantras !== undefined) updateData.mantras = mantras;
    if (specialInstructions !== undefined) updateData.specialInstructions = specialInstructions;
    if (muhurat !== undefined) updateData.muhurat = muhurat;
    if (audioUrl !== undefined || audioKey !== undefined) {
      updateData.audioUrl = audioUrl ?? null;
      updateData.audioKey = resolveKey(audioUrl, audioKey);
    }
    if (videoUrl !== undefined || videoKey !== undefined) {
      updateData.videoUrl = videoUrl ?? null;
      updateData.videoKey = resolveKey(videoUrl, videoKey);
    }
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
