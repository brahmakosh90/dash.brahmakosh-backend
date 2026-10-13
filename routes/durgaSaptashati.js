import express from 'express';
import multer from 'multer';
import DurgaSaptashati from '../models/DurgaSaptashati.js';
import DurgaSaptashatiVerse from '../models/DurgaSaptashatiVerse.js';
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

// ─── Chapter Routes ───────────────────────────────────────────────────────────

// GET all chapters
router.get('/', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    let chapters = await DurgaSaptashati.find({ clientId }).sort({ chapterNumber: 1 });
    if (req.query.includeInactive !== 'true') chapters = chapters.filter(c => c.status === 'active');
    const data = await Promise.all(chapters.map(withSignedUrl));
    res.json({ success: true, data, total: data.length });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch chapters', error: error.message });
  }
});

// GET single chapter
router.get('/:id', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const chapter = await DurgaSaptashati.findOne({ _id: req.params.id, clientId });
    if (!chapter) return res.status(404).json({ success: false, message: 'Chapter not found' });
    res.json({ success: true, data: await withSignedUrl(chapter) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch chapter', error: error.message });
  }
});

// POST create chapter
router.post('/', authenticate, upload.single('image'), async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    if (!clientId) return res.status(400).json({ success: false, message: 'Client ID could not be resolved. Please re-login.' });

    const { title, chapterNumber, description, verseCount, status } = req.body;

    const existing = await DurgaSaptashati.findOne({ chapterNumber: parseInt(chapterNumber), clientId });
    if (existing) return res.status(400).json({ success: false, message: `Chapter ${chapterNumber} already exists` });

    let imageUrl = null;
    if (req.file) {
      const result = await uploadFile(req.file, 'durga-saptashati');
      imageUrl = result.key || result.url;
    }

    const chapter = await DurgaSaptashati.create({
      title, chapterNumber: parseInt(chapterNumber), description,
      verseCount: parseInt(verseCount), imageUrl, status: status || 'active', clientId
    });

    res.status(201).json({ success: true, message: 'Chapter created successfully', data: await withSignedUrl(chapter) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to create chapter', error: error.message });
  }
});

// PUT update chapter
router.put('/:id', authenticate, upload.single('image'), async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const { title, chapterNumber, description, verseCount, status } = req.body;

    const updateData = { title, chapterNumber: parseInt(chapterNumber), description, verseCount: parseInt(verseCount), status };
    if (req.file) {
      const result = await uploadFile(req.file, 'durga-saptashati');
      updateData.imageUrl = result.key || result.url;
    }

    const chapter = await DurgaSaptashati.findOneAndUpdate({ _id: req.params.id, clientId }, updateData, { new: true });
    if (!chapter) return res.status(404).json({ success: false, message: 'Chapter not found' });

    res.json({ success: true, message: 'Chapter updated successfully', data: await withSignedUrl(chapter) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update chapter', error: error.message });
  }
});

// DELETE chapter
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const chapter = await DurgaSaptashati.findOneAndDelete({ _id: req.params.id, clientId });
    if (!chapter) return res.status(404).json({ success: false, message: 'Chapter not found' });
    res.json({ success: true, message: 'Chapter deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete chapter', error: error.message });
  }
});

// PATCH toggle chapter status
router.patch('/:id/toggle-status', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const chapter = await DurgaSaptashati.findOne({ _id: req.params.id, clientId });
    if (!chapter) return res.status(404).json({ success: false, message: 'Chapter not found' });
    chapter.status = chapter.status === 'active' ? 'inactive' : 'active';
    await chapter.save();
    res.json({ success: true, message: `Chapter ${chapter.status === 'active' ? 'enabled' : 'disabled'}`, data: await withSignedUrl(chapter) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to toggle status', error: error.message });
  }
});

// ─── Verse Routes ─────────────────────────────────────────────────────────────

// GET all verses
router.get('/:chapterId/verses', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const verses = await DurgaSaptashatiVerse.find({ chapterId: req.params.chapterId, clientId }).sort({ verseNumber: 1 });
    const data = await Promise.all(verses.map(withSignedUrl));
    res.json({ success: true, data, total: data.length });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch verses', error: error.message });
  }
});

// POST create verse
router.post('/:chapterId/verses', authenticate, uploadAudio.single('audio'), async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const { verseNumber, sanskrit, transliteration, hindi, english, explanation, status } = req.body;

    const existing = await DurgaSaptashatiVerse.findOne({ chapterId: req.params.chapterId, verseNumber: parseInt(verseNumber), clientId });
    if (existing) return res.status(400).json({ success: false, message: `Verse ${verseNumber} already exists in this chapter` });

    let audioUrl = null;
    if (req.file) {
      const result = await uploadFile(req.file, 'durga-saptashati/audio');
      audioUrl = result.key || result.url;
    }

    const verse = await DurgaSaptashatiVerse.create({
      chapterId: req.params.chapterId, verseNumber: parseInt(verseNumber),
      sanskrit, transliteration: transliteration || '', hindi: hindi || '',
      english: english || '', explanation: explanation || '',
      audioUrl, status: status || 'active', clientId
    });

    res.status(201).json({ success: true, message: 'Verse created successfully', data: await withSignedUrl(verse) });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Verse number already exists in this chapter' });
    res.status(500).json({ success: false, message: 'Failed to create verse', error: error.message });
  }
});

// PUT update verse
router.put('/:chapterId/verses/:id', authenticate, uploadAudio.single('audio'), async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const { verseNumber, sanskrit, transliteration, hindi, english, explanation, status } = req.body;

    const updateData = {
      verseNumber: parseInt(verseNumber), sanskrit,
      transliteration: transliteration || '', hindi: hindi || '',
      english: english || '', explanation: explanation || '', status
    };

    if (req.file) {
      const result = await uploadFile(req.file, 'durga-saptashati/audio');
      updateData.audioUrl = result.key || result.url;
    }

    const verse = await DurgaSaptashatiVerse.findOneAndUpdate(
      { _id: req.params.id, chapterId: req.params.chapterId, clientId },
      updateData, { new: true, runValidators: true }
    );
    if (!verse) return res.status(404).json({ success: false, message: 'Verse not found' });

    res.json({ success: true, message: 'Verse updated successfully', data: await withSignedUrl(verse) });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: 'Verse number already exists in this chapter' });
    res.status(500).json({ success: false, message: 'Failed to update verse', error: error.message });
  }
});

// DELETE verse
router.delete('/:chapterId/verses/:id', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const verse = await DurgaSaptashatiVerse.findOneAndDelete({ _id: req.params.id, chapterId: req.params.chapterId, clientId });
    if (!verse) return res.status(404).json({ success: false, message: 'Verse not found' });
    res.json({ success: true, message: 'Verse deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete verse', error: error.message });
  }
});

// PATCH toggle verse status
router.patch('/:chapterId/verses/:id/toggle-status', authenticate, async (req, res) => {
  try {
    const clientId = await getClientId(req.user);
    const verse = await DurgaSaptashatiVerse.findOne({ _id: req.params.id, chapterId: req.params.chapterId, clientId });
    if (!verse) return res.status(404).json({ success: false, message: 'Verse not found' });
    verse.status = verse.status === 'active' ? 'inactive' : 'active';
    await verse.save();
    res.json({ success: true, message: `Verse ${verse.status === 'active' ? 'enabled' : 'disabled'}`, data: await withSignedUrl(verse) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to toggle verse status', error: error.message });
  }
});

export default router;
