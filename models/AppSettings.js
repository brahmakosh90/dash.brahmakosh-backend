import mongoose from 'mongoose';

/**
 * AppSettings - single-document store for app-wide settings (e.g. API keys).
 * Used for AI API keys and other configurable keys manageable from admin dashboard.
 */
const appSettingsSchema = new mongoose.Schema({
  geminiApiKey: {
    type: String,
    default: null,
    trim: true
  },
  openaiApiKey: {
    type: String,
    default: null,
    trim: true
  },
  // Storage mode: s3_only | r2_only | both
  storageMode: {
    type: String,
    enum: ['s3_only', 'r2_only', 'both'],
    default: 's3_only'
  },

  // Stripe / credits settings (managed from admin dashboard)
  stripeCreditsPerUnit: {
    // How many credits for 1 currency unit (e.g. 1 INR = 2 credits)
    type: Number,
    default: 2,
    min: 0
  }
}, {
  timestamps: true,
  collection: 'appsettings'
});

// Ensure only one document exists (singleton)
appSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({});
  }
  return settings;
};

export default mongoose.model('AppSettings', appSettingsSchema);
