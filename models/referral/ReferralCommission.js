import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralPartner', required: true },
  recordId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralRecord', required: true, unique: true }, // one commission per referral
  anon: String,
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralCampaign' },
  date: { type: String, required: true },
  amount: { type: Number, default: 1 },
  status: { type: String, enum: ['pending', 'approved', 'paid', 'rejected', 'reversed'], default: 'pending' },
  reason: { type: String, default: '' },
  payoutId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralWithdrawal', default: null },
}, { timestamps: true });
schema.index({ partnerId: 1, status: 1, date: 1 });
schema.index({ status: 1, date: 1 });

export default mongoose.models.ReferralCommission || mongoose.model('ReferralCommission', schema);
