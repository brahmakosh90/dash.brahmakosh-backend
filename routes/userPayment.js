import express from 'express';
import Stripe from 'stripe';
import { authenticate, authorize } from '../middleware/auth.js';
import User from '../models/User.js';
import PaymentLog from '../models/PaymentLog.js';
import AppSettings from '../models/AppSettings.js';
import { grantCredits } from '../services/creditLedger.js';

const router = express.Router();

// Amounts are treated as INR rupees
const MIN_AMOUNT_UNITS = 500; // ₹500 minimum for normal plans/custom
const MAX_AMOUNT_UNITS = 1000000;
const TRIAL_PLAN_AMOUNT = 100;
const DEFAULT_PLANS = [TRIAL_PLAN_AMOUNT, 500, 1000, 2000, 4000];

// Resolve Stripe env (test/prod) from STRIPE_MODE
const STRIPE_MODE = (process.env.STRIPE_MODE || 'test').toLowerCase() === 'prod' ? 'prod' : 'test';

const getStripeSecretKey = () => {
  if (STRIPE_MODE === 'prod') {
    return process.env.STRIPE_SECRET_KEY_PROD;
  }
  return process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY;
};

const getStripeWebhookSecret = () => {
  if (STRIPE_MODE === 'prod') {
    return process.env.STRIPE_WEBHOOK_SECRET_PROD;
  }
  return process.env.STRIPE_WEBHOOK_SECRET_TEST || process.env.STRIPE_WEBHOOK_SECRET;
};

/** Publishable key for current mode (frontend must use this; test PI requires pk_test) */
const getPublishableKey = () => {
  if (STRIPE_MODE === 'prod') {
    return process.env.STRIPE_PUBLISHABLE_KEY_PROD || process.env.STRIPE_PUBLISHABLE_KEY || '';
  }
  return process.env.STRIPE_PUBLISHABLE_KEY_TEST || process.env.STRIPE_PUBLISHABLE_KEY || '';
};

const getCreditsPerUnit = async () => {
  try {
    const settings = await AppSettings.getSettings();
    if (typeof settings.stripeCreditsPerUnit === 'number' && settings.stripeCreditsPerUnit > 0) {
      return settings.stripeCreditsPerUnit;
    }
  } catch (e) {
    console.warn('[User Payment] Failed to load AppSettings, falling back to env/default:', e.message);
  }
  const envValue = Number(process.env.STRIPE_CREDITS_PER_DOLLAR);
  if (envValue && !isNaN(envValue) && envValue > 0) return envValue;
  return 2; // default: 1 rupee = 2 credits
};

/**
 * POST /api/user/payment/legacy-checkout
 * Stripe Checkout Session for custom INR top-up.
 */
