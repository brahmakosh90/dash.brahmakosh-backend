import express from 'express';
import Stripe from 'stripe';
import mongoose from 'mongoose';
import { authenticate, authorize } from '../middleware/auth.js';
import SubscriptionPlan from '../models/SubscriptionPlan.js';
import User from '../models/User.js';
import PaymentLog from '../models/PaymentLog.js';
import PlanRedemption from '../models/PlanRedemption.js';
import UserSubscription from '../models/UserSubscription.js';
import { grantCredits } from '../services/creditLedger.js';
import {
  getStripeSecretKey,
  getPublishableKey,
  stripeCurrencyFromPlanCurrency,
  STRIPE_MODE,
} from '../services/stripePlanSync.js';

const router = express.Router();

function userTenantClientId(user) {
  const c = user.clientId;
  if (!c) return null;
  if (typeof c === 'object' && c._id) return c._id;
  return c;
}

function isAbsoluteUrl(s) {
  return typeof s === 'string' && /^https?:\/\//i.test(s.trim());
}

/** Active Stripe subscriptions for this user (recurring plans). */
router.get('/subscriptions', authenticate, authorize('user'), async (req, res) => {
  try {
    const rows = await UserSubscription.find({ userId: req.user._id })
      .sort({ updatedAt: -1 })
      .populate('planId', 'name billingInterval creditsPerGrant currency offerPriceMinorUnits')
      .lean();
    res.json({
      success: true,
      data: {
        subscriptions: rows.map((r) => ({
          id: r._id,
          status: r.status,
          stripeSubscriptionId: r.stripeSubscriptionId,
          currentPeriodEnd: r.currentPeriodEnd,
          cancelAtPeriodEnd: r.cancelAtPeriodEnd,
          plan: r.planId,
        })),
      },
    });
  } catch (e) {
    console.error('[user subscriptions]', e);
    res.status(500).json({ success: false, message: 'Failed to load subscriptions' });
  }
});

/** Public catalog: enabled plans for the authenticated user's client tenant. */
router.get('/subscription-plans', authenticate, authorize('user'), async (req, res) => {
  try {
    const fullUser = await User.findById(req.user._id).select('clientId credits').populate('clientId', 'clientId businessName');
    const owner = userTenantClientId(fullUser);
    if (!owner) {
      return res.json({
        success: true,
        data: { plans: [], message: 'User has no assigned client; no plans to show.' },
      });
    }

    const plans = await SubscriptionPlan.find({
      ownerClient: owner,
      isEnabled: true,
    })
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();

    const publicPlans = plans.map((p) => {
      const { stripeProductId, stripePriceId, ...rest } = p;
      return {
        ...rest,
        id: p._id,
        creditsGranted: SubscriptionPlan.creditsForGrant(p),
      };
    });

    res.json({
      success: true,
      data: {
        plans: publicPlans,
        userCredits: fullUser.credits ?? 0,
        client: fullUser.clientId
          ? {
              id: fullUser.clientId._id,
              clientCode: fullUser.clientId.clientId,
              businessName: fullUser.clientId.businessName,
            }
          : null,
      },
    });
  } catch (e) {
    console.error('[user subscription-plans]', e);
    res.status(500).json({ success: false, message: 'Failed to load plans' });
  }
});

/**
 * One-time pack: Stripe PaymentIntent for plan.offerPriceMinorUnits.
 * POST body: { planId: string }
 */
