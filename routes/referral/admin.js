import express from 'express';
import Admin from '../../models/Admin.js';
import ReferralStaff from '../../models/referral/ReferralStaff.js';
import ReferralPartner from '../../models/referral/ReferralPartner.js';
import ReferralCampaign from '../../models/referral/ReferralCampaign.js';
import ReferralDailyStat from '../../models/referral/ReferralDailyStat.js';
import ReferralCommission from '../../models/referral/ReferralCommission.js';
import ReferralWithdrawal from '../../models/referral/ReferralWithdrawal.js';
import { FraudFlag, Audit, RoleConfig, Ticket } from '../../models/referral/ReferralMisc.js';
import { staffAuth, requirePerm, permissionsFor } from '../../middleware/referralAuth.js';
import { RULES, PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, ROLE_LABELS, STAFF_ROLES, normalizeRole, dayStr, ageDays } from '../../services/referral/rules.js';
import { serializePartner, serializeCampaign, serializeWithdrawal, walletFor, impactFor, logAudit, oid, isId, initials, LINK_BASE } from '../../services/referral/service.js';

const router = express.Router();
router.use(staffAuth);
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { fail(res, 500, e.message); } };
const sumStats = (rows) => rows.reduce((a, r) => ({ clicks: a.clicks + r.clicks, installs: a.installs + r.installs, regs: a.regs + r.regs }), { clicks: 0, installs: 0, regs: 0 });
const rate = (a, b) => (b ? (a / b) * 100 : 0);
const statsBy = async (field, match = {}) => {
  const rows = await ReferralDailyStat.aggregate([{ $match: match }, { $group: { _id: `$${field}`, clicks: { $sum: '$clicks' }, installs: { $sum: '$installs' }, regs: { $sum: '$regs' } } }]);
  return Object.fromEntries(rows.map((r) => [String(r._id), { clicks: r.clicks, installs: r.installs, regs: r.regs }]));
};
const ZERO = { clicks: 0, installs: 0, regs: 0 };

router.get('/session', wrap(async (req, res) => {
  const role = normalizeRole(req.staff.role);
  res.json({ success: true, data: { staff: { name: req.staff.name, email: req.staff.email, role, roleLabel: ROLE_LABELS[role], perms: req.staff.perms, source: req.staff.source }, rules: RULES } });
}));

// Change own password. Platform admin accounts are managed in the main admin console, not here.
router.post('/password', wrap(async (req, res) => {
  if (req.staff.source !== 'staff') return fail(res, 400, 'This account is managed in the main admin console. Change its password there.');
  const { current, next } = req.body || {};
  if (!current || !next) return fail(res, 400, 'Enter your current and new password.');
  if (String(next).length < 8) return fail(res, 400, 'New password must be at least 8 characters.');
  if (current === next) return fail(res, 400, 'New password must be different from the current one.');
  const m = await ReferralStaff.findById(req.staff.id).select('+password');
  if (!(await m.comparePassword(current))) return fail(res, 400, 'Current password is incorrect.');
  m.password = next; await m.save();
  await logAudit(req, 'Password changed', m.email, 'Own password updated');
  res.json({ success: true });
}));

