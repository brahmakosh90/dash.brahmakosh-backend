import express from 'express';
import mongoose from 'mongoose';
import RewardRedemption from '../models/RewardRedemption.js';
import SpiritualReward from '../models/SpiritualReward.js';
import User from '../models/User.js';
import { authenticateToken } from '../middleware/auth.js';
import { getPresignedUrl } from '../utils/storage.js';

const router = express.Router();

// Helper function to get clientId
const getClientId = (req) => {
  if (req.user.role === 'client' && req.user.clientId) {
    return req.user.clientId;
  }
  if (req.user.role === 'user') {
    if (req.user.clientId && req.user.clientId.clientId) {
      return req.user.clientId.clientId;
    }
    if (req.user.tokenClientId) {
      return req.user.tokenClientId;
    }
  }
  throw new Error('Unable to determine clientId');
};


class RedeemError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isDuplicateKey = (err) => err?.code === 11000;
const isTxnUnsupported = (err) =>
  err?.code === 20 || /Transaction numbers are only allowed|replica set|does not support transactions/i.test(err?.message || '');

// Atomic conditional deduction: matches only when balance is sufficient, so concurrent requests can never overdraw.
const deductKarma = (userId, cost, session) =>
  User.findOneAndUpdate(
    { _id: userId, karmaPoints: { $gte: cost } },
    { $inc: { karmaPoints: -cost } },
    { new: true, projection: { karmaPoints: 1 }, session }
  );

const insufficient = async (userId, cost) => {
  const u = await User.findById(userId).select('karmaPoints').lean();
  if (!u) return new RedeemError(404, 'User not found');
  return new RedeemError(400, `Insufficient karma points. Required: ${cost}, Available: ${u.karmaPoints}`);
};

/**
 * Deduct karma and create the redemption record as one unit.
 * Preferred path: a MongoDB transaction (replica set / Atlas).
 * Fallback (standalone mongod): create the record first (unique index blocks duplicates),
 * then deduct atomically; on failure the record is removed / karma restored.
 */
async function redeemAtomically({ userId, rewardId, clientId, cost }) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const updated = await deductKarma(userId, cost, session);
      if (!updated) throw await insufficient(userId, cost);
      const [redemption] = await RewardRedemption.create(
        [{ userId, rewardId, karmaPointsSpent: cost, clientId, status: 'completed' }],
        { session }
      );
      result = { redemption, remainingKarmaPoints: updated.karmaPoints };
    });
    return result;
  } catch (err) {
    if (isDuplicateKey(err)) throw new RedeemError(400, 'You have already redeemed this reward');
    if (!isTxnUnsupported(err)) throw err;
  } finally {
    await session.endSession();
  }

  // ---- Fallback without transactions ----
  let redemption;
  try {
    redemption = await RewardRedemption.create({ userId, rewardId, karmaPointsSpent: cost, clientId, status: 'completed' });
  } catch (err) {
    if (isDuplicateKey(err)) throw new RedeemError(400, 'You have already redeemed this reward');
    throw err;
  }
  let updated;
  try {
    updated = await deductKarma(userId, cost);
  } catch (err) {
    await RewardRedemption.deleteOne({ _id: redemption._id });
    throw err;
  }
  if (!updated) {
    await RewardRedemption.deleteOne({ _id: redemption._id });
    throw await insufficient(userId, cost);
  }
  return { redemption, remainingKarmaPoints: updated.karmaPoints };
}

// Redeem reward
router.post('/redeem', authenticateToken, async (req, res) => {
  try {
    const { rewardId } = req.body;
    const userId = req.user._id;
    const clientId = getClientId(req);

    if (!rewardId) {
      return res.status(400).json({
        success: false,
        message: 'Reward ID is required'
      });
    }

    // Non-authoritative friendly pre-checks; the atomic section below is what guarantees correctness.
    const existingRedemption = await RewardRedemption.findOne({ userId, rewardId, clientId }).select('_id').lean();
    if (existingRedemption) {
      return res.status(400).json({ success: false, message: 'You have already redeemed this reward' });
    }

    const reward = await SpiritualReward.findOne({ _id: rewardId, clientId, isActive: true });
    if (!reward) {
      return res.status(404).json({ success: false, message: 'Reward not found or inactive' });
    }

    let outcome;
    try {
      outcome = await redeemAtomically({ userId, rewardId, clientId, cost: reward.karmaPointsRequired });
    } catch (err) {
      if (err instanceof RedeemError) {
        return res.status(err.status).json({ success: false, message: err.message });
      }
      throw err;
    }
    const { redemption, remainingKarmaPoints } = outcome;
    const user = { karmaPoints: remainingKarmaPoints };

    res.status(200).json({
      success: true,
      message: 'Reward redeemed successfully',
      data: {
        redemption,
        remainingKarmaPoints: user.karmaPoints,
        reward: {
          title: reward.title,
          greetings: reward.greetings
        }
      }
    });
  } catch (error) {
    console.error('Redeem reward error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to redeem reward',
      error: error.message
    });
  }
});

// Get redemption history
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user._id;
    const clientId = getClientId(req);

    const redemptions = await RewardRedemption.find({ userId, clientId })
      .populate('rewardId', 'title description category subcategory photoKey bannerKey')
      .sort({ redeemedAt: -1 });

    // Add presigned URLs
    const redemptionsWithUrls = await Promise.all(
      redemptions.map(async (redemption) => {
        const redemptionObj = redemption.toObject();
        
        if (redemptionObj.rewardId?.photoKey) {
          try {
            redemptionObj.rewardId.image = await getPresignedUrl(redemptionObj.rewardId.photoKey);
          } catch (error) {
            console.error('Failed to generate photo presigned URL:', error);
          }
        }
        
        if (redemptionObj.rewardId?.bannerKey) {
          try {
            redemptionObj.rewardId.banner = await getPresignedUrl(redemptionObj.rewardId.bannerKey);
          } catch (error) {
            console.error('Failed to generate banner presigned URL:', error);
          }
        }
        
        // Keep keys for reference
        
        return redemptionObj;
      })
    );

    res.status(200).json({
      success: true,
      message: 'Redemption history fetched successfully',
      data: redemptionsWithUrls
    });
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch redemption history',
      error: error.message
    });
  }
});

export default router;