router.post('/payment/by-plan/intent', authenticate, authorize('user'), async (req, res) => {
  try {
    const secret = getStripeSecretKey();
    if (!secret) {
      return res.status(503).json({ success: false, message: 'Payment service unavailable' });
    }

    const planId = req.body?.planId;
    if (!planId || !mongoose.isValidObjectId(planId)) {
      return res.status(400).json({ success: false, message: 'Valid planId is required' });
    }

    const fullUser = await User.findById(req.user._id).select('clientId');
    const owner = userTenantClientId(fullUser);
    if (!owner) {
      return res.status(400).json({ success: false, message: 'User is not linked to a client' });
    }

    const plan = await SubscriptionPlan.findOne({
      _id: planId,
      ownerClient: owner,
      isEnabled: true,
      billingType: 'one_time',
    });
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found or not a one-time plan' });
    }

    if (plan.offerPriceMinorUnits < 1) {
      return res.status(400).json({
        success: false,
        message: 'Use POST /api/user/plans/claim-free for zero-priced packs',
      });
    }

    const credits = plan.resolveCreditsPerGrant();
    const stripe = new Stripe(secret);
    const currency = stripeCurrencyFromPlanCurrency(plan.currency);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(plan.offerPriceMinorUnits),
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: {
        userId: String(req.user._id),
        planId: String(plan._id),
        ownerClientId: String(owner),
        credits: String(credits),
        billingType: 'one_time',
        stripeMode: STRIPE_MODE,
      },
    });

    await PaymentLog.create({
      userId: req.user._id,
      paymentIntentId: paymentIntent.id,
      event: 'create_intent',
      amountCents: paymentIntent.amount,
      credits,
      status: paymentIntent.status,
      metadata: {
        planId: String(plan._id),
        billingType: 'one_time',
        clientIp: req.ip,
      },
    });

    res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      publishableKey: getPublishableKey(),
      paymentIntentId: paymentIntent.id,
      credits,
      currency: plan.currency,
      amountMinorUnits: plan.offerPriceMinorUnits,
      plan: {
        id: plan._id,
        name: plan.name,
        billingType: plan.billingType,
      },
    });
  } catch (e) {
    console.error('[by-plan intent]', e);
    res.status(500).json({
      success: false,
      message: 'Failed to create payment',
      error: process.env.NODE_ENV === 'development' ? e.message : undefined,
    });
  }
});

/**
 * One-time pack: Stripe Checkout Session (hosted) in payment mode.
 * POST body: { planId, successUrl, cancelUrl }
 */
