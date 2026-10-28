// Shared helpers for the referral portal: wallet maths, serializers, audit trail, impact metrics.
import mongoose from 'mongoose';
import ReferralPartner from '../../models/referral/ReferralPartner.js';
import ReferralCampaign from '../../models/referral/ReferralCampaign.js';
import ReferralCommission from '../../models/referral/ReferralCommission.js';
import ReferralWithdrawal from '../../models/referral/ReferralWithdrawal.js';
import ReferralRecord from '../../models/referral/ReferralRecord.js';
import { Audit } from '../../models/referral/ReferralMisc.js';
import { RULES, dayStr, ROLE_LABELS, normalizeRole } from './rules.js';

export const oid = (id) => new mongoose.Types.ObjectId(String(id));
export const isId = (id) => mongoose.isValidObjectId(id);
export const LINK_BASE = process.env.REFERRAL_LINK_BASE || 'https://brahmakosh.com/r';
const RESERVING = ['pending', 'approved', 'processing'];

export const initials = (name = '') => name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

export const serializePartner = (p) => ({
  id: String(p._id), name: p.name, org: p.org, email: p.email, phone: p.phone, country: p.country, audience: p.audience, bio: p.bio,
  status: p.status, reviewNote: p.reviewNote || '', tier: p.tier, code: p.code || null, link: p.code ? `${LINK_BASE}/${p.code}` : null, joinedAt: p.joinedAt ? dayStr(0, p.joinedAt) : null,
  appliedAt: dayStr(0, p.createdAt), initials: initials(p.name),
});

export const serializePayout = (p = {}) => ({
  method: p.method || 'Bank transfer (manual)', holder: p.holder || '', bank: p.bank || '', country: p.country || '', code: p.code || '',
  last4: p.last4 || '', status: p.status || 'unset', updatedAt: p.updatedAt ? dayStr(0, p.updatedAt) : null,
});

/** `active`, `scheduled` and `expired` follow the dates; paused / revoked / pending_approval are explicit decisions. */
export const effectiveStatus = (c) => {
  if (!['active', 'scheduled', 'expired'].includes(c.status)) return c.status;
  const today = dayStr(0);
  if (today > c.end) return 'expired';
  if (today < c.start) return 'scheduled';
  return 'active';
};

export const serializeCampaign = (c) => ({
  id: String(c._id), partnerId: String(c.partnerId), name: c.name, code: c.code, general: !!c.general, start: c.start, end: c.end,
  status: effectiveStatus(c), approval: c.approval, rate: c.rate, cap: c.cap, channelFocus: c.channelFocus, createdAt: dayStr(0, c.createdAt),
});

export const serializeWithdrawal = (w) => ({
  id: w.code, _id: String(w._id), partnerId: String(w.partnerId), amount: w.amount, status: w.status, method: w.method, reference: w.reference,
  reason: w.reason, approvedBy: w.approvedBy, history: w.history || [], requestedAt: w.requestedAt,
});

/** Wallet for one partner, or a map of wallets for many. All amounts come from the commission ledger and withdrawals. */
export const walletFor = async (partnerIds) => {
  const ids = (Array.isArray(partnerIds) ? partnerIds : [partnerIds]).map(oid);
  const [com, wd] = await Promise.all([
    ReferralCommission.aggregate([{ $match: { partnerId: { $in: ids } } }, { $group: { _id: { p: '$partnerId', s: '$status' }, sum: { $sum: '$amount' } } }]),
    ReferralWithdrawal.aggregate([{ $match: { partnerId: { $in: ids }, status: { $in: [...RESERVING, 'paid'] } } }, { $group: { _id: { p: '$partnerId', s: '$status' }, sum: { $sum: '$amount' } } }]),
  ]);
  const out = {};
  ids.forEach((i) => { out[String(i)] = { pending: 0, approved: 0, paid: 0, rejected: 0, reversed: 0, reserved: 0 }; });
  com.forEach((r) => { out[String(r._id.p)][r._id.s] = r.sum; });
  wd.forEach((r) => { if (RESERVING.includes(r._id.s)) out[String(r._id.p)].reserved += r.sum; });
  Object.values(out).forEach((w) => {
    w.payable = Math.max(0, w.approved - w.reserved);
    w.approvedTotal = w.approved + w.paid;
    w.lifetime = w.pending + w.approved + w.paid;
  });
  return Array.isArray(partnerIds) ? out : out[String(ids[0])];
};

/** Spiritual-impact metrics, intentionally independent from cash commission. */
export const impactFor = async (partnerIds, period = 'all') => {
  const ids = partnerIds.map(oid);
  const since = period === 'all' ? '0000-00-00' : dayStr(-(Number(period) - 1));
  const d7 = dayStr(-7); const d30 = dayStr(-30);
  const rows = await ReferralRecord.aggregate([
    { $match: { partnerId: { $in: ids }, status: 'registered', eligibility: { $nin: ['rejected', 'reversed'] } } },
    { $group: {
      _id: '$partnerId',
      users: { $sum: { $cond: [{ $gte: ['$regAt', since] }, 1, 0] } },
      first: { $sum: { $cond: [{ $and: [{ $gte: ['$regAt', since] }, '$firstActivity'] }, 1, 0] } },
      active: { $sum: { $cond: [{ $and: [{ $gte: ['$regAt', since] }, '$activeNow'] }, 1, 0] } },
      sessions: { $sum: { $cond: [{ $gte: ['$regAt', since] }, '$sessions', 0] } },
      minutes: { $sum: { $cond: [{ $gte: ['$regAt', since] }, '$minutes', 0] } },
      e7: { $sum: { $cond: [{ $lte: ['$regAt', d7] }, 1, 0] } },
      r7: { $sum: { $cond: [{ $and: [{ $lte: ['$regAt', d7] }, { $gt: ['$sessions', 2] }] }, 1, 0] } },
      e30: { $sum: { $cond: [{ $lte: ['$regAt', d30] }, 1, 0] } },
      r30: { $sum: { $cond: [{ $and: [{ $lte: ['$regAt', d30] }, '$activeNow'] }, 1, 0] } },
    } },
  ]);
  const out = {};
  ids.forEach((i) => { out[String(i)] = { users: 0, first: 0, active: 0, sessions: 0, minutes: 0, ret7: 0, ret30: 0, score: 0 }; });
  rows.forEach((r) => {
    const ret7 = r.e7 ? (r.r7 / r.e7) * 100 : 0; const ret30 = r.e30 ? (r.r30 / r.e30) * 100 : 0;
    out[String(r._id)] = { users: r.users, first: r.first, active: r.active, sessions: r.sessions, minutes: r.minutes, ret7, ret30,
      score: Math.round(r.active * 4 + r.first * 2 + r.sessions * 0.5 + r.minutes / 60 + ret30 * 2) };
  });
  return out;
};

export const leaderboardFor = async (period) => {
  const partners = await ReferralPartner.find({ status: 'approved' }).lean();
  const impact = await impactFor(partners.map((p) => p._id), period);
  return partners.map((p) => ({ partner: { id: String(p._id), name: p.name, org: p.org, initials: initials(p.name) }, ...impact[String(p._id)] }))
    .sort((a, b) => b.score - a.score).map((r, i) => ({ ...r, rank: i + 1 }));
};

export const logAudit = (req, action, entity, detail) => Audit.create({
  actor: req.staff?.name || req.partner?.name || 'system', role: req.staff ? ROLE_LABELS[normalizeRole(req.staff.role)] : 'Partner',
  action, entity: String(entity), detail, ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
});

export { RULES };
