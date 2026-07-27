/**
 * adminPayments.js
 * Payment management routes for admin/super_admin.
 * Provides: payment list, per-user history, credit adjust (add/deduct),
 * subscription list, subscription cancel, revenue analytics.
 *
 * All routes: /api/admin/payments/*
 */

import express from 'express';
import Stripe from 'stripe';
import mongoose from 'mongoose';
import { authenticate, authorize } from '../middleware/auth.js';
import PaymentLog from '../models/PaymentLog.js';
import Credit from '../models/Credit.js';
import UserSubscription from '../models/UserSubscription.js';
import User from '../models/User.js';
import Client from '../models/Client.js';
import SubscriptionPlan from '../models/SubscriptionPlan.js';
import { grantCredits } from '../services/creditLedger.js';
import { getStripeSecretKey, STRIPE_MODE } from '../services/stripePlanSync.js';

const router = express.Router();
router.use(authenticate);
router.use(authorize('admin', 'super_admin'));

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Return clientIds that belong to this admin (or all for super_admin). */
async function getAdminClientIds(user) {
  const filter =
    user.role === 'super_admin'
      ? {}
      : { $or: [{ adminId: user._id }, { adminId: null }, { adminId: { $exists: false } }] };
  const clients = await Client.find(filter).select('_id').lean();
  return clients.map((c) => c._id);
}

/** Return userIds under the admin's clients. */
async function getAdminUserIds(user) {
  const clientIds = await getAdminClientIds(user);
  const users = await User.find({ clientId: { $in: clientIds } }).select('_id').lean();
  return users.map((u) => u._id);
}

// ─── 1. Payment Logs list ─────────────────────────────────────────────────────
/**
 * GET /api/admin/payments/logs
 * Query: page, limit, userId, event (create_intent|confirm|error), status, from, to
 */
