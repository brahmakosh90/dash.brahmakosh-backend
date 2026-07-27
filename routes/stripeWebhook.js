import express from 'express';
import mongoose from 'mongoose';
import Stripe from 'stripe';
import SubscriptionPlan from '../models/SubscriptionPlan.js';
import UserSubscription from '../models/UserSubscription.js';
import { grantCredits } from '../services/creditLedger.js';
import { getStripeSecretKey } from '../services/stripePlanSync.js';

const router = express.Router();

const STRIPE_MODE = (process.env.STRIPE_MODE || 'test').toLowerCase() === 'prod' ? 'prod' : 'test';

function webhookSecret() {
  if (STRIPE_MODE === 'prod') {
    return process.env.STRIPE_WEBHOOK_SECRET_PROD;
  }
  return process.env.STRIPE_WEBHOOK_SECRET_TEST || process.env.STRIPE_WEBHOOK_SECRET;
}

router.post('/', async (req, res) => {
  const secret = webhookSecret();
  const key = getStripeSecretKey();
  if (!secret || !key) {
    console.warn('[stripe webhook] Missing STRIPE_WEBHOOK_SECRET or Stripe secret key');
    return res.status(503).send('Webhook not configured');
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const stripe = new Stripe(key);
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[stripe webhook] Signature verify failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const stripe = new Stripe(key);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription' || !session.subscription) break;

        const sub = await stripe.subscriptions.retrieve(session.subscription);
        const { userId, planId, ownerClientId } =
          (sub.metadata?.userId ? sub.metadata : session.metadata) || {};
        if (!userId || !planId || !ownerClientId) {
          console.warn('[stripe webhook] subscription missing metadata', sub.id);
          break;
        }

        if (
          !mongoose.isValidObjectId(userId) ||
          !mongoose.isValidObjectId(planId) ||
          !mongoose.isValidObjectId(ownerClientId)
        ) {
          console.warn('[stripe webhook] invalid metadata ids', sub.id);
          break;
        }

        await UserSubscription.findOneAndUpdate(
          { stripeSubscriptionId: sub.id },
          {
            userId: new mongoose.Types.ObjectId(userId),
            planId: new mongoose.Types.ObjectId(planId),
            ownerClient: new mongoose.Types.ObjectId(ownerClientId),
            stripeCustomerId: sub.customer || null,
            stripeSubscriptionId: sub.id,
            status: sub.status,
            currentPeriodStart: sub.current_period_start
              ? new Date(sub.current_period_start * 1000)
              : null,
            currentPeriodEnd: sub.current_period_end
              ? new Date(sub.current_period_end * 1000)
              : null,
            cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          },
          { upsert: true, new: true }
        );
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (!subId) break;

        const sub = await stripe.subscriptions.retrieve(subId);
        const { userId, planId } = sub.metadata || {};
        if (!userId || !planId) {
          console.warn('[stripe webhook] invoice.paid: subscription missing metadata', subId);
          break;
        }

        const plan = await SubscriptionPlan.findById(planId);
        if (!plan) {
          console.warn('[stripe webhook] plan not found', planId);
          break;
        }

        const credits = plan.resolveCreditsPerGrant();
        const result = await grantCredits({
          userId,
          amount: credits,
          addedBy: userId,
          addedByRole: 'subscription',
          description: `Subscription credits (${plan.name}) — invoice ${invoice.id}`,
          stripeInvoiceId: invoice.id,
          stripeSubscriptionId: subId,
          planId: plan._id,
        });

        if (result.skipped) {
          console.log('[stripe webhook] invoice.paid skipped (zero credits)', invoice.id);
        } else if (result.duplicate) {
          console.log('[stripe webhook] invoice already fulfilled', invoice.id);
        } else {
          console.log('[stripe webhook] credits granted', invoice.id, credits, result.newBalance);
        }
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const status = sub.status;
        await UserSubscription.findOneAndUpdate(
          { stripeSubscriptionId: sub.id },
          {
            status,
            currentPeriodStart: sub.current_period_start
              ? new Date(sub.current_period_start * 1000)
              : null,
            currentPeriodEnd: sub.current_period_end
              ? new Date(sub.current_period_end * 1000)
              : null,
            cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          },
          { new: true }
        );
        break;
      }

      default:
        break;
    }
  } catch (e) {
    console.error('[stripe webhook] handler error', e);
    return res.status(500).json({ received: false });
  }

  res.json({ received: true });
});

export default router;
