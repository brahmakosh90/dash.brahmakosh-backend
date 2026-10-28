import mongoose from 'mongoose';

// Verified click / install / registration counters per partner, campaign and day (fed by the attribution pipeline).
const schema = new mongoose.Schema({
  partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralPartner', required: true },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralCampaign', required: true },
  date: { type: String, required: true },
  clicks: { type: Number, default: 0 },
  installs: { type: Number, default: 0 },
  regs: { type: Number, default: 0 },
});
schema.index({ campaignId: 1, date: 1 }, { unique: true });
schema.index({ partnerId: 1, date: 1 });

export default mongoose.models.ReferralDailyStat || mongoose.model('ReferralDailyStat', schema);
