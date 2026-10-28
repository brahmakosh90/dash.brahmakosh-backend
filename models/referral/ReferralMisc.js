import mongoose from 'mongoose';

export const FraudFlag = mongoose.models.ReferralFraudFlag || mongoose.model('ReferralFraudFlag', new mongoose.Schema({
  code: { type: String, unique: true },
  partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralPartner', required: true },
  type: String,
  severity: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
  detail: String,
  related: { type: Number, default: 0 },
  detectedAt: String,
  status: { type: String, enum: ['open', 'under_review', 'confirmed', 'dismissed'], default: 'open', index: true },
  note: { type: String, default: '' },
}, { timestamps: true }));

export const Ticket = mongoose.models.ReferralTicket || mongoose.model('ReferralTicket', new mongoose.Schema({
  code: { type: String, unique: true },
  partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralPartner', required: true, index: true },
  subject: String, category: String, message: String,
  reply: { type: String, default: '' },
  status: { type: String, enum: ['open', 'resolved'], default: 'open' },
}, { timestamps: true }));

// Append-only: there is intentionally no update or delete route for audit entries.
export const Audit = mongoose.models.ReferralAudit || mongoose.model('ReferralAudit', new mongoose.Schema({
  ts: { type: Date, default: Date.now, index: true },
  actor: String, role: String, action: String, entity: String, detail: String, ip: String,
}));

export const RoleConfig = mongoose.models.ReferralRoleConfig || mongoose.model('ReferralRoleConfig', new mongoose.Schema({
  role: { type: String, unique: true },
  permissions: [String],
}));

const Counter = mongoose.models.ReferralCounter || mongoose.model('ReferralCounter', new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 },
}));

/** Atomic human-readable sequence, e.g. nextCode('WD', 1000) -> WD-1001. */
export const nextCode = async (prefix, start = 1000) => {
  const c = await Counter.findOneAndUpdate({ _id: prefix }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return `${prefix}-${start + c.seq}`;
};
