import User from '../models/User.js';
import Credit from '../models/Credit.js';

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
