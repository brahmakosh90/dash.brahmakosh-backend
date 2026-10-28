import express from 'express';
import ReferralPartner from '../../models/referral/ReferralPartner.js';
import ReferralCampaign from '../../models/referral/ReferralCampaign.js';
import ReferralDailyStat from '../../models/referral/ReferralDailyStat.js';
import ReferralRecord from '../../models/referral/ReferralRecord.js';
import ReferralCommission from '../../models/referral/ReferralCommission.js';
import ReferralWithdrawal from '../../models/referral/ReferralWithdrawal.js';
import { Ticket, nextCode } from '../../models/referral/ReferralMisc.js';
import { partnerAuth, requireApproved } from '../../middleware/referralAuth.js';
import { encrypt } from '../../services/referral/crypto.js';
import { RULES, dayStr } from '../../services/referral/rules.js';
import { serializePartner, serializePayout, serializeCampaign, serializeWithdrawal, walletFor, leaderboardFor, initials, oid, isId } from '../../services/referral/service.js';

const router = express.Router();
const fail = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });
const WINDOW = 90;

// Profile is reachable while an application is still pending so partners can see their status.
router.get('/profile', partnerAuth, (req, res) => res.json({ success: true, data: { partner: serializePartner(req.partner) } }));

// Change password (any signed-in partner, including applicants).
router.post('/password', partnerAuth, async (req, res) => {
  try {
    const { current, next } = req.body || {};
    if (!current || !next) return fail(res, 400, 'Enter your current and new password.');
    if (String(next).length < 8) return fail(res, 400, 'New password must be at least 8 characters.');
    if (current === next) return fail(res, 400, 'New password must be different from the current one.');
    const p = await ReferralPartner.findById(req.partner._id).select('+password');
    if (!(await p.comparePassword(current))) return fail(res, 400, 'Current password is incorrect.');
    p.password = next; await p.save();
    res.json({ success: true });
  } catch (e) { fail(res, 500, e.message); }
});

router.use(partnerAuth, requireApproved);

router.patch('/profile', async (req, res) => {
  try {
    const { name, org, phone, country, audience, bio } = req.body || {};
    if (name !== undefined && String(name).trim().length < 2) return fail(res, 400, 'Name is required.');
    Object.assign(req.partner, Object.fromEntries(Object.entries({ name, org, phone, country, audience, bio: bio?.slice(0, 600) }).filter(([, v]) => v !== undefined)));
    await req.partner.save();
    res.json({ success: true, data: { partner: serializePartner(req.partner) } });
  } catch (e) { fail(res, 500, e.message); }
});

// Everything the partner screens need, scoped to this partner and to the last 90 days of activity.
router.get('/bootstrap', async (req, res) => {
  try {
    const pid = req.partner._id; const since = dayStr(-(WINDOW - 1));
    const partner = await ReferralPartner.findById(pid);
    const [campaigns, series, referrals, commissions, withdrawals, tickets, wallet, lifetime] = await Promise.all([
      ReferralCampaign.find({ partnerId: pid }).sort({ general: -1, createdAt: -1 }).lean(),
      ReferralDailyStat.find({ partnerId: pid }).lean(),
      ReferralRecord.find({ partnerId: pid, installAt: { $gte: since } }).sort({ installAt: -1, _id: -1 }).limit(4000).lean(),
      ReferralCommission.find({ partnerId: pid, date: { $gte: since } }).sort({ date: -1, _id: -1 }).limit(6000).lean(),
      ReferralWithdrawal.find({ partnerId: pid }).sort({ createdAt: -1 }).lean(),
      Ticket.find({ partnerId: pid }).sort({ createdAt: -1 }).lean(),
      walletFor(pid),
      ReferralDailyStat.aggregate([{ $match: { partnerId: pid } }, { $group: { _id: null, clicks: { $sum: '$clicks' }, installs: { $sum: '$installs' }, regs: { $sum: '$regs' } } }]),
    ]);
    const cid = {}; campaigns.forEach((c) => { cid[String(c._id)] = c; });
    const t = lifetime[0] || { clicks: 0, installs: 0, regs: 0 };
    const totals = Object.fromEntries(campaigns.map((c) => [String(c._id), { clicks: 0, installs: 0, regs: 0 }]));
    series.forEach((s) => { const x = totals[String(s.campaignId)]; if (x) { x.clicks += s.clicks; x.installs += s.installs; x.regs += s.regs; } });
    res.json({ success: true, data: {
      rules: RULES, partner: serializePartner(partner), payout: serializePayout(partner.payout), wallet,
      totals: { clicks: t.clicks, installs: t.installs, regs: t.regs }, campaignTotals: totals,
      campaigns: campaigns.map(serializeCampaign),
      series: series.filter((s) => s.date >= since).map((s) => ({ campaignId: String(s.campaignId), date: s.date, clicks: s.clicks, installs: s.installs, regs: s.regs })),
      referrals: referrals.map((r) => ({ id: String(r._id), campaignId: String(r.campaignId), anon: r.anon, channel: r.channel, device: r.device, country: r.country, clickAt: r.clickAt, installAt: r.installAt, regAt: r.regAt, status: r.status, eligibility: r.eligibility, reason: r.reason })),
      commissions: commissions.map((c) => ({ id: String(c._id), refId: String(c.recordId), anon: c.anon, campaignId: c.campaignId ? String(c.campaignId) : null, date: c.date, amount: c.amount, status: c.status, reason: c.reason })),
      withdrawals: withdrawals.map(serializeWithdrawal),
      tickets: tickets.map((x) => ({ id: x.code, subject: x.subject, category: x.category, message: x.message, reply: x.reply, status: x.status, createdAt: dayStr(0, x.createdAt), updatedAt: dayStr(0, x.updatedAt) })),
    } });
  } catch (e) { fail(res, 500, e.message); }
});

