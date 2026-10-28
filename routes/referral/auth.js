import express from 'express';
import rateLimit from 'express-rate-limit';
import Admin from '../../models/Admin.js';
import ReferralPartner from '../../models/referral/ReferralPartner.js';
import ReferralStaff from '../../models/referral/ReferralStaff.js';
import { signPartnerToken, signStaffToken, partnerAuth, staffAuth } from '../../middleware/referralAuth.js';
import { ROLE_LABELS, normalizeRole } from '../../services/referral/rules.js';
import { serializePartner } from '../../services/referral/service.js';

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many attempts. Try again later.' } });
const fail = (res, status, message) => res.status(status).json({ success: false, message });

// Partner application. Accounts stay `pending` until an admin approves them.
router.post('/register', limiter, async (req, res) => {
  try {
    const { name, org, email, password, phone, country, audience, bio } = req.body || {};
    if (!name?.trim() || !email || !/^\S+@\S+\.\S+$/.test(email)) return fail(res, 400, 'Name and a valid email are required.');
    if (!password || password.length < 8) return fail(res, 400, 'Password must be at least 8 characters.');
    if (await ReferralPartner.exists({ email: email.toLowerCase() })) return fail(res, 409, 'An application with this email already exists.');
    const p = await ReferralPartner.create({ name, org, email, password, phone, country, audience, bio: (bio || '').slice(0, 600) });
    res.status(201).json({ success: true, message: 'Application submitted. We will review it shortly.', data: { token: signPartnerToken(p._id), partner: serializePartner(p) } });
  } catch (e) { fail(res, 500, e.message); }
});

router.post('/login', limiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return fail(res, 400, 'Email and password are required.');
    const p = await ReferralPartner.findOne({ email: String(email).toLowerCase() }).select('+password');
    if (!p || !(await p.comparePassword(password))) return fail(res, 401, 'Invalid credentials.');
    res.json({ success: true, data: { token: signPartnerToken(p._id), partner: serializePartner(p) } });
  } catch (e) { fail(res, 500, e.message); }
});

router.get('/me', partnerAuth, (req, res) => res.json({ success: true, data: { partner: serializePartner(req.partner) } }));

// Staff sign-in. Accepts referral staff accounts and existing Admin / Super Admin accounts (read-only lookup).
router.post('/admin/login', limiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return fail(res, 400, 'Email and password are required.');
    const mail = String(email).toLowerCase();
    let identity = null;
    const staff = await ReferralStaff.findOne({ email: mail }).select('+password');
    if (staff) {
      if (!(await staff.comparePassword(password))) return fail(res, 401, 'Invalid credentials.');
      if (!staff.isActive) return fail(res, 401, 'Account is inactive.');
      identity = { id: staff._id, source: 'staff', name: staff.name, role: staff.role };
    } else {
      const admin = await Admin.findOne({ email: mail, role: { $in: ['super_admin', 'admin'] } });
      if (!admin || !(await admin.comparePassword(password))) return fail(res, 401, 'Invalid credentials.');
      if (!admin.isActive || (admin.role === 'admin' && !admin.loginApproved)) return fail(res, 401, 'Account is inactive or not approved.');
      identity = { id: admin._id, source: 'admin', name: admin.email, role: normalizeRole(admin.role) };
    }
    res.json({ success: true, data: { token: signStaffToken(identity.id, identity.source), staff: { name: identity.name, email: mail, role: identity.role, roleLabel: ROLE_LABELS[identity.role] } } });
  } catch (e) { fail(res, 500, e.message); }
});

router.get('/admin/me', staffAuth, (req, res) => res.json({ success: true, data: { staff: { ...req.staff, role: normalizeRole(req.staff.role), roleLabel: ROLE_LABELS[normalizeRole(req.staff.role)] } } }));

export default router;
