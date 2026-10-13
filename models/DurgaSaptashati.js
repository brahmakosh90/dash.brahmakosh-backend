import mongoose from 'mongoose';

const durgaSaptashatiSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  chapterNumber: { type: Number, required: true, min: 1 },
  description: { type: String, required: true, trim: true },
  verseCount: { type: Number, required: true, min: 1 },
  imageUrl: { type: String, default: null },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  clientId: { type: String, required: true }
}, { timestamps: true });

durgaSaptashatiSchema.index({ chapterNumber: 1, clientId: 1 }, { unique: true });

export default mongoose.model('DurgaSaptashati', durgaSaptashatiSchema);
