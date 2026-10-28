// Attribution pipeline: referral click -> verified install -> completed registration -> pending commission.
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import ReferralPartner from '../../models/referral/ReferralPartner.js';
import ReferralCampaign from '../../models/referral/ReferralCampaign.js';
import ReferralDailyStat from '../../models/referral/ReferralDailyStat.js';
import ReferralRecord from '../../models/referral/ReferralRecord.js';
import ReferralCommission from '../../models/referral/ReferralCommission.js';
import { FraudFlag, nextCode } from '../../models/referral/ReferralMisc.js';
import { RULES, dayStr, ageDays } from './rules.js';
import { effectiveStatus } from './service.js';

export class AttributionError extends Error {
  constructor(message, status = 400, code = 'invalid') { super(message); this.status = status; this.code = code; }
}

const secret = () => process.env.JWT_SECRET;
const digits = (v) => String(v || '').replace(/\D/g, '');
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const anonId = (userId) => `U-${crypto.createHash('sha256').update(`${userId}:${secret()}`).digest('hex').slice(0, 6).toUpperCase()}`;
export const CHANNELS = ['WhatsApp', 'Instagram', 'YouTube', 'Telegram', 'Facebook', 'Direct link', 'Email'];

const bump = (partnerId, campaignId, inc) => ReferralDailyStat.updateOne(
  { campaignId, date: dayStr(0) }, { $setOnInsert: { partnerId }, $inc: inc }, { upsert: true },
);

/** Look a code up and make sure the partner and campaign may earn right now. Throws AttributionError otherwise. */
export const resolveCode = async (code) => {
  const campaign = await ReferralCampaign.findOne({ code: String(code || '').toUpperCase() });
  if (!campaign) throw new AttributionError('Unknown referral code.', 404, 'unknown_code');
  const partner = await ReferralPartner.findById(campaign.partnerId);
  if (!partner || partner.status !== 'approved') throw new AttributionError('This referral is not active.', 410, 'partner_inactive');
  if (effectiveStatus(campaign) !== 'active') throw new AttributionError('This campaign is not active.', 410, 'campaign_inactive');
  return { campaign, partner };
};

const ensureCapacity = async (campaign) => {
  if (campaign.general || !campaign.cap) return;
  const [{ regs = 0 } = {}] = await ReferralDailyStat.aggregate([{ $match: { campaignId: campaign._id } }, { $group: { _id: null, regs: { $sum: '$regs' } } }]);
  if (regs >= campaign.cap) throw new AttributionError('This campaign has reached its limit.', 410, 'campaign_limit_reached');
};

/* ------------------------------ click ------------------------------ */
export const recordClick = async (code, channel) => {
  const { campaign, partner } = await resolveCode(code);
  await ensureCapacity(campaign);
  await bump(partner._id, campaign._id, { clicks: 1 });
  const ch = CHANNELS.includes(channel) ? channel : 'Direct link';
  const token = jwt.sign({ t: 'ref', cid: String(campaign._id), pid: String(partner._id), at: dayStr(0), ch }, secret(), { expiresIn: `${RULES.attributionDays}d` });
  return { token, campaign: { name: campaign.name, code: campaign.code } };
};

const readToken = (token) => {
  try {
    const d = jwt.verify(token, secret());
    if (d.t !== 'ref') throw new Error('type');
    if (ageDays(d.at) > RULES.attributionDays) throw new AttributionError('The referral link has expired (30-day attribution window).', 410, 'window_expired');
    return d;
  } catch (e) {
    if (e instanceof AttributionError) throw e;
    throw new AttributionError('Invalid or expired referral token.', 400, 'invalid_token');
  }
};

