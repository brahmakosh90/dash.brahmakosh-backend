import express from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/auth.js';
import { recordClick, recordInstall, recordRegistration, AttributionError } from '../../services/referral/attribution.js';

// Public click tracking (mounted at /api/referral/r) and app-side tracking (mounted at /api/referral/track).
export const clickRouter = express.Router();
export const trackRouter = express.Router();

const limiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many requests.' } });
const fail = (res, e) => (e instanceof AttributionError
  ? res.status(e.status).json({ success: false, code: e.code, message: e.message })
  : res.status(500).json({ success: false, message: 'Could not record this event.' }));

// GET /r/:code?ch=WhatsApp  ->  logs the click, then sends the visitor to the store with the attribution token.
clickRouter.get('/:code', limiter, async (req, res) => {
  const store = process.env.REFERRAL_STORE_URL;
  try {
    const { token, campaign } = await recordClick(req.params.code, req.query.ch);
    if (store) return res.redirect(302, `${store}${store.includes('?') ? '&' : '?'}referrer=${encodeURIComponent(token)}`);
    res.json({ success: true, data: { clickToken: token, campaign } });
  } catch (e) {
    if (store && e instanceof AttributionError) return res.redirect(302, store); // an inactive code must never block the download
    fail(res, e);
  }
});

// POST /track/install  { clickToken, deviceId?, device?, country? }  — first app launch after an install.
trackRouter.post('/install', limiter, async (req, res) => {
  try {
    if (!req.body?.clickToken) throw new AttributionError('clickToken is required.');
    res.status(201).json({ success: true, data: await recordInstall(req.body) });
  } catch (e) { fail(res, e); }
});

// POST /track/register  { installId? | clickToken? | referralCode?, deviceId? }  — called by the app, signed in as the new user.
trackRouter.post('/register', limiter, authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'user') throw new AttributionError('Only app users can be attributed.', 403, 'forbidden');
    const created = req.user.createdAt && Date.now() - new Date(req.user.createdAt).getTime();
    if (created > 48 * 3600 * 1000) throw new AttributionError('Referrals can only be attached within 48 hours of sign-up.', 410, 'signup_too_old');
    res.status(201).json({ success: true, data: await recordRegistration(req.user, req.body || {}) });
  } catch (e) { fail(res, e); }
});
