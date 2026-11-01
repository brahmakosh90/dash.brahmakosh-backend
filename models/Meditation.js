import mongoose from 'mongoose';

const meditationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true,
    trim: true
  },
  link: {
    type: String,
    trim: true
  },
  videoUrl: {
    type: String,
    trim: true
  },
  videoKey: {
    type: String,
    trim: true
    // S3 object key for generating presigned URLs
  },
  audioUrl: {
    type: String,
    trim: true
  },
  audioKey: {
    type: String,
    trim: true
    // Storage key of the meditation music/guidance track (signed at read time)
  },
  // Group shown in the app (e.g. "Guided Meditation", "Sleep"). Blank is served as "General".
  category: {
    type: String,
    trim: true,
    default: ''
  },
  imageUrl: {
    type: String,
    trim: true
  },
  imageKey: {
    type: String,
    trim: true
    // S3 object key for generating presigned URLs
  },
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

export default mongoose.model('Meditation', meditationSchema);