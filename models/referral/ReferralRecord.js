import mongoose from 'mongoose';

// One row per referred install/registration. Holds no personal data: only an anonymized id.
const schema = new mongoose.Schema({
  partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralPartner', required: true },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralCampaign', required: true },
  anon: { type: String, required: true },
  deviceHash: { type: String, default: null, select: false }, // sha256 of the app's device id, used only for duplicate detection
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, select: false }, // internal link to the app user
  channel: String, device: String, country: String,
  clickAt: String, installAt: String, regAt: { type: String, default: null },
  status: { type: String, enum: ['installed', 'registered'], default: 'installed' },
  eligibility: { type: String, enum: ['awaiting', 'in_review', 'eligible', 'rejected', 'reversed'], default: 'awaiting' },
  reason: { type: String, default: '' },
  // Spiritual-impact signals, kept separate from cash commission.
  firstActivity: { type: Boolean, default: false },
  activeNow: { type: Boolean, default: false },
  sessions: { type: Number, default: 0 },
  minutes: { type: Number, default: 0 },
});
schema.index({ partnerId: 1, installAt: -1 });
schema.index({ anon: 1 });
schema.index({ userId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } }); // a user can be attributed once
schema.index({ deviceHash: 1 }, { partialFilterExpression: { deviceHash: { $type: 'string' } } });

export default mongoose.models.ReferralRecord || mongoose.model('ReferralRecord', schema);