router.post('/legacy-checkout', authenticate, authorize('user'), async (req, res) => {
  try {
    const stripeSecretKey = getStripeSecretKey();
    if (!stripeSecretKey) return res.status(503).json({ success: false, message: 'Payment service unavailable' });

    const body = req.body || {};
    const planAmount = body.planAmount != null ? Number(body.planAmount) : null;
    const rawAmount = body.amount != null ? Number(body.amount) : null;
    const amountUnits = planAmount || rawAmount;
    const usingTrialPlan = planAmount === TRIAL_PLAN_AMOUNT;

    if (!amountUnits || isNaN(amountUnits) || amountUnits <= 0)
      return res.status(400).json({ success: false, message: 'Valid amount is required' });
    if (!usingTrialPlan && amountUnits < MIN_AMOUNT_UNITS)
      return res.status(400).json({ success: false, message: `Minimum amount is ₹${MIN_AMOUNT_UNITS}` });
    if (amountUnits > MAX_AMOUNT_UNITS)
      return res.status(400).json({ success: false, message: 'Amount too large' });

    const okUrl = body.successUrl;
    const badUrl = body.cancelUrl;
    if (!okUrl || !badUrl)
      return res.status(400).json({ success: false, message: 'successUrl and cancelUrl are required' });

    const creditsPerUnit = await getCreditsPerUnit();
    const credits = Math.floor(amountUnits * creditsPerUnit);
    const stripe = new Stripe(stripeSecretKey);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'inr',
          unit_amount: Math.round(amountUnits * 100),
          product_data: { name: `₹${amountUnits} Credits Top-up`, description: `${credits} credits` },
        },
        quantity: 1,
      }],
      success_url: `${okUrl}${okUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: badUrl,
      client_reference_id: String(req.user._id),
      metadata: {
        userId: String(req.user._id),
        credits: String(credits),
        amountUnits: String(amountUnits),
        billingType: 'legacy_topup',
        isTrialPlan: usingTrialPlan ? 'true' : 'false',
      },
    });

    await PaymentLog.create({
      userId: req.user._id,
      event: 'create_intent',
      amountCents: Math.round(amountUnits * 100),
      credits,
      status: 'pending',
      metadata: { sessionId: session.id, billingType: 'legacy_topup' },
    });

    res.json({ success: true, checkoutUrl: session.url, sessionId: session.id });
  } catch (error) {
    console.error('[legacy-checkout]', error);
    res.status(500).json({ success: false, message: 'Failed to create checkout session' });
  }
});

/**
 * POST /api/user/payment/create-intent
 * Create Stripe PaymentIntent for credits recharge.
 * Body:
 *  - planAmount?: number (50, 500, 1000, 2000, 4000)
 *  - amount?: number (custom INR amount, must be >= 500)
 * Returns: { clientSecret, publishableKey, credits, amountUnits }
 */
router.post('/create-intent', authenticate, authorize('user'), async (req, res) => {
  try {
    const stripeSecretKey = getStripeSecretKey();
    if (!stripeSecretKey) {
      return res.status(503).json({ success: false, message: 'Payment service unavailable' });
    }

    const body = req.body || {};
    const planAmount = body.planAmount != null ? Number(body.planAmount) : null;
    const rawAmount = body.amount != null ? Number(body.amount) : null;

    // Prefer plan if provided
    const amountUnits = planAmount || rawAmount;
    const usingTrialPlan = planAmount === TRIAL_PLAN_AMOUNT;

    console.log('[User Payment] create-intent request', {
      userId: req.user._id?.toString(),
      planAmount,
      amount: rawAmount,
      amountUnits,
      usingTrialPlan,
    });
    if (!amountUnits || isNaN(amountUnits) || amountUnits <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount is required' });
    }

    if (!usingTrialPlan && amountUnits < MIN_AMOUNT_UNITS) {
      return res.status(400).json({ success: false, message: `Minimum amount is ₹${MIN_AMOUNT_UNITS}` });
    }
    if (amountUnits > MAX_AMOUNT_UNITS) {
      return res.status(400).json({ success: false, message: 'Amount too large' });
    }

    const creditsPerUnit = await getCreditsPerUnit();
    const credits = Math.floor(amountUnits * creditsPerUnit);
    const stripe = new Stripe(stripeSecretKey);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amountUnits * 100), // INR minor units
      currency: 'inr',
      automatic_payment_methods: { enabled: true },
      metadata: {
        userId: String(req.user._id),
        credits: String(credits),
        amountUnits: String(amountUnits),
        creditsPerUnit: String(creditsPerUnit),
        stripeMode: STRIPE_MODE,
        isTrialPlan: usingTrialPlan ? 'true' : 'false',
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
        amountUnits,
        creditsPerUnit,
        clientIp: req.ip,
        userAgent: req.headers['user-agent'] || null,
        isTrialPlan: usingTrialPlan,
      },
    });

    res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      publishableKey: getPublishableKey(),
      credits,
      amountUnits,
    });
  } catch (error) {
    console.error('[User Payment] Create intent error:', error);
    try {
      await PaymentLog.create({
        userId: req.user?._id,
        event: 'error',
        status: 'create_intent_failed',
        errorMessage: error.message,
        metadata: {
          stage: 'create-intent',
        },
      });
    } catch (_) {}
    res.status(500).json({
      success: false,
      message: 'Failed to create payment',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * POST /api/user/payment/confirm
 * After frontend confirms payment, verify with Stripe and add credits.
 * Body: { paymentIntentId: string }
 */
router.post('/confirm', authenticate, authorize('user'), async (req, res) => {
  try {
    const stripeSecretKey = getStripeSecretKey();
    if (!stripeSecretKey) {
      return res.status(503).json({ success: false, message: 'Payment service unavailable' });
    }

    const { paymentIntentId } = req.body || {};
    if (!paymentIntentId || typeof paymentIntentId !== 'string') {
      return res.status(400).json({ success: false, message: 'paymentIntentId is required' });
    }

    console.log('[User Payment] confirm request', {
      userId: req.user._id?.toString(),
      paymentIntentId,
    });

    const stripe = new Stripe(stripeSecretKey);
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({
        success: false,
        message: 'Payment not completed',
        status: paymentIntent.status,
      });
    }

    const userId = paymentIntent.metadata?.userId;
    const creditsToAdd = parseInt(paymentIntent.metadata?.credits || '0', 10);

    if (!userId || userId !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Payment does not belong to this user' });
    }
    if (creditsToAdd <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid credits amount' });
    }

    const result = await grantCredits({
      userId,
      amount: creditsToAdd,
      addedBy: userId,
      addedByRole: 'payment',
      description:
        paymentIntent.metadata?.isTrialPlan === 'true'
          ? 'Trial credits purchased via Stripe'
          : 'Credits purchased via Stripe',
      paymentIntentId,
    });

    if (result.duplicate) {
      const u = await User.findById(userId).select('credits');
      return res.json({
        success: true,
        message: 'Credits already added',
        data: { creditsAdded: creditsToAdd, newBalance: u?.credits ?? result.newBalance },
      });
    }

    await PaymentLog.create({
      userId,
      paymentIntentId,
      event: 'confirm',
      amountCents: paymentIntent.amount,
      credits: creditsToAdd,
      status: paymentIntent.status,
      metadata: {
        newBalance: result.newBalance,
      },
    });

    res.json({
      success: true,
      message: 'Credits added successfully',
      data: {
        creditsAdded: creditsToAdd,
        newBalance: result.newBalance,
      },
    });
  } catch (error) {
    console.error('[User Payment] Confirm error:', error);
    try {
      await PaymentLog.create({
        userId: req.user?._id,
        event: 'error',
        status: 'confirm_failed',
        errorMessage: error.message,
        metadata: {
          stage: 'confirm',
        },
      });
    } catch (_) {}
    res.status(500).json({
      success: false,
      message: 'Failed to confirm payment',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * GET /api/user/payment/config
 * Returns publishable key and min amount for frontend
 */
router.get('/config', authenticate, authorize('user'), (req, res) => {
  res.json({
    success: true,
    mode: STRIPE_MODE,
    publishableKey: getPublishableKey(),
    minAmountUnits: MIN_AMOUNT_UNITS,
  });
});

/**
 * GET /api/user/payment/plans
 * Returns static plans with computed credits based on current creditsPerUnit.
 */
router.get('/plans', authenticate, authorize('user'), async (req, res) => {
  try {
    const creditsPerUnit = await getCreditsPerUnit();
    const plans = DEFAULT_PLANS.map((amount) => ({
      amount,              // in rupees
      credits: amount * creditsPerUnit,
    }));

    res.json({
      success: true,
      data: {
        mode: STRIPE_MODE,
        currency: 'INR',
        creditsPerUnit,
        plans,
      },
    });
  } catch (error) {
    console.error('[User Payment] plans error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load plans',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

export default router;