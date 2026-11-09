import mongoose from 'mongoose';

const shivPuranSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  partNumber: {
    type: Number,
    required: true,
    min: 1
  },
  description: {
    type: String,
    required: true,
    trim: true
  },
  verseCount: {
    type: Number,
    required: true,
    min: 1
  },
  // Real number of verse documents; maintained by hooks on the verse model. verseCount is the *declared* count.
  actualVerseCount: { type: Number, default: 0, min: 0 },
  imageUrl: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  },
  clientId: {
    type: String,
    required: true
  }
}, { timestamps: true });

shivPuranSchema.index({ partNumber: 1, clientId: 1 }, { unique: true });

const ShivPuran = mongoose.model('ShivPuran', shivPuranSchema);

export default ShivPuran;
