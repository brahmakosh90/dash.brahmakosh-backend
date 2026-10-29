import mongoose from 'mongoose';

/**
 * ChatCreditLedger
 * Records credit deduction for user + credit earning for partner per conversation end.
 * This keeps chat billing separate from top-up credits table (`Credit`).
 */
const chatCreditLedgerSchema = new mongoose.Schema(
  {
    conversationId: { type: String, required: true, unique: true },
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
    partnerRatePerMinute: { type: Number, default: 3 }
  },
  { timestamps: true }
);

chatCreditLedgerSchema.index({ userId: 1, createdAt: -1 });
chatCreditLedgerSchema.index({ partnerId: 1, createdAt: -1 });

export default mongoose.model('ChatCreditLedger', chatCreditLedgerSchema);

