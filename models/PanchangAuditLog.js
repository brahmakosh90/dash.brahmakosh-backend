import mongoose from 'mongoose';

const panchangAuditLogSchema = new mongoose.Schema(
  {
    dateKey: { type: String, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    field: { type: String, required: true },
    apiValue: String,
    calculatedValue: String,
    resolution: { type: String, enum: ['used_calculated', 'kept_api_flagged', 'heuristic_warning'], required: true },
    severity: { type: String, enum: ['CRITICAL', 'WARN'], default: 'WARN' },
    note: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

panchangAuditLogSchema.index({ createdAt: -1 });

export default mongoose.model('PanchangAuditLog', panchangAuditLogSchema);
