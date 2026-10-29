// backend/models/Credit.js
// Tracks credit transactions for users (admin/client can add credits)

import mongoose from 'mongoose';

const creditSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Positive amounts = credits added. (Future: negative for deductions.)
    amount: {
      type: Number,
      required: true,
    },
    previousBalance: {
      type: Number,
      required: true,
    },
    newBalance: {
      type: Number,
      required: true,
    },
    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin', // could be Client or Admin; we also store role
      required: true,
    },
    addedByRole: {
      type: String,
      enum: ['admin', 'super_admin', 'client', 'payment', 'subscription', 'user'],
      required: true,
    },
    description: {
      type: String,
    },
    reportType: {
      type: String,
      default: null,
    },
    idempotencyKey: {
      type: String,
      default: null,
      sparse: true,
      index: true,
    },
    paymentIntentId: {
      type: String,
      default: null,
      sparse: true,
      index: true,
    },
    stripeInvoiceId: {
      type: String,
      default: null,
      sparse: true,
      index: true,
    },
    stripeSubscriptionId: {
      type: String,
      default: null,
      sparse: true,
      index: true,
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SubscriptionPlan',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

creditSchema.index({ userId: 1, createdAt: -1 });

const Credit = mongoose.model('Credit', creditSchema);
export default Credit;

