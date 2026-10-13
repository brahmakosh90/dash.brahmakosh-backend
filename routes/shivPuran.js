import express from 'express';
import multer from 'multer';
import ShivPuran from '../models/ShivPuran.js';
import ShivPuranVerse from '../models/ShivPuranVerse.js';
import { authenticate } from '../middleware/auth.js';
import { uploadFile, getPresignedUrl } from '../utils/storage.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('Only audio files are allowed'), false);
  }
});

const getClientId = async (user) => {
  if (user.role === 'client') {
    return user.clientId;
  }
  if (user.role === 'user') {
    let clientId = user.clientId?.clientId || user.tokenClientId || user.clientId;
    if (clientId && /^[0-9a-fA-F]{24}$/.test(String(clientId))) {
      const Client = (await import('../models/Client.js')).default;
      const client = await Client.findById(clientId);
      if (client?.clientId) return client.clientId;
    }
    return clientId;
  }
  return null;
};

const withSignedUrl = async (doc) => {
  const obj = doc.toObject ? doc.toObject() : doc;
  if (obj.imageUrl) {
    try { obj.imageUrl = await getPresignedUrl(obj.imageUrl); } catch {}
  }
  if (obj.audioUrl) {
    try { obj.audioUrl = await getPresignedUrl(obj.audioUrl); } catch {}
  }
  return obj;
};

// GET all
router.get('/', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const { includeInactive } = req.query;

    let parts = await ShivPuran.find({ clientId }).sort({ partNumber: 1 });

    if (!includeInactive || includeInactive !== 'true') {
      parts = parts.filter(p => p.status === 'active');
    }

    const data = await Promise.all(parts.map(withSignedUrl));
    res.json({ success: true, data, total: data.length });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch parts', error: error.message });
  }
});

// GET single
router.get('/:id', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const part = await ShivPuran.findOne({ _id: req.params.id, clientId });
    if (!part) return res.status(404).json({ success: false, message: 'Part not found' });

    res.json({ success: true, data: await withSignedUrl(part) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch part', error: error.message });
  }
});

// POST create
router.post('/', authenticate, upload.single('image'), async (req, res) => {
  try {
    const { title, partNumber, description, verseCount, status } = req.body;
    const clientId = await getClientId(req.user);

    console.log('[ShivPuran POST] role:', req.user.role, '| clientId:', clientId);

    if (!clientId) {
      return res.status(400).json({ success: false, message: 'Client ID could not be resolved. Please re-login.' });
    }

    const existing = await ShivPuran.findOne({ partNumber: parseInt(partNumber), clientId });
    if (existing) {
      return res.status(400).json({ success: false, message: `Part ${partNumber} already exists` });
    }

    let imageUrl = null;
    if (req.file) {
      const result = await uploadFile(req.file, 'shiv-puran');
      imageUrl = result.key || result.url;
    }

    const part = await ShivPuran.create({
      title,
      partNumber: parseInt(partNumber),
      description,
      verseCount: parseInt(verseCount),
      imageUrl,
      status: status || 'active',
      clientId
    });

    res.status(201).json({ success: true, message: 'Part created successfully', data: await withSignedUrl(part) });
  } catch (error) {
    console.error('[ShivPuran POST] error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to create part', error: error.message });
  }
});

// PUT update
router.put('/:id', authenticate, upload.single('image'), async (req, res) => {
  try {
    const { title, partNumber, description, verseCount, status } = req.body;
    const clientId = await getClientId(req.user);

    const updateData = {
      title,
      partNumber: parseInt(partNumber),
      description,
      verseCount: parseInt(verseCount),
      status
    };

    if (req.file) {
      const result = await uploadFile(req.file, 'shiv-puran');
      updateData.imageUrl = result.key || result.url;
    }

    const part = await ShivPuran.findOneAndUpdate(
      { _id: req.params.id, clientId },
      updateData,
      { new: true }
    );

    if (!part) return res.status(404).json({ success: false, message: 'Part not found' });

    res.json({ success: true, message: 'Part updated successfully', data: await withSignedUrl(part) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update part', error: error.message });
  }
});

// DELETE
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const part = await ShivPuran.findOneAndDelete({ _id: req.params.id, clientId });
    if (!part) return res.status(404).json({ success: false, message: 'Part not found' });

    res.json({ success: true, message: 'Part deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete part', error: error.message });
  }
});

