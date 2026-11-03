import mongoose from 'mongoose';

const spiritualConfigurationSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    maxlength: 100,
    trim: true
  },
  description: {
    type: String,
    required: true,
    maxlength: 500,
    trim: true
  },
  duration: {
    type: String,
    required: false,
    enum: ['1 minute', '2 minutes', '3 minutes', '4 minutes', '5 minutes', '6 minutes', '7 minutes', '8 minutes', '9 minutes', '10 minutes', '15 minutes', '20 minutes', '30 minutes', ''],
    default: '5 minutes'
  },
  type: {
    type: String,
    required: true,
    enum: ['meditation', 'prayer', 'chanting', 'breathing', 'mindfulness', 'yoga', 'gratitude', 'silence', 'reflection'],
    default: 'meditation'
  },
  // category: main group e.g. "Daily Chanting", "Guided Meditation", "Daily Ritual Prayers"
  category: {
    type: String,
    default: ''
  },
  // subcategory: specific item e.g. "Morning Awakening Mantra", "Stress Relief Meditation"
  subcategory: {
    type: String,
    default: ''
  },
  karmaPoints: {
    type: Number,
    min: 1,
    max: 100,
    default: 10
  },
  // Keep for backward compatibility with existing data
  chantingType: { type: String, default: '' },
  meditationType: { type: String, default: '' },
  prayerType: { type: String, default: '' },
  isActive: {
    type: Boolean,
    default: true
  },
  isDeleted: {
    type: Boolean,
    default: false
  },
  clientId: {
    type: String,
    required: true
  },
  categoryId: {
    type: String,
    default: ''
  },
  audioUrl: {
    type: String,
    default: null
  },
  audioKey: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// Index for better query performance
spiritualConfigurationSchema.index({ type: 1, isActive: 1 });
spiritualConfigurationSchema.index({ clientId: 1 });
spiritualConfigurationSchema.index({ clientId: 1, isDeleted: 1 });
spiritualConfigurationSchema.index({ categoryId: 1 });
spiritualConfigurationSchema.index({ type: 1, category: 1 });

export default mongoose.model('SpiritualConfiguration', spiritualConfigurationSchema);