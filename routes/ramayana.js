import express from 'express';
import multer from 'multer';
import Ramayana from '../models/Ramayana.js';
import RamayanaVerse from '../models/RamayanaVerse.js';
import { authenticate } from '../middleware/auth.js';
import { uploadFile, getPresignedUrl } from '../utils/storage.js';

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('Only audio files are allowed'), false);
  }
});

const getClientId = async (user) => {
  if (user.role === 'client') return user.clientId;
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
  if (obj.imageUrl) { try { obj.imageUrl = await getPresignedUrl(obj.imageUrl); } catch {} }
  if (obj.audioUrl) { try { obj.audioUrl = await getPresignedUrl(obj.audioUrl); } catch {} }
  return obj;
};

// ─── Kanda Routes ─────────────────────────────────────────────────────────────

// GET all kandas
router.get('/', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    let kandas = await Ramayana.find({ clientId }).sort({ kandaNumber: 1 });
    if (req.query.includeInactive !== 'true') kandas = kandas.filter(k => k.status === 'active');
    const data = await Promise.all(kandas.map(withSignedUrl));
    res.json({ success: true, data, total: data.length });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch kandas', error: error.message });
  }
});

// GET single kanda
router.get('/:id', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const kanda = await Ramayana.findOne({ _id: req.params.id, clientId });
    if (!kanda) return res.status(404).json({ success: false, message: 'Kanda not found' });
    res.json({ success: true, data: await withSignedUrl(kanda) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch kanda', error: error.message });
  }
});

// POST create kanda
router.post('/', authenticate, upload.single('image'), async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    if (!clientId) return res.status(400).json({ success: false, message: 'Client ID could not be resolved. Please re-login.' });

    const { title, kandaNumber, description, verseCount, status } = req.body;

    const existing = await Ramayana.findOne({ kandaNumber: parseInt(kandaNumber), clientId });
    if (existing) return res.status(400).json({ success: false, message: `Kanda ${kandaNumber} already exists` });

    let imageUrl = null;
    if (req.file) {
      const result = await uploadFile(req.file, 'ramayana');
      imageUrl = result.key || result.url;
    }

    const kanda = await Ramayana.create({
      title, kandaNumber: parseInt(kandaNumber), description,
      verseCount: parseInt(verseCount), imageUrl, status: status || 'active', clientId
    });

    res.status(201).json({ success: true, message: 'Kanda created successfully', data: await withSignedUrl(kanda) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to create kanda', error: error.message });
  }
});

// PUT update kanda
router.put('/:id', authenticate, upload.single('image'), async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const { title, kandaNumber, description, verseCount, status } = req.body;

    const updateData = { title, kandaNumber: parseInt(kandaNumber), description, verseCount: parseInt(verseCount), status };
    if (req.file) {
      const result = await uploadFile(req.file, 'ramayana');
      updateData.imageUrl = result.key || result.url;
    }

    const kanda = await Ramayana.findOneAndUpdate({ _id: req.params.id, clientId }, updateData, { new: true });
    if (!kanda) return res.status(404).json({ success: false, message: 'Kanda not found' });

    res.json({ success: true, message: 'Kanda updated successfully', data: await withSignedUrl(kanda) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update kanda', error: error.message });
  }
});

// DELETE kanda
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const kanda = await Ramayana.findOneAndDelete({ _id: req.params.id, clientId });
    if (!kanda) return res.status(404).json({ success: false, message: 'Kanda not found' });
    res.json({ success: true, message: 'Kanda deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete kanda', error: error.message });
  }
});

// PATCH toggle kanda status
router.patch('/:id/toggle-status', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const kanda = await Ramayana.findOne({ _id: req.params.id, clientId });
    if (!kanda) return res.status(404).json({ success: false, message: 'Kanda not found' });
    kanda.status = kanda.status === 'active' ? 'inactive' : 'active';
    await kanda.save();
    res.json({ success: true, message: `Kanda ${kanda.status === 'active' ? 'enabled' : 'disabled'}`, data: await withSignedUrl(kanda) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to toggle status', error: error.message });
  }
});

// ─── Verse Routes ─────────────────────────────────────────────────────────────

// GET all verses
router.get('/:kandaId/verses', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const verses = await RamayanaVerse.find({ kandaId: req.params.kandaId, clientId }).sort({ verseNumber: 1 });
    const data = await Promise.all(verses.map(withSignedUrl));
    res.json({ success: true, data, total: data.length });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch verses', error: error.message });
  }
});

// POST create verse
router.post('/:kandaId/verses', authenticate, uploadAudio.single('audio'), async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const { verseNumber, sanskrit, transliteration, hindi, english, explanation, status } = req.body;

    const existing = await RamayanaVerse.findOne({ kandaId: req.params.kandaId, verseNumber: parseInt(verseNumber), clientId });
    if (existing) return res.status(400).json({ success: false, message: `Verse ${verseNumber} already exists in this kanda` });

    let audioUrl = null;
    if (req.file) {
      const result = await uploadFile(req.file, 'ramayana/audio');
      audioUrl = result.key || result.url;
    }

    const verse = await RamayanaVerse.create({
      kandaId: req.params.kandaId, verseNumber: parseInt(verseNumber),
      sanskrit, transliteration: transliteration || '', hindi: hindi || '',
      english: english || '', explanation: explanation || '',
      audioUrl, status: status || 'active', clientId
    });

    res.status(201).json({ success: true, message: 'Verse created successfully', data: await withSignedUrl(verse) });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Verse number already exists in this kanda' });
    res.status(500).json({ success: false, message: 'Failed to create verse', error: error.message });
  }
});

// PUT update verse
router.put('/:kandaId/verses/:id', authenticate, uploadAudio.single('audio'), async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const { verseNumber, sanskrit, transliteration, hindi, english, explanation, status } = req.body;

    const updateData = {
      verseNumber: parseInt(verseNumber), sanskrit,
      transliteration: transliteration || '', hindi: hindi || '',
      english: english || '', explanation: explanation || '', status
    };

    if (req.file) {
      const result = await uploadFile(req.file, 'ramayana/audio');
      updateData.audioUrl = result.key || result.url;
    }

    const verse = await RamayanaVerse.findOneAndUpdate(
      { _id: req.params.id, kandaId: req.params.kandaId, clientId },
      updateData, { new: true, runValidators: true }
    );
    if (!verse) return res.status(404).json({ success: false, message: 'Verse not found' });

    res.json({ success: true, message: 'Verse updated successfully', data: await withSignedUrl(verse) });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Verse number already exists in this kanda' });
    res.status(500).json({ success: false, message: 'Failed to update verse', error: error.message });
  }
});

// DELETE verse
router.delete('/:kandaId/verses/:id', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const verse = await RamayanaVerse.findOneAndDelete({ _id: req.params.id, kandaId: req.params.kandaId, clientId });
    if (!verse) return res.status(404).json({ success: false, message: 'Verse not found' });
    res.json({ success: true, message: 'Verse deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete verse', error: error.message });
  }
});

// PATCH toggle verse status
router.patch('/:kandaId/verses/:id/toggle-status', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const verse = await RamayanaVerse.findOne({ _id: req.params.id, kandaId: req.params.kandaId, clientId });
    if (!verse) return res.status(404).json({ success: false, message: 'Verse not found' });
    verse.status = verse.status === 'active' ? 'inactive' : 'active';
    await verse.save();
    res.json({ success: true, message: `Verse ${verse.status === 'active' ? 'enabled' : 'disabled'}`, data: await withSignedUrl(verse) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to toggle verse status', error: error.message });
  }
});

export default router;