/* ------------------------------- overview ------------------------------- */
router.get('/overview', wrap(async (req, res) => {
  const since = dayStr(-29);
  const [partners, tot, daily, top, mix, wd, flags, camps, partnerWallets] = await Promise.all([
    ReferralPartner.find().lean(),
    ReferralDailyStat.aggregate([{ $group: { _id: null, clicks: { $sum: '$clicks' }, installs: { $sum: '$installs' }, regs: { $sum: '$regs' } } }]),
    ReferralDailyStat.aggregate([{ $match: { date: { $gte: since } } }, { $group: { _id: '$date', clicks: { $sum: '$clicks' }, installs: { $sum: '$installs' }, regs: { $sum: '$regs' } } }]),
    statsBy('partnerId', { date: { $gte: since } }),
    ReferralCommission.aggregate([{ $group: { _id: '$status', n: { $sum: 1 }, sum: { $sum: '$amount' } } }]),
    ReferralWithdrawal.aggregate([{ $group: { _id: '$status', n: { $sum: 1 }, sum: { $sum: '$amount' } } }]),
    FraudFlag.countDocuments({ status: 'open' }),
    ReferralCampaign.countDocuments({ status: 'pending_approval' }),
    walletFor((await ReferralPartner.find({ status: { $in: ['approved', 'suspended'] } }).select('_id').lean()).map((p) => p._id)),
  ]);
  const dmap = Object.fromEntries(daily.map((d) => [d._id, d]));
  const series = Array.from({ length: 30 }, (_, i) => { const date = dayStr(-(29 - i)); const d = dmap[date] || ZERO; return { date, clicks: d.clicks, installs: d.installs, regs: d.regs }; });
  const wallets = Object.values(partnerWallets).reduce((a, w) => ({ pending: a.pending + w.pending, payable: a.payable + w.payable, reserved: a.reserved + w.reserved, paid: a.paid + w.paid }), { pending: 0, payable: 0, reserved: 0, paid: 0 });
  const wcount = (s) => wd.find((x) => x._id === s)?.n || 0;
  res.json({ success: true, data: {
    activePartners: partners.filter((p) => p.status === 'approved').length, suspendedPartners: partners.filter((p) => p.status === 'suspended').length,
    totals: tot[0] ? { clicks: tot[0].clicks, installs: tot[0].installs, regs: tot[0].regs } : ZERO, wallets, paidTransfers: wcount('paid'), series,
    queue: { applications: partners.filter((p) => p.status === 'pending').length, campaigns: camps, withdrawalsToApprove: wcount('pending'), transfersToReconcile: wcount('approved') + wcount('processing'), fraudOpen: flags },
    top: partners.filter((p) => p.status === 'approved').map((p) => ({ id: String(p._id), name: p.name, org: p.org, initials: initials(p.name), ...(top[String(p._id)] || ZERO) })).sort((a, b) => b.regs - a.regs).slice(0, 5),
    mix: Object.fromEntries(mix.map((m) => [m._id, m.n])), commissionRecords: mix.reduce((a, m) => a + m.n, 0),
  } });
}));

/* ------------------------------- partners ------------------------------- */
const approvePartner = async (p) => {
  if (!p.code) {
    const base = `BRAHM-${p.name.split(' ')[0].replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 6) || 'PARTNER'}${String(new Date().getFullYear()).slice(2)}`;
    let code = base; let n = 1;
    while (await ReferralPartner.exists({ code }) || await ReferralCampaign.exists({ code })) code = `${base}${++n}`;
    p.code = code;
  }
  p.tier = p.tier === '—' ? 'Bronze' : p.tier; p.joinedAt = p.joinedAt || new Date();
  const hasGeneral = await ReferralCampaign.exists({ partnerId: p._id, general: true });
  if (!hasGeneral) await ReferralCampaign.create({ partnerId: p._id, name: 'Direct referral link', code: p.code, general: true, start: dayStr(0), end: '2099-12-31', status: 'active', approval: 'approved' });
};

const PARTNER_TRANSITIONS = { approved: ['pending', 'suspended'], rejected: ['pending'], suspended: ['approved'] };

const changePartnerStatus = async (req, p, status, note = '') => {
  const was = p.status; p.status = status;
  p.reviewNote = status === 'approved' ? '' : note;
  if (status === 'approved') await approvePartner(p);
  await p.save();
  if (status === 'suspended') await ReferralCampaign.updateMany({ partnerId: p._id, status: 'active' }, { status: 'paused' });
  const verb = { approved: was === 'suspended' ? 'Partner reinstated' : 'Partner approved', rejected: 'Partner application rejected', suspended: 'Partner suspended' }[status];
  await logAudit(req, verb, p._id, `${p.name} (${p.org})${note ? ` · ${note}` : ''}`);
};

