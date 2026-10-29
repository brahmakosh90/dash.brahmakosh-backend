import mongoose from 'mongoose';

/**
 * ServiceCreditLedger
 * Unified credit ledger for chat / voice / video sessions.
 * Allows multiple entries per conversation by serviceType.
 */
const serviceCreditLedgerSchema = new mongoose.Schema(
  {
    conversationId: { type: String, required: true },
    serviceType: { type: String, enum: ['chat', 'voice', 'video'], required: true },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Partner', required: true },

    billableMinutes: { type: Number, required: true, min: 0 },
    userDebited: { type: Number, required: true, min: 0 },
    partnerCredited: { type: Number, required: true, min: 0 },

    userPreviousBalance: { type: Number, required: true, min: 0 },
    userNewBalance: { type: Number, required: true, min: 0 },

    partnerPreviousBalance: { type: Number, required: true, min: 0 },
    partnerNewBalance: { type: Number, required: true, min: 0 },

    // Pricing snapshot
    userRatePerMinute: { type: Number, default: 4 },
    partnerRatePerMinute: { type: Number, default: 3 },

    // Timing
    startTime: { type: Date, default: null },
    endTime: { type: Date, default: null }
  },
  { timestamps: true }
);

serviceCreditLedgerSchema.index({ conversationId: 1, serviceType: 1 }, { unique: true });
serviceCreditLedgerSchema.index({ userId: 1, createdAt: -1 });
serviceCreditLedgerSchema.index({ partnerId: 1, createdAt: -1 });

export default mongoose.model('ServiceCreditLedger', serviceCreditLedgerSchema);

