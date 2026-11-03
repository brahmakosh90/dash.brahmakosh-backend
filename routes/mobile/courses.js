import express from 'express';
import mongoose from 'mongoose';
import Course from '../../models/Course.js';
import CourseProgress from '../../models/CourseProgress.js';
import Client from '../../models/Client.js';
import { authenticate } from '../../middleware/auth.js';
import { withSignedMedia } from '../../utils/mediaUrls.js';

import { cacheGet } from '../../utils/responseCache.js';

const router = express.Router();

/**
 * MOBILE COURSES (reading + audio) - app users only
 *   GET  /api/mobile/courses[?lang=hi|en]
 *   GET  /api/mobile/courses/:id[?lang=hi|en]            lessons, short sections, signed audio, prev/next, resume point
 *   PUT  /api/mobile/courses/:id/progress                { lessonId, sectionIndex?, completed?, audioPositionSec? }
 * Language: ?lang, else the user's saved preferredLanguage, else Hindi. Missing text falls back to the other language.
 */

const WORDS_PER_MINUTE = 150; // slow, comfortable reading speed for devotional text
const MAX_AUDIO_POSITION_SEC = 24 * 60 * 60;

const userOnly = (req, res, next) => {
  if (req.user?.role !== 'user') {
    return res.status(403).json({ success: false, message: 'Access denied. User access required.', error: 'INVALID_ROLE' });
  }
  next();
};

const pickLang = (req) => {
  const q = String(req.query.lang ?? '').toLowerCase();
  if (q.startsWith('en')) return 'en';
  if (q.startsWith('hi')) return 'hi';
  return req.user?.preferredLanguage === 'en' ? 'en' : 'hi';
};

const loc = (field, lang) => (field?.[lang] || field?.[lang === 'en' ? 'hi' : 'en'] || '');

const resolveUserClientObjectId = async (req) => {
  const raw = req.decodedClientId || req.user.clientId?._id || req.user.clientId || req.user.tokenClientId || req.user.clientId?.clientId;
  if (!raw) return null;
  if (mongoose.Types.ObjectId.isValid(raw)) return raw;
  const client = await Client.findOne({ clientId: raw }).select('_id').lean();
  return client?._id || null;
};

const sortedLessons = (course) => [...(course.lessons || [])].sort((a, b) => (a.order || 0) - (b.order || 0));

const readingMinutes = (lesson, lang) => {
  const words = (lesson.sections || []).reduce((n, s) => n + loc(s.body, lang).split(/\s+/).filter(Boolean).length, 0);
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
};

router.use(authenticate, userOnly);