router.post('/payment/by-plan/one-time-checkout', authenticate, authorize('user'), async (req, res) => {
  try {
    const secret = getStripeSecretKey();
    if (!secret) {
      return res.status(503).json({ success: false, message: 'Payment service unavailable' });
    }

    const { planId, successUrl, cancelUrl } = req.body || {};
    if (!planId || !mongoose.isValidObjectId(planId)) {
      return res.status(400).json({ success: false, message: 'Valid planId is required' });
    }

    const okUrl = successUrl || process.env.STRIPE_CHECKOUT_SUCCESS_URL;
    const badUrl = cancelUrl || process.env.STRIPE_CHECKOUT_CANCEL_URL;
    if (!isAbsoluteUrl(okUrl) || !isAbsoluteUrl(badUrl)) {
      return res.status(400).json({
        success: false,
        message: 'successUrl and cancelUrl must be absolute https URLs',
      });
    }

    const fullUser = await User.findById(req.user._id).select('clientId email');
    const owner = userTenantClientId(fullUser);
    if (!owner) {
      return res.status(400).json({ success: false, message: 'User is not linked to a client' });
    }

    const plan = await SubscriptionPlan.findOne({
      _id: planId,
      ownerClient: owner,
      isEnabled: true,
      billingType: 'one_time',
    });
    if (!plan || plan.offerPriceMinorUnits < 1) {
      return res.status(404).json({ success: false, message: 'Plan not found or is free' });
    }

    const credits = plan.resolveCreditsPerGrant();
    const stripe = new Stripe(secret);
    const currency = stripeCurrencyFromPlanCurrency(plan.currency);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency,
          unit_amount: Math.round(plan.offerPriceMinorUnits),
          product_data: {
            name: plan.name,
            description: plan.description || `${credits} credits`,
          },
        },
        quantity: 1,
      }],
      success_url: `${okUrl}${okUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: badUrl,
      customer_email: fullUser.email || undefined,
      client_reference_id: String(fullUser._id),
      metadata: {
        userId: String(fullUser._id),
        planId: String(plan._id),
        ownerClientId: String(owner),
        credits: String(credits),
        billingType: 'one_time',
      },
    });

    await PaymentLog.create({
      userId: req.user._id,
      event: 'create_intent',
      amountCents: plan.offerPriceMinorUnits,
      credits,
      status: 'pending',
      metadata: { planId: String(plan._id), sessionId: session.id, billingType: 'one_time_checkout' },
    });

    res.json({
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id,
      publishableKey: getPublishableKey(),
    });
  } catch (e) {
    console.error('[one-time-checkout]', e);
    res.status(500).json({
      success: false,
      message: 'Failed to create checkout session',
      error: process.env.NODE_ENV === 'development' ? e.message : undefined,
    });
  }
});

/**
 * Recurring plan: Stripe Checkout Session (hosted) in subscription mode.
 * POST body: { planId, successUrl, cancelUrl }
 */
router.post('/payment/by-plan/subscription-checkout', authenticate, authorize('user'), async (req, res) => {
  try {
    const secret = getStripeSecretKey();
    if (!secret) {
      return res.status(503).json({ success: false, message: 'Payment service unavailable' });
    }

    const { planId, successUrl, cancelUrl } = req.body || {};
    if (!planId || !mongoose.isValidObjectId(planId)) {
      return res.status(400).json({ success: false, message: 'Valid planId is required' });
    }

    const okUrl = successUrl || process.env.STRIPE_CHECKOUT_SUCCESS_URL;
    const badUrl = cancelUrl || process.env.STRIPE_CHECKOUT_CANCEL_URL;
    if (!isAbsoluteUrl(okUrl) || !isAbsoluteUrl(badUrl)) {
      return res.status(400).json({
        success: false,
        message: 'successUrl and cancelUrl must be absolute https URLs (or set STRIPE_CHECKOUT_SUCCESS_URL / STRIPE_CHECKOUT_CANCEL_URL)',
      });
    }

    const fullUser = await User.findById(req.user._id).select('clientId email');
    const owner = userTenantClientId(fullUser);
    if (!owner) {
      return res.status(400).json({ success: false, message: 'User is not linked to a client' });
    }

    const plan = await SubscriptionPlan.findOne({
      _id: planId,
      ownerClient: owner,
      isEnabled: true,
      billingType: 'recurring',
    });
    if (!plan || !plan.stripePriceId) {
      return res.status(404).json({
        success: false,
        message: 'Plan not found, not recurring, or missing Stripe price (client must re-save plan)',
      });
    }

    const stripe = new Stripe(secret);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      success_url: okUrl.includes('{CHECKOUT_SESSION_ID}')
        ? okUrl
        : `${okUrl}${okUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: badUrl,
      customer_email: fullUser.email || undefined,
      client_reference_id: String(fullUser._id),
      metadata: {
        userId: String(fullUser._id),
        planId: String(plan._id),
        ownerClientId: String(owner),
      },
      subscription_data: {
        metadata: {
          userId: String(fullUser._id),
          planId: String(plan._id),
          ownerClientId: String(owner),
        },
      },
    });

    res.json({
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id,
      publishableKey: getPublishableKey(),
    });
  } catch (e) {
    console.error('[subscription-checkout]', e);
    res.status(500).json({
      success: false,
      message: 'Failed to create checkout session',
      error: process.env.NODE_ENV === 'development' ? e.message : undefined,
    });
  }
});

/**
 * Zero-priced one-time pack (freemium): claim once per user per plan.
 * POST body: { planId }
 */
