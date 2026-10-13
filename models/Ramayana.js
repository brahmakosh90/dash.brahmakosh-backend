import mongoose from 'mongoose';

const ramayanaSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  kandaNumber: { type: Number, required: true, min: 1 },
  description: { type: String, required: true, trim: true },
  verseCount: { type: Number, required: true, min: 1 },
  imageUrl: { type: String, default: null },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  clientId: { type: String, required: true }
}, { timestamps: true });

ramayanaSchema.index({ kandaNumber: 1, clientId: 1 }, { unique: true });

export default mongoose.model('Ramayana', ramayanaSchema);