router.get('/logs', async (req, res) => {
  try {
    const { page = 1, limit = 25, userId, event, status, from, to } = req.query;
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(limit) || 25, 1), 100);
    const skip = (pageNum - 1) * pageSize;

    const userIds = await getAdminUserIds(req.user);

    const query = { userId: { $in: userIds } };
    if (userId && mongoose.isValidObjectId(userId)) query.userId = userId;
    if (event) query.event = event;
    if (status) query.status = status;
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) query.createdAt.$lte = new Date(to);
    }

    const [logs, total] = await Promise.all([
      PaymentLog.find(query)
        .populate('userId', 'email profile.name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      PaymentLog.countDocuments(query),
    ]);

    res.json({ success: true, data: { logs, total, page: pageNum, limit: pageSize } });
  } catch (e) {
    console.error('[AdminPayments] logs error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── 2. Credit Transactions list ──────────────────────────────────────────────
/**
 * GET /api/admin/payments/credits
 * Query: page, limit, userId, addedByRole, from, to
 */
router.get('/credits', async (req, res) => {
  try {
    const { page = 1, limit = 25, userId, addedByRole, from, to } = req.query;
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(limit) || 25, 1), 100);
    const skip = (pageNum - 1) * pageSize;

    const userIds = await getAdminUserIds(req.user);

    const query = { userId: { $in: userIds } };
    if (userId && mongoose.isValidObjectId(userId)) query.userId = userId;
    if (addedByRole) query.addedByRole = addedByRole;
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) query.createdAt.$lte = new Date(to);
    }

    const [credits, total] = await Promise.all([
      Credit.find(query)
        .populate('userId', 'email profile.name credits')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      Credit.countDocuments(query),
    ]);

    res.json({ success: true, data: { credits, total, page: pageNum, limit: pageSize } });
  } catch (e) {
    console.error('[AdminPayments] credits error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── 3. Per-user payment history ──────────────────────────────────────────────
/**
 * GET /api/admin/payments/users/:userId/history
 */
router.get('/users/:userId/history', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId))
      return res.status(400).json({ success: false, message: 'Invalid userId' });

    const userIds = await getAdminUserIds(req.user);
    const allowed = userIds.map(String).includes(String(userId));
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied' });

    const user = await User.findById(userId).select('email profile credits').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const [paymentLogs, creditTxns, subscriptions] = await Promise.all([
      PaymentLog.find({ userId }).sort({ createdAt: -1 }).limit(50).lean(),
      Credit.find({ userId }).sort({ createdAt: -1 }).limit(50).lean(),
      UserSubscription.find({ userId })
        .populate('planId', 'name billingType billingInterval creditsPerGrant currency offerPriceMinorUnits')
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    res.json({
      success: true,
      data: { user, paymentLogs, creditTxns, subscriptions },
    });
  } catch (e) {
    console.error('[AdminPayments] user history error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── 4. Adjust credits (add or deduct) ────────────────────────────────────────
/**
 * POST /api/admin/payments/users/:userId/adjust-credits
 * Body: { amount: number (positive=add, negative=deduct), description: string }
 */
router.post('/users/:userId/adjust-credits', async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, description } = req.body || {};

    if (!mongoose.isValidObjectId(userId))
      return res.status(400).json({ success: false, message: 'Invalid userId' });

    const numericAmount = Number(amount);
    if (!numericAmount || isNaN(numericAmount) || numericAmount === 0)
      return res.status(400).json({ success: false, message: 'amount must be a non-zero number' });

    const userIds = await getAdminUserIds(req.user);
    if (!userIds.map(String).includes(String(userId)))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const previousBalance = user.credits || 0;
    const newBalance = Math.max(0, previousBalance + numericAmount);

    user.credits = newBalance;
    await user.save();

    const tx = await Credit.create({
      userId: user._id,
      amount: numericAmount,
      previousBalance,
      newBalance,
      addedBy: req.user._id,
      addedByRole: req.user.role,
      description: description || `Credits ${numericAmount > 0 ? 'added' : 'deducted'} by ${req.user.role}`,
    });

    res.json({
      success: true,
      message: `Credits ${numericAmount > 0 ? 'added' : 'deducted'} successfully`,
      data: { previousBalance, newBalance, amount: numericAmount, transaction: tx },
    });
  } catch (e) {
    console.error('[AdminPayments] adjust credits error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── 5. Subscriptions list ────────────────────────────────────────────────────
/**
 * GET /api/admin/payments/subscriptions
 * Query: page, limit, status, userId
 */
router.get('/subscriptions', async (req, res) => {
  try {
    const { page = 1, limit = 25, status, userId } = req.query;
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(limit) || 25, 1), 100);
    const skip = (pageNum - 1) * pageSize;

    const userIds = await getAdminUserIds(req.user);

    const query = { userId: { $in: userIds } };
    if (userId && mongoose.isValidObjectId(userId)) query.userId = userId;
    if (status) query.status = status;

    const [subs, total] = await Promise.all([
      UserSubscription.find(query)
        .populate('userId', 'email profile.name credits')
        .populate('planId', 'name billingType billingInterval creditsPerGrant currency offerPriceMinorUnits')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      UserSubscription.countDocuments(query),
    ]);

    res.json({ success: true, data: { subscriptions: subs, total, page: pageNum, limit: pageSize } });
  } catch (e) {
    console.error('[AdminPayments] subscriptions error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── 6. Cancel subscription ───────────────────────────────────────────────────
/**
 * POST /api/admin/payments/subscriptions/:subId/cancel
 * Body: { immediately?: boolean } — default: cancel at period end
 */
router.post('/subscriptions/:subId/cancel', async (req, res) => {
  try {
    const { subId } = req.params;
    const immediately = req.body?.immediately === true;

    if (!mongoose.isValidObjectId(subId))
      return res.status(400).json({ success: false, message: 'Invalid subscription id' });

    const sub = await UserSubscription.findById(subId);
    if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found' });

    const userIds = await getAdminUserIds(req.user);
    if (!userIds.map(String).includes(String(sub.userId)))
      return res.status(403).json({ success: false, message: 'Access denied' });

    const secret = getStripeSecretKey();
    if (!secret) return res.status(503).json({ success: false, message: 'Stripe unavailable' });

    const stripe = new Stripe(secret);

    if (immediately) {
      await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
      sub.status = 'canceled';
    } else {
      await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
      sub.cancelAtPeriodEnd = true;
    }
    await sub.save();

    res.json({
      success: true,
      message: immediately ? 'Subscription cancelled immediately' : 'Subscription will cancel at period end',
      data: { subscriptionId: sub._id, status: sub.status, cancelAtPeriodEnd: sub.cancelAtPeriodEnd },
    });
  } catch (e) {
    console.error('[AdminPayments] cancel subscription error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── 7. Revenue analytics ─────────────────────────────────────────────────────
/**
 * GET /api/admin/payments/analytics
 * Returns: monthly revenue (last 6 months), total revenue, payment counts by status,
 *          top paying users, credit distribution.
 */
router.get('/analytics', async (req, res) => {
  try {
    const userIds = await getAdminUserIds(req.user);
    const now = new Date();
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Monthly revenue from confirmed payments (amountCents in paise → rupees)
    const monthlyRevenueRaw = await PaymentLog.aggregate([
      {
        $match: {
          userId: { $in: userIds },
          event: 'confirm',
          status: 'succeeded',
          createdAt: { $gte: sixMonthsAgo },
        },
      },
      {
        $group: {
          _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
          totalAmountCents: { $sum: '$amountCents' },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const monthlyRevenue = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const found = monthlyRevenueRaw.find(
        (r) => r._id.year === d.getFullYear() && r._id.month === d.getMonth() + 1
      );
      monthlyRevenue.push({
        month: monthNames[d.getMonth()],
        year: d.getFullYear(),
        amountRupees: found ? Math.round(found.totalAmountCents / 100) : 0,
        count: found ? found.count : 0,
      });
    }

    // Overall totals
    const [totalRevenue, totalPayments, failedPayments, activeSubscriptions, totalCreditsGranted] =
      await Promise.all([
        PaymentLog.aggregate([
          { $match: { userId: { $in: userIds }, event: 'confirm', status: 'succeeded' } },
          { $group: { _id: null, total: { $sum: '$amountCents' } } },
        ]),
        PaymentLog.countDocuments({ userId: { $in: userIds }, event: 'confirm' }),
        PaymentLog.countDocuments({ userId: { $in: userIds }, event: 'error' }),
        UserSubscription.countDocuments({ userId: { $in: userIds }, status: 'active' }),
        Credit.aggregate([
          { $match: { userId: { $in: userIds }, amount: { $gt: 0 } } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
      ]);

    // Top 5 paying users
    const topUsers = await PaymentLog.aggregate([
      { $match: { userId: { $in: userIds }, event: 'confirm', status: 'succeeded' } },
      { $group: { _id: '$userId', totalAmountCents: { $sum: '$amountCents' }, count: { $sum: 1 } } },
      { $sort: { totalAmountCents: -1 } },
      { $limit: 5 },
    ]);

    const topUserIds = topUsers.map((u) => u._id);
    const topUserDocs = await User.find({ _id: { $in: topUserIds } })
      .select('email profile.name credits')
      .lean();

    const topPayingUsers = topUsers.map((u) => {
      const doc = topUserDocs.find((d) => String(d._id) === String(u._id));
      return {
        userId: u._id,
        email: doc?.email || 'Unknown',
        name: doc?.profile?.name || '-',
        totalAmountRupees: Math.round(u.totalAmountCents / 100),
        paymentCount: u.count,
        currentCredits: doc?.credits ?? 0,
      };
    });

    res.json({
      success: true,
      data: {
        monthlyRevenue,
        totalRevenueRupees: Math.round((totalRevenue[0]?.total || 0) / 100),
        totalPayments,
        failedPayments,
        activeSubscriptions,
        totalCreditsGranted: totalCreditsGranted[0]?.total || 0,
        topPayingUsers,
        stripeMode: STRIPE_MODE,
      },
    });
  } catch (e) {
    console.error('[AdminPayments] analytics error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

export default router;
