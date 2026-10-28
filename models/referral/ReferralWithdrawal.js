import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  code: { type: String, unique: true }, // human id, e.g. WD-1011
  partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralPartner', required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  status: { type: String, enum: ['pending', 'approved', 'processing', 'paid', 'rejected'], default: 'pending', index: true },
  method: { type: String, default: 'Bank transfer' },
  reference: { type: String, default: '' },
  reason: { type: String, default: '' },
  approvedBy: { type: String, default: '' },
  history: [{ _id: false, at: String, label: String }],
  requestedAt: { type: String, required: true },
}, { timestamps: true });

// A partner may only have one request waiting for approval at a time; the database enforces it atomically.
schema.index({ partnerId: 1 }, { unique: true, partialFilterExpression: { status: 'pending' }, name: 'one_pending_per_partner' });

export default mongoose.models.ReferralWithdrawal || mongoose.model('ReferralWithdrawal', schema);
