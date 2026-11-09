import mongoose from 'mongoose';

const rewardRedemptionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  rewardId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SpiritualReward',
    required: true
  },
  karmaPointsSpent: {
    type: Number,
    required: true,
    min: 0
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'cancelled'],
    default: 'completed'
  },
  clientId: {
    type: String,
    required: true
  },
  redeemedAt: {
    type: Date,
    default: Date.now
  }
});

rewardRedemptionSchema.index({ userId: 1, redeemedAt: -1 });
rewardRedemptionSchema.index({ clientId: 1 });
// Idempotency / double-redemption guard: one redemption per user+reward+client, enforced by the database.
// NOTE: if duplicates already exist this index will fail to build; run scripts/dedupeRewardRedemptions.js first.
rewardRedemptionSchema.index({ userId: 1, rewardId: 1, clientId: 1 }, { unique: true });

const RewardRedemption = mongoose.model('RewardRedemption', rewardRedemptionSchema);

export default RewardRedemption;
