import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

// Back-office users of the referral programme (finance, fraud, support ...).
// Existing Admin / Super Admin accounts can also sign in; they are read, never modified, by this module.
const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 8, select: false },
  role: { type: String, enum: ['super_admin', 'ops_admin', 'finance', 'fraud_analyst', 'support'], required: true },
  isActive: { type: Boolean, default: true },
  createdBy: { type: String, default: '' },
}, { timestamps: true });

schema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});
schema.methods.comparePassword = function comparePassword(p) { return bcrypt.compare(p, this.password); };

export default mongoose.models.ReferralStaff || mongoose.model('ReferralStaff', schema);
