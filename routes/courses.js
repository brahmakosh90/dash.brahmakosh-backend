import express from 'express';
import mongoose from 'mongoose';
import Course from '../models/Course.js';
import { authenticate } from '../middleware/auth.js';
import { generateUploadUrl, extractS3KeyFromUrl } from '../utils/storage.js';
import { withSignedMedia } from '../utils/mediaUrls.js';

const router = express.Router();

/**
 * COURSE MANAGEMENT (client admin)
 *   GET    /api/courses                 list (all, incl. inactive)
 *   GET    /api/courses/:id
 *   POST   /api/courses                 create
 *   PUT    /api/courses/:id             update (lessons array is replaced when sent)
 *   DELETE /api/courses/:id             soft delete (keeps users' saved progress)
 *   POST   /api/courses/upload-url      { fileName, contentType, fileType: 'audio' | 'image' }
 * Reading text is limited per section (see models/Course.js) so lessons stay short and readable.
 */

const clientOnly = (req, res, next) => {
  if (req.user?.role !== 'client') {
    return res.status(403).json({ success: false, message: 'Access denied. Client access required.', error: 'INVALID_ROLE' });
  }
  next();
};

router.use(authenticate, clientOnly);

const text = (v) => ({ en: String(v?.en ?? '').trim(), hi: String(v?.hi ?? '').trim() });

const cleanLessons = (lessons) =>
  (Array.isArray(lessons) ? lessons : []).map((l, i) => {
    const audioKey = l.audioKey || (l.audioUrl ? extractS3KeyFromUrl(l.audioUrl) : undefined);
    return {
      ...(mongoose.Types.ObjectId.isValid(l._id) && { _id: l._id }),   // keep ids so users' progress stays valid
      title: text(l.title),
      sections: (Array.isArray(l.sections) ? l.sections : [])
        .map((s) => ({ heading: text(s.heading), body: text(s.body) }))
        .filter((s) => s.heading.en || s.heading.hi || s.body.en || s.body.hi),
      audioUrl: l.audioUrl || undefined,
      audioKey,
      durationMinutes: Number(l.durationMinutes) || 0,
      order: Number.isFinite(Number(l.order)) ? Number(l.order) : i
    };
  });

const validationMessage = (error) => (error.name === 'ValidationError' ? Object.values(error.errors).map((e) => e.message).join('; ') : null);

router.post('/upload-url', async (req, res) => {
  try {
    const { fileName, contentType, fileType } = req.body || {};
    if (!fileName || !contentType || !['audio', 'image'].includes(fileType)) {
      return res.status(400).json({ success: false, message: 'fileName, contentType and fileType (audio|image) are required' });
    }
    const { uploadUrl, fileUrl, key } = await generateUploadUrl(fileName, contentType, `courses/${fileType}`);
    res.json({ success: true, data: { uploadUrl, fileUrl, key } });
  } catch (error) {
    console.error('Error generating course upload URL:', error);
    res.status(500).json({ success: false, message: 'Failed to generate upload URL' });
  }
});

router.get('/', async (req, res) => {
  try {
    const courses = await Course.find({ clientId: req.user._id }).sort({ order: 1, createdAt: -1 }).lean();
    res.json({ success: true, data: await Promise.all(courses.map((c) => withSignedMedia(c, ['image']))), count: courses.length });
  } catch (error) {
    console.error('Error listing courses:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch courses' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid course id' });
    const course = await Course.findOne({ _id: req.params.id, clientId: req.user._id }).lean();
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });
    course.lessons = await Promise.all((course.lessons || []).map((l) => withSignedMedia(l, ['audio'])));
    res.json({ success: true, data: await withSignedMedia(course, ['image']) });
  } catch (error) {
    console.error('Error fetching course:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch course' });
  }
});

router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const course = await Course.create({
      clientId: req.user._id,
      title: text(b.title),
      description: text(b.description),
      category: String(b.category ?? '').trim(),
      imageUrl: b.imageUrl || undefined,
      imageKey: b.imageKey || (b.imageUrl ? extractS3KeyFromUrl(b.imageUrl) : undefined),
      lessons: cleanLessons(b.lessons),
      order: Number(b.order) || 0,
      isActive: b.isActive !== false
    });
    res.status(201).json({ success: true, message: 'Course created successfully', data: course });
  } catch (error) {
    const msg = validationMessage(error);
    if (msg) return res.status(400).json({ success: false, message: msg });
    console.error('Error creating course:', error);
    res.status(500).json({ success: false, message: 'Failed to create course' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid course id' });
    const course = await Course.findOne({ _id: req.params.id, clientId: req.user._id });
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

    const b = req.body || {};
    if (b.title !== undefined) course.title = text(b.title);
    if (b.description !== undefined) course.description = text(b.description);
    if (b.category !== undefined) course.category = String(b.category ?? '').trim();
    if (b.order !== undefined) course.order = Number(b.order) || 0;
    if (b.isActive !== undefined) course.isActive = !!b.isActive;
    if (b.imageUrl !== undefined || b.imageKey !== undefined) {
      course.imageUrl = b.imageUrl || undefined;
      course.imageKey = b.imageKey || (b.imageUrl ? extractS3KeyFromUrl(b.imageUrl) : undefined);
    }
    if (b.lessons !== undefined) course.lessons = cleanLessons(b.lessons);

    await course.save();
    res.json({ success: true, message: 'Course updated successfully', data: course });
  } catch (error) {
    const msg = validationMessage(error);
    if (msg) return res.status(400).json({ success: false, message: msg });
    console.error('Error updating course:', error);
    res.status(500).json({ success: false, message: 'Failed to update course' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid course id' });
    const course = await Course.findOneAndUpdate({ _id: req.params.id, clientId: req.user._id }, { isActive: false }, { new: true });
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });
    res.json({ success: true, message: 'Course deactivated' });
  } catch (error) {
    console.error('Error deleting course:', error);
    res.status(500).json({ success: false, message: 'Failed to delete course' });
  }
});

export default router;