router.post('/plans/claim-free', authenticate, authorize('user'), async (req, res) => {
  try {
    const planId = req.body?.planId;
    if (!planId || !mongoose.isValidObjectId(planId)) {
      return res.status(400).json({ success: false, message: 'Valid planId is required' });
    }

    const fullUser = await User.findById(req.user._id);
    const owner = userTenantClientId(fullUser);
    if (!owner) {
      return res.status(400).json({ success: false, message: 'User is not linked to a client' });
    }

    const plan = await SubscriptionPlan.findOne({
      _id: planId,
      ownerClient: owner,
      isEnabled: true,
      billingType: 'one_time',
      offerPriceMinorUnits: 0,
    });
    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Free plan not found or not eligible (must be one-time, price 0, enabled)',
      });
    }

    const credits = plan.resolveCreditsPerGrant();
    try {
      await PlanRedemption.create({
        userId: fullUser._id,
        planId: plan._id,
        kind: 'free_pack',
      });
    } catch (err) {
      if (err?.code === 11000) {
        return res.status(409).json({
          success: false,
          message: 'This free pack was already claimed',
        });
      }
      throw err;
    }

    const result = await grantCredits({
      userId: fullUser._id,
      amount: credits,
      addedBy: fullUser._id,
      addedByRole: 'payment',
      description: `Free pack: ${plan.name}`,
      planId: plan._id,
    });

    res.json({
      success: true,
      message: 'Credits granted',
      data: {
        creditsAdded: result.credit?.amount ?? credits,
        newBalance: result.newBalance,
      },
    });
  } catch (e) {
    console.error('[claim-free]', e);
    res.status(500).json({ success: false, message: 'Failed to claim free pack' });
  }
});

/**
 * Confirm one-time plan PaymentIntent (same semantics as /api/user/payment/confirm).
 * POST body: { paymentIntentId }
 */
router.post('/payment/by-plan/confirm', authenticate, authorize('user'), async (req, res) => {
  try {
    const secret = getStripeSecretKey();
    if (!secret) {
      return res.status(503).json({ success: false, message: 'Payment service unavailable' });
    }

    const { paymentIntentId } = req.body || {};
    if (!paymentIntentId || typeof paymentIntentId !== 'string') {
      return res.status(400).json({ success: false, message: 'paymentIntentId is required' });
    }

    const stripe = new Stripe(secret);
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (pi.status !== 'succeeded') {
      return res.status(400).json({
        success: false,
        message: 'Payment not completed',
        status: pi.status,
      });
    }

    if (pi.metadata?.billingType !== 'one_time' || !pi.metadata?.planId) {
      return res.status(400).json({
        success: false,
        message: 'This intent is not a plan purchase; use /api/user/payment/confirm for legacy top-ups',
      });
    }

    const userId = pi.metadata.userId;
    const creditsToAdd = parseInt(pi.metadata.credits || '0', 10);
    const planId = pi.metadata.planId;

    if (!userId || userId !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Payment does not belong to this user' });
    }
    if (!creditsToAdd || creditsToAdd <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid credits amount' });
    }

    const plan = await SubscriptionPlan.findById(planId).select('ownerClient billingType');
    if (!plan || plan.billingType !== 'one_time') {
      return res.status(400).json({ success: false, message: 'Invalid plan' });
    }

    const fullUser = await User.findById(req.user._id).select('clientId');
    const owner = userTenantClientId(fullUser);
    if (!owner || plan.ownerClient.toString() !== owner.toString()) {
      return res.status(403).json({ success: false, message: 'Plan tenant mismatch' });
    }

    const result = await grantCredits({
      userId: req.user._id,
      amount: creditsToAdd,
      addedBy: req.user._id,
      addedByRole: 'payment',
      description: 'Credits purchased via plan (Stripe)',
      paymentIntentId,
      planId: plan._id,
    });

    if (result.duplicate) {
      return res.json({
        success: true,
        message: 'Credits already added',
        data: { creditsAdded: creditsToAdd, newBalance: result.newBalance },
      });
    }

    await PaymentLog.create({
      userId: req.user._id,
      paymentIntentId,
      event: 'confirm',
      amountCents: pi.amount,
      credits: creditsToAdd,
      status: pi.status,
      metadata: { planId, newBalance: result.newBalance },
    });

    res.json({
      success: true,
      message: 'Credits added successfully',
      data: {
        creditsAdded: creditsToAdd,
        newBalance: result.newBalance,
      },
    });
  } catch (e) {
    console.error('[by-plan confirm]', e);
    res.status(500).json({ success: false, message: 'Failed to confirm payment' });
  }
});

export default router;
