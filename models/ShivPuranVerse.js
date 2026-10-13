import mongoose from 'mongoose';

const shivPuranVerseSchema = new mongoose.Schema({
  partId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ShivPuran',
    required: true
  },
  verseNumber: {
    type: Number,
    required: true,
    min: 1
  },
  sanskrit: {
    type: String,
    required: true,
    trim: true
  },
  transliteration: {
    type: String,
    trim: true,
    default: ''
  },
  hindi: {
    type: String,
    trim: true,
    default: ''
  },
  english: {
    type: String,
    trim: true,
    default: ''
  },
  explanation: {
    type: String,
    trim: true,
    default: ''
  },
  audioUrl: {
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

shivPuranVerseSchema.index({ partId: 1, verseNumber: 1, clientId: 1 }, { unique: true });

export default mongoose.model('ShivPuranVerse', shivPuranVerseSchema);
