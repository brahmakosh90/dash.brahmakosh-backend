import mongoose from 'mongoose';

const changeSchema = new mongoose.Schema(
  {
    field: { type: String, required: true },
    oldValue: mongoose.Schema.Types.Mixed,
    newValue: mongoose.Schema.Types.Mixed,
  },
  { _id: false }
);

const auditLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, index: true }, // e.g. 'user.balance_sync'
    actorId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    actorRole: { type: String, required: true },
    targetUserId: { type: mongoose.Schema.Types.ObjectId, index: true },
    targetEmail: String,
    changes: [changeSchema],
    source: String, // e.g. external system the values came from
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ createdAt: -1 });

export default mongoose.model('AuditLog', auditLogSchema);
