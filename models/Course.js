import mongoose from 'mongoose';

// Reading content is stored as short sections in both languages so the app can switch language
// without re-fetching, and so lessons stay easy to read on a phone.
export const MAX_SECTION_BODY = 700;   // characters; longer text must be split into more sections
export const MAX_SECTION_HEADING = 100;

const localizedText = (max) => ({
  en: { type: String, trim: true, default: '', maxlength: max },
  hi: { type: String, trim: true, default: '', maxlength: max }
});

const sectionSchema = new mongoose.Schema({
  heading: localizedText(MAX_SECTION_HEADING),
  body: localizedText(MAX_SECTION_BODY)
}, { _id: false });

const lessonSchema = new mongoose.Schema({
  title: localizedText(150),
  sections: { type: [sectionSchema], default: [] },
  audioUrl: { type: String, trim: true },
  audioKey: { type: String, trim: true },   // signed at read time
  durationMinutes: { type: Number, min: 0, default: 0 },
  order: { type: Number, default: 0 }
});

const courseSchema = new mongoose.Schema({
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
  title: localizedText(150),
  description: localizedText(600),
  category: { type: String, trim: true, default: '' },
  imageUrl: { type: String, trim: true },
  imageKey: { type: String, trim: true },
  lessons: { type: [lessonSchema], default: [] },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

courseSchema.index({ clientId: 1, isActive: 1, order: 1 });

// A course needs a title in at least one language
courseSchema.pre('validate', function (next) {
  if (!this.title?.en && !this.title?.hi) this.invalidate('title', 'Course title is required (English or Hindi)');
  next();
});

export default mongoose.models.Course || mongoose.model('Course', courseSchema);