router.get('/leaderboard', async (req, res) => {
  try {
    const period = ['7', '30', 'all'].includes(req.query.period) ? req.query.period : '30';
    res.json({ success: true, data: { rows: await leaderboardFor(period), me: String(req.partner._id) } });
  } catch (e) { fail(res, 500, e.message); }
});

router.post('/withdrawals', async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    const p = await ReferralPartner.findById(req.partner._id);
    if (!Number.isFinite(amount) || amount <= 0) return fail(res, 400, 'Enter a valid amount.');
    if (p.payout?.status !== 'verified') return fail(res, 400, 'Your payout details are awaiting verification.');
    if (amount < RULES.minWithdrawal) return fail(res, 400, `Minimum withdrawal is $${RULES.minWithdrawal}.`);
    const before = await walletFor(p._id);
    if (before.payable < RULES.minWithdrawal) return fail(res, 400, `You need at least $${RULES.minWithdrawal} in approved balance to withdraw.`);
    if (amount > before.payable) return fail(res, 400, `Amount exceeds your payable balance of $${before.payable.toFixed(2)}.`);

    let w;
    try {
      w = await ReferralWithdrawal.create({ code: await nextCode('WD', 1000), partnerId: p._id, amount: Math.round(amount * 100) / 100, requestedAt: dayStr(0), history: [{ at: dayStr(0), label: 'Requested' }] });
    } catch (e) {
      if (e.code === 11000) return fail(res, 409, 'You already have a request awaiting approval.');
      throw e;
    }
    // Re-check after reserving: two concurrent requests could otherwise both pass the balance check above.
    const after = await walletFor(p._id);
    if (after.approved - after.reserved < 0) {
      await ReferralWithdrawal.deleteOne({ _id: w._id });
      return fail(res, 409, 'Your balance changed while processing. Please try again.');
    }
    res.status(201).json({ success: true, data: { withdrawal: serializeWithdrawal(w) } });
  } catch (e) { fail(res, 500, e.message); }
});

router.put('/payout', async (req, res) => {
  try {
    const { holder, bank, account, code, country } = req.body || {};
    if (!holder?.trim() || holder.trim().length < 3) return fail(res, 400, 'Enter the account holder name.');
    if (!bank?.trim()) return fail(res, 400, 'Enter the bank name.');
    if (!/^\d{8,18}$/.test(String(account || ''))) return fail(res, 400, 'Account number must be 8–18 digits.');
    if (!/^[A-Za-z0-9]{6,15}$/.test(String(code || ''))) return fail(res, 400, 'Enter a valid IFSC / SWIFT / routing code.');
    const p = await ReferralPartner.findById(req.partner._id);
    p.payout = { method: 'Bank transfer (manual)', holder: holder.trim(), bank: bank.trim(), country: country || '', code: code.toUpperCase(), last4: String(account).slice(-4), accountEnc: encrypt(account), status: 'pending_verification', updatedAt: new Date() };
    await p.save();
    res.json({ success: true, data: { payout: serializePayout(p.payout) } });
  } catch (e) { fail(res, 500, e.message); }
});

router.post('/campaigns', async (req, res) => {
  try {
    const { name, code, start, end, cap, channel } = req.body || {};
    if (!name || name.trim().length < 4) return fail(res, 400, 'Give the campaign a descriptive name.');
    if (!/^[A-Za-z0-9]{4,14}$/.test(code || '')) return fail(res, 400, 'Code must be 4–14 letters or numbers.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '') || end <= start) return fail(res, 400, 'End date must be after the start date.');
    if (!(Number(cap) >= 50)) return fail(res, 400, 'Minimum limit is 50 registrations.');
    if (await ReferralCampaign.exists({ code: code.toUpperCase() })) return fail(res, 409, 'This code is already in use.');
    const c = await ReferralCampaign.create({ partnerId: req.partner._id, name: name.trim(), code, start, end, cap: Number(cap), channelFocus: channel || '', status: 'pending_approval', approval: 'pending', rate: RULES.commission });
    res.status(201).json({ success: true, data: { campaign: serializeCampaign(c) } });
  } catch (e) { fail(res, 500, e.message); }
});

router.post('/tickets', async (req, res) => {
  try {
    const { subject, category, message } = req.body || {};
    if (!subject || subject.trim().length < 5) return fail(res, 400, 'Add a short subject (5+ characters).');
    if (!message || message.trim().length < 15) return fail(res, 400, 'Please describe the issue in a little more detail.');
    const t = await Ticket.create({ code: await nextCode('TK', 2000), partnerId: req.partner._id, subject: subject.trim(), category: category || 'Other', message: message.trim() });
    res.status(201).json({ success: true, data: { ticket: { id: t.code, subject: t.subject, category: t.category, message: t.message, reply: '', status: t.status, createdAt: dayStr(0), updatedAt: dayStr(0) } } });
  } catch (e) { fail(res, 500, e.message); }
});

export default router;