// PATCH toggle status
router.patch('/:id/toggle-status', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const part = await ShivPuran.findOne({ _id: req.params.id, clientId });
    if (!part) return res.status(404).json({ success: false, message: 'Part not found' });

    part.status = part.status === 'active' ? 'inactive' : 'active';
    await part.save();

    res.json({ success: true, message: `Part ${part.status === 'active' ? 'enabled' : 'disabled'} successfully`, data: await withSignedUrl(part) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to toggle status', error: error.message });
  }
});

// ─── Verse Routes ────────────────────────────────────────────────────────────

// GET all verses for a part
router.get('/:partId/verses', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const verses = await ShivPuranVerse.find({ partId: req.params.partId, clientId })
      .sort({ verseNumber: 1 });
    const data = await Promise.all(verses.map(withSignedUrl));
    res.json({ success: true, data, total: data.length });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch verses', error: error.message });
  }
});

// POST create verse
router.post('/:partId/verses', authenticate, uploadAudio.single('audio'), async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const { verseNumber, sanskrit, transliteration, hindi, english, explanation, status } = req.body;

    const existing = await ShivPuranVerse.findOne({
      partId: req.params.partId,
      verseNumber: parseInt(verseNumber),
      clientId
    });
    if (existing) {
      return res.status(400).json({ success: false, message: `Verse ${verseNumber} already exists in this part` });
    }

    let audioUrl = null;
    if (req.file) {
      const result = await uploadFile(req.file, 'shiv-puran/audio');
      audioUrl = result.key || result.url;
    }

    const verse = await ShivPuranVerse.create({
      partId: req.params.partId,
      verseNumber: parseInt(verseNumber),
      sanskrit,
      transliteration: transliteration || '',
      hindi: hindi || '',
      english: english || '',
      explanation: explanation || '',
      audioUrl,
      status: status || 'active',
      clientId
    });

    res.status(201).json({ success: true, message: 'Verse created successfully', data: await withSignedUrl(verse) });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Verse number already exists in this part' });
    }
    res.status(500).json({ success: false, message: 'Failed to create verse', error: error.message });
  }
});

// PUT update verse
router.put('/:partId/verses/:id', authenticate, uploadAudio.single('audio'), async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const { verseNumber, sanskrit, transliteration, hindi, english, explanation, status } = req.body;

    const updateData = {
      verseNumber: parseInt(verseNumber),
      sanskrit,
      transliteration: transliteration || '',
      hindi: hindi || '',
      english: english || '',
      explanation: explanation || '',
      status
    };

    if (req.file) {
      const result = await uploadFile(req.file, 'shiv-puran/audio');
      updateData.audioUrl = result.key || result.url;
    }

    const verse = await ShivPuranVerse.findOneAndUpdate(
      { _id: req.params.id, partId: req.params.partId, clientId },
      updateData,
      { new: true, runValidators: true }
    );

    if (!verse) return res.status(404).json({ success: false, message: 'Verse not found' });

    res.json({ success: true, message: 'Verse updated successfully', data: await withSignedUrl(verse) });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Verse number already exists in this part' });
    }
    res.status(500).json({ success: false, message: 'Failed to update verse', error: error.message });
  }
});

// DELETE verse
router.delete('/:partId/verses/:id', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const verse = await ShivPuranVerse.findOneAndDelete({
      _id: req.params.id,
      partId: req.params.partId,
      clientId
    });
    if (!verse) return res.status(404).json({ success: false, message: 'Verse not found' });

    res.json({ success: true, message: 'Verse deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete verse', error: error.message });
  }
});

// PATCH toggle verse status
router.patch('/:partId/verses/:id/toggle-status', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const verse = await ShivPuranVerse.findOne({
      _id: req.params.id,
      partId: req.params.partId,
      clientId
    });
    if (!verse) return res.status(404).json({ success: false, message: 'Verse not found' });

    verse.status = verse.status === 'active' ? 'inactive' : 'active';
    await verse.save();

    res.json({ success: true, message: `Verse ${verse.status === 'active' ? 'enabled' : 'disabled'}`, data: verse });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to toggle verse status', error: error.message });
  }
});

export default router;