/* ----------------------------- install ----------------------------- */
export const recordInstall = async ({ clickToken, deviceId, device, country }) => {
  const t = readToken(clickToken);
  const campaign = await ReferralCampaign.findById(t.cid); const partner = campaign && await ReferralPartner.findById(t.pid);
  if (!campaign || !partner || partner.status !== 'approved') throw new AttributionError('This referral is not active.', 410, 'partner_inactive');
  const deviceHash = deviceId ? hash(deviceId) : null;
  if (deviceHash) { // the same device installing twice must not count twice
    const dup = await ReferralRecord.findOne({ deviceHash, campaignId: campaign._id }).select('_id');
    if (dup) return { installId: String(dup._id), duplicate: true };
  }
  const rec = await ReferralRecord.create({
    partnerId: partner._id, campaignId: campaign._id, anon: `U-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, deviceHash,
    channel: t.ch, device: device === 'iOS' ? 'iOS' : 'Android', country: String(country || '').slice(0, 2).toUpperCase() || undefined,
    clickAt: t.at, installAt: dayStr(0), status: 'installed', eligibility: 'awaiting',
  });
  await bump(partner._id, campaign._id, { installs: 1 });
  return { installId: String(rec._id), duplicate: false };
};

/* --------------------------- registration -------------------------- */
const REJECT = { self: 'Self-referral blocked', device: 'Duplicate device detected' };

/** Raises a fraud flag when a partner collects several automatic rejections of one kind in a day. */
const maybeFlag = async (partnerId, reason, type) => {
  const n = await ReferralCommission.countDocuments({ partnerId, status: 'rejected', reason, date: dayStr(0) });
  if (n < 3) return;
  const open = await FraudFlag.exists({ partnerId, type, status: { $in: ['open', 'under_review'] } });
  if (open) return;
  await FraudFlag.create({ code: await nextCode('FR', 300), partnerId, type, severity: type.startsWith('Self') ? 'high' : 'medium', detail: `${n} registrations were automatically rejected today: ${reason.toLowerCase()}.`, related: n, detectedAt: dayStr(0) });
};

/**
 * Attribute a freshly registered app user to a referral. Safe to call more than once per user.
 * `user` is the authenticated app user (id, email, mobile, createdAt).
 */
export const recordRegistration = async (user, { installId, clickToken, referralCode, deviceId }) => {
  const existing = await ReferralRecord.findOne({ userId: user._id }).select('status eligibility');
  if (existing) return { attributed: true, status: existing.eligibility, duplicate: true };

  let rec = null; let campaign; let partner; let clickAt = dayStr(0); let channel = 'Direct link'; let countInstall = false;
  const deviceHash = deviceId ? hash(deviceId) : null;

  if (installId && /^[a-f\d]{24}$/i.test(installId)) {
    rec = await ReferralRecord.findOne({ _id: installId, status: 'installed' }).select('+deviceHash');
    if (!rec) throw new AttributionError('Install not found or already used.', 404, 'install_not_found');
    campaign = await ReferralCampaign.findById(rec.campaignId); partner = await ReferralPartner.findById(rec.partnerId);
    clickAt = rec.clickAt; channel = rec.channel;
  } else if (clickToken) {
    const t = readToken(clickToken);
    campaign = await ReferralCampaign.findById(t.cid); partner = campaign && await ReferralPartner.findById(t.pid);
    clickAt = t.at; channel = t.ch; countInstall = true;
  } else if (referralCode) {
    ({ campaign, partner } = await resolveCode(referralCode)); countInstall = true; // code typed by the user: no click to date from
  } else throw new AttributionError('A referral code, click token or install id is required.');

  if (!campaign || !partner || partner.status !== 'approved') throw new AttributionError('This referral is not active.', 410, 'partner_inactive');
  if (effectiveStatus(campaign) !== 'active') throw new AttributionError('This campaign is not active.', 410, 'campaign_inactive');
  if (ageDays(clickAt) > RULES.attributionDays) throw new AttributionError('The 30-day attribution window has passed.', 410, 'window_expired');
  await ensureCapacity(campaign);

  // Fraud checks. Rejected registrations are still recorded so they stay visible and auditable.
  let eligibility = 'in_review'; let reason = '';
  const sameEmail = partner.email && user.email && partner.email.toLowerCase() === String(user.email).toLowerCase();
  const samePhone = partner.phone && user.mobile && digits(partner.phone).length >= 8 && digits(partner.phone).slice(-10) === digits(user.mobile).slice(-10);
  if (sameEmail || samePhone) { eligibility = 'rejected'; reason = REJECT.self; }
  else if (deviceHash && await ReferralRecord.exists({ deviceHash, status: 'registered', userId: { $ne: user._id } })) { eligibility = 'rejected'; reason = REJECT.device; }

  try { return await persistRegistration({ user, rec, partner, campaign, channel, clickAt, deviceHash, eligibility, reason, countInstall }); }
  catch (e) { if (e.code === 11000) return { attributed: true, status: 'in_review', duplicate: true }; throw e; } // concurrent call for the same user
};

const persistRegistration = async ({ user, rec: existingRec, partner, campaign, channel, clickAt, deviceHash, eligibility, reason, countInstall }) => {
  let rec = existingRec;
  const fields = { userId: user._id, status: 'registered', regAt: dayStr(0), eligibility, reason, ...(deviceHash && !rec ? { deviceHash } : {}) };
  if (rec) { Object.assign(rec, fields); await rec.save(); }
  else rec = await ReferralRecord.create({ partnerId: partner._id, campaignId: campaign._id, anon: anonId(user._id), channel, device: 'Android', clickAt, installAt: dayStr(0), ...fields });

  await ReferralCommission.create({
    partnerId: partner._id, recordId: rec._id, anon: rec.anon, campaignId: campaign._id, date: dayStr(0), amount: campaign.rate ?? RULES.commission,
    status: eligibility === 'rejected' ? 'rejected' : 'pending', reason,
  });
  await bump(partner._id, campaign._id, { regs: 1, ...(countInstall ? { installs: 1 } : {}) });
  if (eligibility === 'rejected') await maybeFlag(partner._id, reason, reason === REJECT.self ? 'Self-referral pattern' : 'Duplicate device registrations');
  return { attributed: true, status: eligibility };
};
