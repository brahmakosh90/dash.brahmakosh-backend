import User from '../models/User.js';
import Credit from '../models/Credit.js';

/**
 * Deduct credits from user wallet for report generation.
 * Throws if insufficient balance.
 */
export async function deductCredits({
  userId,
  amount,
  description,
  reportType = null,
  idempotencyKey = null,
}) {
  const n = Math.floor(Number(amount));
  if (!n || n <= 0) throw new Error('Deduction amount must be positive');

  if (idempotencyKey) {
    const dup = await Credit.findOne({ idempotencyKey });
    if (dup) {
      const u = await User.findById(userId).select('credits');
      return { duplicate: true, credit: dup, newBalance: u?.credits ?? dup.newBalance };
    }
  }

  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  const previousBalance = typeof user.credits === 'number' ? Math.floor(user.credits) : 0;
  if (previousBalance < n) {
    const err = new Error(`Insufficient credits. Required: ${n}, Available: ${previousBalance}`);
    err.status = 402;
    err.code = 'INSUFFICIENT_CREDITS';
    err.required = n;
    err.available = previousBalance;
    throw err;
  }

  const newBalance = previousBalance - n;
  user.credits = newBalance;
  await user.save();

  const credit = await Credit.create({
    userId,
    amount: -n,
    previousBalance,
    newBalance,
    addedBy: userId,
    addedByRole: 'user',
    description: description || 'Report generation',
    ...(idempotencyKey && { idempotencyKey }),
    ...(reportType && { reportType }),
  });

  return { credit, newBalance, duplicate: false };
}

/**
 * Idempotent credit grant for payments and subscription invoices.
 */
export async function grantCredits({
  userId,
  amount,
  addedBy,
  addedByRole,
  description,
  paymentIntentId = null,
  stripeInvoiceId = null,
  stripeSubscriptionId = null,
  planId = null,
}) {
  const n = Math.floor(Number(amount));
  if (!n || n <= 0) {
    return { skipped: true, reason: 'non_positive', newBalance: null };
  }

  if (stripeInvoiceId) {
    const dup = await Credit.findOne({ stripeInvoiceId });
    if (dup) {
      const u = await User.findById(userId).select('credits');
      return { duplicate: true, credit: dup, newBalance: u?.credits ?? dup.newBalance };
    }
  }
  if (paymentIntentId) {
    const dup = await Credit.findOne({ paymentIntentId });
    if (dup) {
      const u = await User.findById(userId).select('credits');
      return { duplicate: true, credit: dup, newBalance: u?.credits ?? dup.newBalance };
    }
  }

  const user = await User.findById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const previousBalance = typeof user.credits === 'number' ? Math.floor(user.credits) : 0;
  const newBalance = previousBalance + n;
  user.credits = newBalance;
  await user.save();

  const credit = await Credit.create({
    userId,
    amount: n,
    previousBalance,
    newBalance,
    addedBy,
    addedByRole,
    description: description || 'Credits granted',
    paymentIntentId: paymentIntentId || undefined,
    stripeInvoiceId: stripeInvoiceId || undefined,
    stripeSubscriptionId: stripeSubscriptionId || undefined,
    planId: planId || undefined,
  });

  return { credit, newBalance, duplicate: false };
}
