import mongoose from 'mongoose';

// One document per (user, course): where the reader stopped and what is finished.
const courseProgressSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  lastLessonId: { type: mongoose.Schema.Types.ObjectId, default: null },
  lastSectionIndex: { type: Number, default: 0, min: 0 },
  completedLessonIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  // Audio resume point per lesson: { "<lessonId>": seconds }
  audioPositions: { type: Map, of: Number, default: {} },
  percentComplete: { type: Number, default: 0, min: 0, max: 100 },
  completedAt: { type: Date, default: null }
}, { timestamps: true });

courseProgressSchema.index({ userId: 1, courseId: 1 }, { unique: true });

export default mongoose.models.CourseProgress || mongoose.model('CourseProgress', courseProgressSchema);
