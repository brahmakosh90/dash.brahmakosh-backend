// Business rules for the Brahmakosh Referral Partner Portal.
export const RULES = Object.freeze({
  commission: 1, // USD per eligible registration
  minWithdrawal: 50, // USD of approved payable balance
  attributionDays: 30, // days from an eligible referral click
  holdDays: 7, // fraud-check hold before a commission becomes payable
});

export const PERMISSIONS = [
  ['partners.review', 'Review partner applications'],
  ['campaigns.manage', 'Create, approve and pause campaigns'],
  ['commissions.approve', 'Approve or reject commissions'],
  ['withdrawals.approve', 'Approve withdrawals'],
  ['withdrawals.reconcile', 'Reconcile and mark payouts as paid'],
  ['fraud.review', 'Review fraud flags'],
  ['reports.view', 'View performance reports'],
  ['roles.manage', 'Manage roles and permissions'],
  ['audit.view', 'View audit logs'],
];

// Staff roles of the referral module. An existing `admin` account signs in as `ops_admin`, `super_admin` stays `super_admin`.
export const STAFF_ROLES = ['super_admin', 'ops_admin', 'finance', 'fraud_analyst', 'support'];
export const normalizeRole = (role) => (role === 'admin' ? 'ops_admin' : role);

export const DEFAULT_ROLE_PERMISSIONS = {
  super_admin: PERMISSIONS.map((p) => p[0]),
  ops_admin: ['partners.review', 'campaigns.manage', 'commissions.approve', 'reports.view', 'audit.view'],
  finance: ['withdrawals.approve', 'withdrawals.reconcile', 'commissions.approve', 'reports.view', 'audit.view'],
  fraud_analyst: ['fraud.review', 'partners.review', 'reports.view', 'audit.view'],
  support: ['reports.view'],
};

export const ROLE_LABELS = {
  super_admin: 'Super Admin', ops_admin: 'Operations Admin', finance: 'Finance', fraud_analyst: 'Fraud Analyst', support: 'Support',
};

export const dayStr = (offset = 0, base = new Date()) => {
  const d = new Date(base); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
export const ageDays = (s) => daysBetween(s, dayStr(0));