router.get('/', cacheGet({ ttlSeconds: 300, tag: 'courses', perUser: true }), async (req, res) => {
  try {
    const lang = pickLang(req);
    const clientId = await resolveUserClientObjectId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'Client not found for this user' });

    const courses = await Course.find({ clientId, isActive: true }).sort({ order: 1, createdAt: -1 }).lean();
    const progress = await CourseProgress.find({ userId: req.user._id, courseId: { $in: courses.map((c) => c._id) } }).lean();
    const byCourse = new Map(progress.map((p) => [String(p.courseId), p]));

    const data = await Promise.all(courses.map(async (c) => {
      const withImage = await withSignedMedia(c, ['image']);
      const p = byCourse.get(String(c._id));
      return {
        _id: c._id,
        title: loc(c.title, lang),
        description: loc(c.description, lang),
        category: c.category || '',
        imageUrl: withImage.imageUrl || null,
        lessonCount: (c.lessons || []).length,
        percentComplete: p?.percentComplete || 0,
        lastLessonId: p?.lastLessonId || null
      };
    }));

    res.json({ success: true, data, count: data.length, language: lang });
  } catch (error) {
    console.error('Error listing courses:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch courses' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid course id' });
    }
    const lang = pickLang(req);
    const clientId = await resolveUserClientObjectId(req);
    const course = await Course.findOne({ _id: req.params.id, clientId, isActive: true }).lean();
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

    const progress = await CourseProgress.findOne({ userId: req.user._id, courseId: course._id }).lean();
    const done = new Set((progress?.completedLessonIds || []).map(String));
    const positions = progress?.audioPositions || {};
    const lessons = sortedLessons(course);

    const lessonData = await Promise.all(lessons.map(async (l, i) => {
      const signed = await withSignedMedia(l, ['audio']);
      return {
        _id: l._id,
        title: loc(l.title, lang),
        sections: (l.sections || []).map((s) => ({ heading: loc(s.heading, lang), body: loc(s.body, lang) })),
        audioUrl: signed.audioUrl || null,
        audioResumeSec: Number(positions[String(l._id)] ?? 0),
        readingMinutes: readingMinutes(l, lang),
        durationMinutes: l.durationMinutes || 0,
        completed: done.has(String(l._id)),
        prevLessonId: lessons[i - 1]?._id || null,
        nextLessonId: lessons[i + 1]?._id || null
      };
    }));

    const image = await withSignedMedia(course, ['image']);
    res.json({
      success: true,
      language: lang,
      data: {
        _id: course._id,
        title: loc(course.title, lang),
        description: loc(course.description, lang),
        category: course.category || '',
        imageUrl: image.imageUrl || null,
        lessons: lessonData,
        progress: {
          percentComplete: progress?.percentComplete || 0,
          resume: progress?.lastLessonId
            ? { lessonId: progress.lastLessonId, sectionIndex: progress.lastSectionIndex || 0 }
            : (lessons[0] ? { lessonId: lessons[0]._id, sectionIndex: 0 } : null)
        }
      }
    });
  } catch (error) {
    console.error('Error fetching course:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch course' });
  }
});

router.put('/:id/progress', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid course id' });
    }
    const { lessonId, sectionIndex, completed, audioPositionSec } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(lessonId)) {
      return res.status(400).json({ success: false, message: 'lessonId is required' });
    }

    const clientId = await resolveUserClientObjectId(req);
    const course = await Course.findOne({ _id: req.params.id, clientId, isActive: true }).select('lessons._id lessons.sections').lean();
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

    const lesson = (course.lessons || []).find((l) => String(l._id) === String(lessonId));
    if (!lesson) return res.status(404).json({ success: false, message: 'Lesson not found in this course' });

    const set = { lastLessonId: lesson._id };
    if (sectionIndex !== undefined) {
      const idx = Number(sectionIndex);
      if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ success: false, message: 'sectionIndex must be a non-negative integer' });
      set.lastSectionIndex = Math.min(idx, Math.max(0, (lesson.sections || []).length - 1));
    }
    if (audioPositionSec !== undefined) {
      const sec = Number(audioPositionSec);
      if (!Number.isFinite(sec) || sec < 0 || sec > MAX_AUDIO_POSITION_SEC) return res.status(400).json({ success: false, message: 'audioPositionSec is out of range' });
      set[`audioPositions.${lesson._id}`] = Math.floor(sec);
    }

    const update = { $set: set };
    if (completed === true) update.$addToSet = { completedLessonIds: lesson._id };
    else if (completed === false) update.$pull = { completedLessonIds: lesson._id };

    const doc = await CourseProgress.findOneAndUpdate(
      { userId: req.user._id, courseId: course._id },
      update,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const validIds = new Set(course.lessons.map((l) => String(l._id)));
    const completedCount = (doc.completedLessonIds || []).filter((id) => validIds.has(String(id))).length;
    const percent = validIds.size ? Math.round((completedCount / validIds.size) * 100) : 0;
    if (percent !== doc.percentComplete || (percent === 100) !== !!doc.completedAt) {
      doc.percentComplete = percent;
      doc.completedAt = percent === 100 ? (doc.completedAt || new Date()) : null;
      await doc.save();
    }

    res.json({
      success: true,
      data: {
        percentComplete: doc.percentComplete,
        lastLessonId: doc.lastLessonId,
        lastSectionIndex: doc.lastSectionIndex,
        completedLessonIds: doc.completedLessonIds
      }
    });
  } catch (error) {
    console.error('Error saving course progress:', error);
    res.status(500).json({ success: false, message: 'Failed to save progress' });
  }
});

export default router;
