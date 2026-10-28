import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralPartner', required: true, index: true },
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, unique: true, uppercase: true, match: /^[A-Z0-9-]{4,24}$/ },
  general: { type: Boolean, default: false }, // the partner's permanent direct link, not a real campaign
  start: { type: String, required: true }, // YYYY-MM-DD
  end: { type: String, required: true },
  // Stored lifecycle. `active`/`scheduled`/`expired` are re-derived from the dates on read.
  status: { type: String, enum: ['pending_approval', 'active', 'scheduled', 'paused', 'expired', 'revoked'], default: 'pending_approval', index: true },
  approval: { type: String, enum: ['pending', 'approved', 'rejected', 'revoked'], default: 'pending' },
  rate: { type: Number, default: 1, min: 0.01, max: 5 },
  cap: { type: Number, default: 500, min: 0 },
  channelFocus: { type: String, default: '' },
}, { timestamps: true });

export default mongoose.models.ReferralCampaign || mongoose.model('ReferralCampaign', schema);
