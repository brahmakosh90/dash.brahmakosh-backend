// Startup environment validation. Pure functions (no side effects) so they can be unit tested.

export const MIN_JWT_SECRET_LENGTH = 32;

// Known default / placeholder secrets. Matching is case-insensitive and on substrings,
// so "your-super-secret-jwt-key-change-this-..." and trivial variants are all rejected.
const PLACEHOLDER_FRAGMENTS = [
  'your-super-secret',
  'change-this',
  'changeme',
  'change_me',
  'your-secret',
  'your_secret',
  'secret-key',
  'placeholder',
  'replace-me',
  'replace_me',
  'example',
];

const PLACEHOLDER_EXACT = new Set(['secret', 'jwt_secret', 'jwtsecret', 'password', 'default', 'test', '12345678901234567890123456789012']);

/** Returns a human readable problem string, or null when the secret is acceptable. */
export const getJwtSecretProblem = (secret, { label = 'JWT_SECRET' } = {}) => {
  if (!secret || typeof secret !== 'string' || !secret.trim()) return `${label} is missing`;
  const lower = secret.trim().toLowerCase();
  if (PLACEHOLDER_EXACT.has(lower) || PLACEHOLDER_FRAGMENTS.some((f) => lower.includes(f))) {
    return `${label} is a known default/placeholder value`;
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    return `${label} must be at least ${MIN_JWT_SECRET_LENGTH} characters (got ${secret.length})`;
  }
  return null;
};

/**
 * Validate the environment. Returns an array of error strings (empty = OK).
 * Strict checks (placeholder secrets, provider keys) apply in production; JWT_SECRET
 * presence is always required.
 */
export const validateEnv = (env = process.env) => {
  const errors = [];
  const isProd = env.NODE_ENV === 'production';

  const jwtProblem = getJwtSecretProblem(env.JWT_SECRET);
  if (jwtProblem) {
    // Outside production only a missing secret is fatal (dev .env files often use short secrets).
    if (isProd || !env.JWT_SECRET) errors.push(jwtProblem);
  }
  if (env.JWT_SECRET_PREVIOUS) {
    const prevProblem = getJwtSecretProblem(env.JWT_SECRET_PREVIOUS, { label: 'JWT_SECRET_PREVIOUS' });
    if (prevProblem && isProd) errors.push(prevProblem);
  }

  if (!env.MONGODB_URI && !env.MONGO_URI) errors.push('MONGODB_URI is missing');

  if (isProd) {
    if (!env.STRIPE_SECRET_KEY_PROD && !env.STRIPE_SECRET_KEY) {
      errors.push('STRIPE_SECRET_KEY_PROD is missing');
    }
    if (!env.AWS_ACCESS_KEY_ID) errors.push('AWS_ACCESS_KEY_ID is missing');
  }

  return errors;
};

/** Validate and terminate the process with a clear message listing every problem. */
export const assertEnv = (env = process.env, exit = (code) => process.exit(code)) => {
  const errors = validateEnv(env);
  if (errors.length) {
    console.error('\n[Startup] FATAL: invalid environment configuration:');
    errors.forEach((e) => console.error(`  - ${e}`));
    console.error('[Startup] Fix the variables above and restart.\n');
    exit(1);
  }
  return errors;
};
