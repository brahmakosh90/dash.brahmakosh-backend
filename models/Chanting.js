import mongoose from 'mongoose';

const chantingSchema = new mongoose.Schema({
  // Basic Information
  name: {
    type: String,
    required: true,
    trim: true
    // Examples: "Om Namah Shivaya", "Gayatri Mantra", "Hare Krishna"
  },
  
  description: {
    type: String,
    required: true,
    trim: true
    // Meaning, benefits, deity information
  },
  
  // Chanting Configuration
  malaCount: {
    type: Number,
    required: true,
    min: 1,
    max: 108
    // Number of malas (1 mala = 108 chants)
    // Options: 1, 2, 3, 5, 10, 21, 108
  },
  
  totalCount: {
    type: Number
    // Auto-calculated: malaCount × 108
    // Example: 2 malas = 216 chants
  },
  
  // Mantra text per script/language, served by language preference (falls back to Sanskrit)
  mantraText: {
    sanskrit: { type: String, trim: true, default: '' },
    hindi: { type: String, trim: true, default: '' },
    transliteration: { type: String, trim: true, default: '' },
    meaning: {
      en: { type: String, trim: true, default: '' },
      hi: { type: String, trim: true, default: '' }
    }
  },

  // Chanting audio (recitation to follow along)
  audioUrl: { type: String, trim: true },
  audioKey: { type: String, trim: true },

  // Media Files (S3 URLs)
  videoUrl: {
    type: String,
    trim: true
    // S3 URL for chanting video guide
    // Optional field
  },
  videoKey: {
    type: String,
    trim: true
    // S3 object key for generating presigned URLs
  },
  
  imageUrl: {
    type: String,
    trim: true
    // S3 URL for thumbnail/deity image
    // Optional field
  },
  imageKey: {
    type: String,
    trim: true
    // S3 object key for generating presigned URLs
  },
  
  // Additional Information
  link: {
    type: String,
    trim: true
    // External link (YouTube, etc.)
    // Optional field
  },
  
  duration: {
    type: Number
    // Duration in minutes
    // Optional field
  },
  
  // System Fields
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true
    // Reference to the client who created this chanting
  },
  
  isActive: {
    type: Boolean,
    default: true
    // For soft delete / enable-disable functionality
  }
}, {
  timestamps: true
  // Automatically adds createdAt and updatedAt
});

// Pre-save hook: Auto-calculate totalCount before saving
chantingSchema.pre('save', function(next) {
  if (this.malaCount) {
    this.totalCount = this.malaCount * 108;
  }
  next();
});

export default mongoose.model('Chanting', chantingSchema);