router.get('/partners', wrap(async (req, res) => {
  const [partners, stats] = await Promise.all([ReferralPartner.find().sort({ createdAt: -1 }).lean(), statsBy('partnerId')]);
  const active = partners.filter((p) => ['approved', 'suspended'].includes(p.status)).map((p) => p._id);
  const [wallets, impact, flags] = await Promise.all([walletFor(active), impactFor(active), FraudFlag.aggregate([{ $match: { status: 'open' } }, { $group: { _id: '$partnerId', n: { $sum: 1 } } }])]);
  const fmap = Object.fromEntries(flags.map((f) => [String(f._id), f.n]));
  res.json({ success: true, data: { partners: partners.map((p) => {
    const s = stats[String(p._id)] || ZERO; const w = wallets[String(p._id)] || { pending: 0, payable: 0, paid: 0 };
    return { ...serializePartner(p), s: { ...s, conv: rate(s.regs, s.clicks), wallet: { pending: w.pending, payable: w.payable, paid: w.paid }, openFlags: fmap[String(p._id)] || 0, impact: impact[String(p._id)]?.score || 0 } };
  }) } });
}));

router.post('/partners/:id/status', requirePerm('partners.review'), wrap(async (req, res) => {
  const { status } = req.body || {};
  const note = String(req.body?.note || '').trim().slice(0, 300);
  if (!isId(req.params.id) || !PARTNER_TRANSITIONS[status]) return fail(res, 400, 'Invalid request.');
  if (['rejected', 'suspended'].includes(status) && note.length < 5) return fail(res, 400, 'Add a short reason (shown to the partner).');
  const p = await ReferralPartner.findById(req.params.id);
  if (!p) return fail(res, 404, 'Partner not found.');
  if (!PARTNER_TRANSITIONS[status].includes(p.status)) return fail(res, 409, `Cannot change a partner from ${p.status} to ${status}.`);
  await changePartnerStatus(req, p, status, note);
  res.json({ success: true, data: { partner: serializePartner(p) } });
}));

/* ------------------------------- campaigns ------------------------------ */
router.get('/campaigns', wrap(async (req, res) => {
  const [camps, stats, partners] = await Promise.all([ReferralCampaign.find({ general: { $ne: true } }).sort({ createdAt: -1 }).lean(), statsBy('campaignId'), ReferralPartner.find().select('name').lean()]);
  const pn = Object.fromEntries(partners.map((p) => [String(p._id), p.name]));
  res.json({ success: true, data: { campaigns: camps.map((c) => ({ ...serializeCampaign(c), partnerName: pn[String(c.partnerId)], t: stats[String(c._id)] || ZERO })) } });
}));

