import jwt from 'jsonwebtoken';
import Admin from '../models/Admin.js';
import ReferralPartner from '../models/referral/ReferralPartner.js';
import ReferralStaff from '../models/referral/ReferralStaff.js';
import { RoleConfig } from '../models/referral/ReferralMisc.js';
import { DEFAULT_ROLE_PERMISSIONS, normalizeRole } from '../services/referral/rules.js';

const secret = () => process.env.JWT_SECRET;

export const signPartnerToken = (id) => jwt.sign({ userId: String(id), role: 'referral_partner' }, secret(), { expiresIn: '7d' });
/** `source` tells staffAuth which collection holds the account: a ReferralStaff user or an existing Admin. */
export const signStaffToken = (id, source) => jwt.sign({ userId: String(id), role: 'referral_staff', source }, secret(), { expiresIn: '12h' });

const bearer = (req) => req.header('Authorization')?.replace('Bearer ', '');

/** Referral partner identity. Pending / rejected partners may only reach routes that do not call requireApproved. */
export const partnerAuth = async (req, res, next) => {
  try {
    const token = bearer(req);
    if (!token) return res.status(401).json({ success: false, message: 'Authentication required.' });
    const decoded = jwt.verify(token, secret());
    if (decoded.role !== 'referral_partner') return res.status(403).json({ success: false, message: 'Not a referral partner token.' });
    const partner = await ReferralPartner.findById(decoded.userId);
    if (!partner) return res.status(401).json({ success: false, message: 'Partner not found.' });
    req.partner = partner;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
};

export const requireApproved = (req, res, next) => {
  if (req.partner.status === 'approved') return next();
  const msg = { pending: 'Your application is awaiting approval.', rejected: 'Your application was not approved.', suspended: 'Your account is suspended.' }[req.partner.status];
  res.status(403).json({ success: false, code: `partner_${req.partner.status}`, message: msg });
};

export const permissionsFor = async (role) => {
  const r = normalizeRole(role);
  if (r === 'super_admin') return DEFAULT_ROLE_PERMISSIONS.super_admin; // super admin can never be locked out
  const cfg = await RoleConfig.findOne({ role: r }).lean();
  return cfg ? cfg.permissions : DEFAULT_ROLE_PERMISSIONS[r] || [];
};

/** Resolve a token's staff identity to { id, name, email, role, source } or null. */
export const loadStaff = async (decoded) => {
  if (decoded.source === 'admin') {
    const a = await Admin.findById(decoded.userId).select('email role isActive').lean();
    if (!a || !a.isActive || !['super_admin', 'admin'].includes(a.role)) return null;
    return { id: String(a._id), name: a.email, email: a.email, role: normalizeRole(a.role), source: 'admin' };
  }
  const s = await ReferralStaff.findById(decoded.userId).lean();
  if (!s || !s.isActive) return null;
  return { id: String(s._id), name: s.name, email: s.email, role: s.role, source: 'staff' };
};

export const staffAuth = async (req, res, next) => {
  try {
    const token = bearer(req);
    if (!token) return res.status(401).json({ success: false, message: 'Authentication required.' });
    const decoded = jwt.verify(token, secret());
    if (decoded.role !== 'referral_staff') return res.status(403).json({ success: false, message: 'Staff access required.' });
    const staff = await loadStaff(decoded);
    if (!staff) return res.status(401).json({ success: false, message: 'Account not found or inactive.' });
    req.staff = { ...staff, perms: await permissionsFor(staff.role) };
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
};

export const requirePerm = (perm) => (req, res, next) => (req.staff.perms.includes(perm)
  ? next()
  : res.status(403).json({ success: false, message: `Your role does not have permission: ${perm}` }));
