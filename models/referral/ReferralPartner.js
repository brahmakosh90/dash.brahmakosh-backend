import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const payoutSchema = new mongoose.Schema({
  method: { type: String, default: 'Bank transfer (manual)' },
  holder: String, bank: String, country: String, code: String, last4: String,
  accountEnc: { type: String, select: false }, // AES-256-GCM, never returned by the API
  status: { type: String, enum: ['unset', 'pending_verification', 'verified'], default: 'unset' },
  updatedAt: Date,
}, { _id: false });

const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  org: { type: String, trim: true, default: '' },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 8, select: false },
  phone: { type: String, default: '' },
  country: { type: String, default: '' },
  state: { type: String, default: '', maxlength: 80 },
  city: { type: String, default: '', maxlength: 80 },
  audience: { type: String, default: '' },
  bio: { type: String, default: '', maxlength: 600 },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'suspended'], default: 'pending', index: true },
  tier: { type: String, default: '—' },
  reviewNote: { type: String, default: '' }, // reason given by staff when rejecting or suspending
  code: { type: String, unique: true, sparse: true, uppercase: true },
  joinedAt: Date,
  payout: { type: payoutSchema, default: () => ({}) },
}, { timestamps: true });

schema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});
schema.methods.comparePassword = function comparePassword(p) { return bcrypt.compare(p, this.password); };

export default mongoose.models.ReferralPartner || mongoose.model('ReferralPartner', schema);