router.post('/campaigns', requirePerm('campaigns.manage'), wrap(async (req, res) => {
  const { partnerId, name, code, start, end, cap, rate: r } = req.body || {};
  if (!isId(partnerId) || !(await ReferralPartner.exists({ _id: partnerId, status: 'approved' }))) return fail(res, 400, 'Choose an approved partner.');
  if (!name || name.trim().length < 4) return fail(res, 400, 'Name is required.');
  if (!/^[A-Za-z0-9]{4,14}$/.test(code || '')) return fail(res, 400, 'Code must be 4–14 letters or numbers.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '') || end <= start) return fail(res, 400, 'End must be after start.');
  const rateNum = Number(r ?? RULES.commission);
  if (!(rateNum > 0 && rateNum <= 5)) return fail(res, 400, 'Rate must be between $0.01 and $5.');
  if (await ReferralCampaign.exists({ code: code.toUpperCase() }) || await ReferralPartner.exists({ code: code.toUpperCase() })) return fail(res, 409, 'Code already used.');
  const c = await ReferralCampaign.create({ partnerId, name: name.trim(), code, start, end, cap: Number(cap) || 500, rate: rateNum, status: start > dayStr(0) ? 'scheduled' : 'active', approval: 'approved', channelFocus: 'All channels' });
  await logAudit(req, 'Campaign created', c._id, `${c.name}`);
  res.status(201).json({ success: true, data: { campaign: serializeCampaign(c) } });
}));

const CAMPAIGN_ACTIONS = {
  approve: { from: ['pending_approval'], set: (c) => ({ approval: 'approved', status: c.start > dayStr(0) ? 'scheduled' : 'active' }), audit: 'Campaign approved' },
  reject: { from: ['pending_approval'], set: () => ({ approval: 'rejected', status: 'revoked' }), audit: 'Campaign rejected' },
  pause: { from: ['active', 'scheduled'], set: () => ({ status: 'paused' }), audit: 'Campaign paused' },
  resume: { from: ['paused'], set: () => ({ status: 'active' }), audit: 'Campaign resumed' },
  revoke: { from: ['active', 'scheduled', 'paused'], set: () => ({ status: 'revoked', approval: 'revoked' }), audit: 'Campaign revoked' },
};
router.post('/campaigns/:id/:action', requirePerm('campaigns.manage'), wrap(async (req, res) => {
  const def = CAMPAIGN_ACTIONS[req.params.action];
  if (!def || !isId(req.params.id)) return fail(res, 400, 'Invalid request.');
  const c = await ReferralCampaign.findOne({ _id: req.params.id, general: { $ne: true } });
  if (!c) return fail(res, 404, 'Campaign not found.');
  const cur = serializeCampaign(c).status;
  if (!def.from.includes(cur)) return fail(res, 409, `A ${cur.replace('_', ' ')} campaign cannot be ${req.params.action}d.`);
  Object.assign(c, def.set(c)); await c.save();
  await logAudit(req, def.audit, c._id, c.name);
  res.json({ success: true, data: { campaign: serializeCampaign(c) } });
}));

/* ------------------------------ commissions ----------------------------- */
router.get('/commissions', wrap(async (req, res) => {
  const status = ['pending', 'approved', 'paid', 'rejected', 'reversed'].includes(req.query.status) ? req.query.status : 'pending';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1); const limit = Math.min(100, parseInt(req.query.limit, 10) || 15);
  const q = { status };
  if (req.query.partner && isId(req.query.partner)) q.partnerId = oid(req.query.partner);
  if (req.query.q) q.anon = { $regex: `^${String(req.query.q).replace(/[^A-Za-z0-9-]/g, '')}`, $options: 'i' };
  const [items, total, counts, cleared, partners, camps] = await Promise.all([
    ReferralCommission.find(q).sort({ date: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    ReferralCommission.countDocuments(q),
    ReferralCommission.aggregate([{ $group: { _id: '$status', n: { $sum: 1 }, sum: { $sum: '$amount' } } }]),
    ReferralCommission.countDocuments({ ...q, status: 'pending', date: { $lte: dayStr(-RULES.holdDays) } }),
    ReferralPartner.find().select('name').lean(), ReferralCampaign.find().select('name general').lean(),
  ]);
  const pn = Object.fromEntries(partners.map((p) => [String(p._id), p.name])); const cn = Object.fromEntries(camps.map((c) => [String(c._id), c.general ? 'Direct link' : c.name]));
  res.json({ success: true, data: {
    items: items.map((c) => ({ id: String(c._id), date: c.date, age: ageDays(c.date), partnerId: String(c.partnerId), partner: pn[String(c.partnerId)], anon: c.anon, campaign: cn[String(c.campaignId)], status: c.status, reason: c.reason, amount: c.amount })),
    total, page, limit, holdCleared: cleared, counts: Object.fromEntries(counts.map((c) => [c._id, { n: c.n, sum: c.sum }])),
  } });
}));

router.post('/commissions/review', requirePerm('commissions.approve'), wrap(async (req, res) => {
  const { action, reason = '', ids, holdCleared, partner } = req.body || {};
  if (!['approve', 'reject', 'reverse'].includes(action)) return fail(res, 400, 'Invalid action.');
  if (action !== 'approve' && String(reason).trim().length < 4) return fail(res, 400, 'A reason is required.');
  const from = action === 'reverse' ? 'approved' : 'pending';
  const filter = { status: from };
  if (holdCleared) { filter.date = { $lte: dayStr(-RULES.holdDays) }; if (partner && isId(partner)) filter.partnerId = oid(partner); }
  else if (Array.isArray(ids) && ids.length && ids.length <= 1000 && ids.every(isId)) filter._id = { $in: ids.map(oid) };
  else return fail(res, 400, 'Select commissions to review.');
  if (action === 'approve') filter.date = { ...(filter.date || {}), $lte: dayStr(-RULES.holdDays) }; // fraud hold must have elapsed

  let docs = await ReferralCommission.find(filter).select('_id partnerId amount').lean();
  const requested = Array.isArray(ids) ? ids.length : docs.length;
  if (action === 'reverse') {
    // never reverse money that is already reserved for an open withdrawal
    const byPartner = {}; docs.forEach((d) => { (byPartner[String(d.partnerId)] ||= []).push(d); });
    const wallets = await walletFor(Object.keys(byPartner)); const keep = [];
    Object.entries(byPartner).forEach(([pid, list]) => { let free = wallets[pid].approved - wallets[pid].reserved; list.forEach((d) => { if (free - d.amount >= 0) { keep.push(d); free -= d.amount; } }); });
    docs = keep;
  }
  const set = { approve: { status: 'approved' }, reject: { status: 'rejected', reason: reason.trim() }, reverse: { status: 'reversed', reason: reason.trim() } }[action];
  const r = await ReferralCommission.updateMany({ _id: { $in: docs.map((d) => d._id) }, status: from }, { $set: set });
  const n = r.modifiedCount;
  await logAudit(req, `Commissions ${{ approve: 'approved', reject: 'rejected', reverse: 'reversed' }[action]}`, `${n} records`, reason.trim() || `${n} commission(s) processed`);
  res.json({ success: true, data: { processed: n, skipped: Math.max(0, requested - n) } });
}));

/* ------------------------------- withdrawals ---------------------------- */
router.get('/withdrawals', wrap(async (req, res) => {
  const [list, partners] = await Promise.all([ReferralWithdrawal.find().sort({ createdAt: -1 }).limit(500).lean(), ReferralPartner.find().select('name org').lean()]);
  const pm = Object.fromEntries(partners.map((p) => [String(p._id), p]));
  const wallets = await walletFor([...new Set(list.map((w) => String(w.partnerId)))]);
  const toVerify = await ReferralPartner.find({ 'payout.status': 'pending_verification' }).select('name org payout').lean();
  res.json({ success: true, data: {
    withdrawals: list.map((w) => ({ ...serializeWithdrawal(w), p: { name: pm[String(w.partnerId)]?.name, org: pm[String(w.partnerId)]?.org }, payable: wallets[String(w.partnerId)]?.payable ?? 0 })),
    payoutVerifications: toVerify.map((p) => ({ partnerId: String(p._id), name: p.name, org: p.org, holder: p.payout.holder, bank: p.payout.bank, last4: p.payout.last4, code: p.payout.code, updatedAt: dayStr(0, p.payout.updatedAt) })),
  } });
}));

// Finance confirms changed bank details (e.g. holder name matches the partner) before they can be used for a payout.
router.post('/partners/:id/payout/:decision', requirePerm('withdrawals.approve'), wrap(async (req, res) => {
  const { decision } = req.params;
  if (!isId(req.params.id) || !['verify', 'reject'].includes(decision)) return fail(res, 400, 'Invalid request.');
  const p = await ReferralPartner.findOneAndUpdate({ _id: req.params.id, 'payout.status': 'pending_verification' }, { $set: { 'payout.status': decision === 'verify' ? 'verified' : 'unset' } }, { new: true });
  if (!p) return fail(res, 409, 'No payout details are waiting for verification.');
  await logAudit(req, decision === 'verify' ? 'Payout details verified' : 'Payout details rejected', p._id, `${p.name} · ${p.payout.bank} ••${p.payout.last4}`);
  res.json({ success: true });
}));

const settle = async (partnerId, amount, payoutId) => {
  let left = amount;
  const approved = await ReferralCommission.find({ partnerId, status: 'approved' }).sort({ date: 1, _id: 1 }).select('_id amount').lean();
  const ids = [];
  for (const c of approved) { if (left <= 1e-9) break; ids.push(c._id); left -= c.amount; }
  await ReferralCommission.updateMany({ _id: { $in: ids }, status: 'approved' }, { $set: { status: 'paid', payoutId } });
};

const WD = {
  approve: { perm: 'withdrawals.approve', from: ['pending'], to: 'approved', label: () => 'Approved by Finance', audit: 'Withdrawal approved' },
  process: { perm: 'withdrawals.reconcile', from: ['approved'], to: 'processing', label: () => 'Bank transfer initiated', audit: 'Bank transfer initiated' },
  paid: { perm: 'withdrawals.reconcile', from: ['processing'], to: 'paid', label: (b) => `Paid · ref ${b.reference}`, audit: 'Payout reconciled' },
  reject: { perm: 'withdrawals.approve', from: ['pending', 'approved'], to: 'rejected', label: (b) => `Rejected · ${b.reason}`, audit: 'Withdrawal rejected' },
};
router.post('/withdrawals/:id/:action', wrap(async (req, res) => {
  const def = WD[req.params.action];
  if (!def) return fail(res, 400, 'Invalid action.');
  if (!req.staff.perms.includes(def.perm)) return fail(res, 403, `Your role does not have permission: ${def.perm}`);
  const b = req.body || {}; const set = { status: def.to };
  if (req.params.action === 'paid') {
    if (!/^[A-Za-z0-9-]{8,30}$/.test(b.reference || '')) return fail(res, 400, 'Enter the bank transfer reference (8–30 characters).');
    if (await ReferralWithdrawal.exists({ reference: b.reference })) return fail(res, 409, 'This bank reference is already used on another payout.');
    set.reference = b.reference;
  }
  if (req.params.action === 'reject') { if (String(b.reason || '').trim().length < 5) return fail(res, 400, 'A rejection reason is required.'); set.reason = b.reason.trim(); }
  if (req.params.action === 'approve') set.approvedBy = `${req.staff.name} (${ROLE_LABELS[normalizeRole(req.staff.role)]})`;
  // Conditional update: a stale or duplicate click can never move a request through a step twice.
  const w = await ReferralWithdrawal.findOneAndUpdate({ code: req.params.id, status: { $in: def.from } }, { $set: set, $push: { history: { at: dayStr(0), label: def.label({ ...b, reference: set.reference }) } } }, { new: true });
  if (!w) return fail(res, 409, 'This request is no longer in a state that allows that action.');
  if (def.to === 'paid') await settle(w.partnerId, w.amount, w._id);
  await logAudit(req, def.audit, w.code, req.params.action === 'paid' ? `$${w.amount.toFixed(2)} matched to ${w.reference}` : req.params.action === 'reject' ? w.reason : `$${w.amount.toFixed(2)}`);
  res.json({ success: true, data: { withdrawal: serializeWithdrawal(w) } });
}));

/* -------------------------------- reports ------------------------------- */
router.get('/reports', requirePerm('reports.view'), wrap(async (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30; const since = dayStr(-(days - 1));
  const [pStats, cStats, partners, camps] = await Promise.all([statsBy('partnerId', { date: { $gte: since } }), statsBy('campaignId', { date: { $gte: since } }), ReferralPartner.find({ status: { $in: ['approved', 'suspended'] } }).lean(), ReferralCampaign.find({ general: { $ne: true } }).lean()]);
  const ids = partners.map((p) => p._id); const [wallets, impact] = await Promise.all([walletFor(ids), impactFor(ids)]);
  const pn = Object.fromEntries(partners.map((p) => [String(p._id), p.name]));
  res.json({ success: true, data: {
    partners: partners.map((p) => { const t = pStats[String(p._id)] || ZERO; return { id: String(p._id), name: p.name, org: p.org, status: p.status, ...t, conv: rate(t.regs, t.clicks), earned: t.regs * RULES.commission, payable: wallets[String(p._id)].payable, impact: impact[String(p._id)].score }; }).sort((a, b) => b.regs - a.regs),
    campaigns: camps.map((c) => { const t = cStats[String(c._id)] || ZERO; return { id: String(c._id), name: c.name, partner: pn[String(c.partnerId)] || '—', status: serializeCampaign(c).status, ...t, conv: rate(t.regs, t.clicks), cap: c.cap }; }).filter((r) => r.clicks).sort((a, b) => b.regs - a.regs),
    totals: sumStats(Object.values(pStats)),
  } });
}));

/* --------------------------------- fraud -------------------------------- */
router.get('/fraud', wrap(async (req, res) => {
  const [flags, partners, blocked, selfRef] = await Promise.all([FraudFlag.find().sort({ createdAt: -1 }).lean(), ReferralPartner.find().select('name org status').lean(), ReferralCommission.countDocuments({ status: 'rejected' }), ReferralCommission.countDocuments({ status: 'rejected', reason: /Self-referral/ })]);
  const pm = Object.fromEntries(partners.map((p) => [String(p._id), p]));
  res.json({ success: true, data: { flags: flags.map((f) => ({ id: f.code, partnerId: String(f.partnerId), type: f.type, severity: f.severity, detail: f.detail, related: f.related, detectedAt: f.detectedAt, status: f.status, note: f.note, p: { name: pm[String(f.partnerId)]?.name, org: pm[String(f.partnerId)]?.org, status: pm[String(f.partnerId)]?.status } })), autoBlocked: blocked, selfReferrals: selfRef } });
}));

router.post('/fraud/:id/resolve', requirePerm('fraud.review'), wrap(async (req, res) => {
  const { status, note = '', suspend = false } = req.body || {};
  if (!['under_review', 'confirmed', 'dismissed'].includes(status)) return fail(res, 400, 'Invalid status.');
  if (status !== 'under_review' && String(note).trim().length < 5) return fail(res, 400, 'Add a short review note.');
  const allowed = { under_review: ['open'], confirmed: ['open', 'under_review'], dismissed: ['open', 'under_review'] }[status];
  const f = await FraudFlag.findOneAndUpdate({ code: req.params.id, status: { $in: allowed } }, { $set: { status, ...(note.trim() ? { note: note.trim() } : {}) } }, { new: true });
  if (!f) return fail(res, 409, 'This flag is no longer open for that action.');
  let reversed = 0;
  if (status === 'confirmed') {
    const pend = await ReferralCommission.find({ partnerId: f.partnerId, status: 'pending' }).sort({ date: 1 }).limit(f.related).select('_id').lean();
    reversed = (await ReferralCommission.updateMany({ _id: { $in: pend.map((c) => c._id) }, status: 'pending' }, { $set: { status: 'reversed', reason: `Fraud: ${f.type}` } })).modifiedCount;
    const p = await ReferralPartner.findById(f.partnerId);
    if (suspend && perm(req, 'partners.review') && p.status === 'approved') await changePartnerStatus(req, p, 'suspended');
  }
  await logAudit(req, { confirmed: 'Fraud flag confirmed', dismissed: 'Fraud flag dismissed', under_review: 'Fraud flag under review' }[status], f.code, `${f.type}${reversed ? ` · ${reversed} commissions reversed` : ''}`);
  res.json({ success: true, data: { reversed } });
}));
const perm = (req, p) => req.staff.perms.includes(p);

/* ---------------------------------- roles ------------------------------- */
const listMembers = async () => {
  const [staff, admins] = await Promise.all([ReferralStaff.find().sort({ createdAt: 1 }).lean(), Admin.find({ role: { $in: ['super_admin', 'admin'] } }).select('email role isActive updatedAt').lean()]);
  return [
    ...admins.map((a) => ({ id: String(a._id), source: 'admin', name: a.email, email: a.email, role: normalizeRole(a.role), isActive: !!a.isActive, lastActive: dayStr(0, a.updatedAt) })),
    ...staff.map((m) => ({ id: String(m._id), source: 'staff', name: m.name, email: m.email, role: m.role, isActive: m.isActive, lastActive: dayStr(0, m.updatedAt) })),
  ];
};

router.get('/roles', wrap(async (req, res) => {
  const roles = {}; for (const r of Object.keys(DEFAULT_ROLE_PERMISSIONS)) roles[r] = await permissionsFor(r);
  res.json({ success: true, data: { roles, labels: ROLE_LABELS, perms: PERMISSIONS, members: await listMembers() } });
}));

// Team members. Existing Admin accounts are listed for reference and are managed in the main admin console, not here.
router.post('/staff', requirePerm('roles.manage'), wrap(async (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email || '')) return fail(res, 400, 'Name and a valid email are required.');
  if (!password || password.length < 8) return fail(res, 400, 'Password must be at least 8 characters.');
  if (!STAFF_ROLES.includes(role)) return fail(res, 400, 'Choose a valid role.');
  if (role === 'super_admin' && req.staff.role !== 'super_admin') return fail(res, 403, 'Only a Super Admin can create another Super Admin.');
  const mail = email.toLowerCase();
  if (await ReferralStaff.exists({ email: mail }) || await Admin.exists({ email: mail })) return fail(res, 409, 'A team member with this email already exists.');
  const m = await ReferralStaff.create({ name: name.trim(), email: mail, password, role, createdBy: req.staff.name });
  await logAudit(req, 'Team member added', m.email, `${m.name} as ${ROLE_LABELS[m.role]}`);
  res.status(201).json({ success: true, data: { id: String(m._id) } });
}));

router.patch('/staff/:id', requirePerm('roles.manage'), wrap(async (req, res) => {
  const { role, isActive } = req.body || {};
  if (!isId(req.params.id)) return fail(res, 400, 'Invalid request.');
  if (req.params.id === req.staff.id) return fail(res, 400, 'You cannot change your own role or access.');
  const m = await ReferralStaff.findById(req.params.id);
  if (!m) return fail(res, 404, 'Team member not found.');
  if (role !== undefined) {
    if (!STAFF_ROLES.includes(role)) return fail(res, 400, 'Choose a valid role.');
    if ((role === 'super_admin' || m.role === 'super_admin') && req.staff.role !== 'super_admin') return fail(res, 403, 'Only a Super Admin can change Super Admin roles.');
    m.role = role;
  }
  if (typeof isActive === 'boolean') m.isActive = isActive;
  await m.save();
  await logAudit(req, 'Team member updated', m.email, `${ROLE_LABELS[m.role]} · ${m.isActive ? 'active' : 'deactivated'}`);
  res.json({ success: true });
}));

router.put('/roles/:role/permissions', requirePerm('roles.manage'), wrap(async (req, res) => {
  const { permission, enabled } = req.body || {};
  const role = req.params.role;
  if (!DEFAULT_ROLE_PERMISSIONS[role] || role === 'super_admin') return fail(res, 400, 'This role cannot be edited.');
  if (!PERMISSIONS.some((p) => p[0] === permission) || typeof enabled !== 'boolean') return fail(res, 400, 'Invalid permission.');
  const cur = new Set(await permissionsFor(role)); enabled ? cur.add(permission) : cur.delete(permission);
  await RoleConfig.findOneAndUpdate({ role }, { permissions: [...cur] }, { upsert: true });
  await logAudit(req, 'Role permissions changed', ROLE_LABELS[role], `${enabled ? 'Added' : 'Removed'} “${PERMISSIONS.find((p) => p[0] === permission)[1]}”`);
  res.json({ success: true, data: { permissions: [...cur] } });
}));

/* ---------------------------------- audit ------------------------------- */
router.get('/audit', requirePerm('audit.view'), wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1); const limit = Math.min(100, parseInt(req.query.limit, 10) || 12);
  const q = {};
  if (req.query.role && req.query.role !== 'all') q.role = req.query.role;
  if (req.query.q) { const re = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); q.$or = [{ actor: re }, { action: re }, { entity: re }, { detail: re }]; }
  const [items, total] = await Promise.all([Audit.find(q).sort({ ts: -1 }).skip((page - 1) * limit).limit(limit).lean(), Audit.countDocuments(q)]);
  const f = (d) => `${dayStr(0, d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  res.json({ success: true, data: { items: items.map((a) => ({ id: String(a._id), ts: f(a.ts), actor: a.actor, role: a.role, action: a.action, entity: a.entity, detail: a.detail, ip: a.ip })), total, page, limit } });
}));

export default router;
