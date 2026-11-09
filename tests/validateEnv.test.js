import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { validateEnv, getJwtSecretProblem, assertEnv } from '../config/validateEnv.js';

const good = () => ({
  NODE_ENV: 'production',
  JWT_SECRET: crypto.randomBytes(48).toString('hex'),
  MONGODB_URI: 'mongodb://localhost/x',
  STRIPE_SECRET_KEY_PROD: 'sk_live_x',
  AWS_ACCESS_KEY_ID: 'AKIAX',
});

test('valid production env passes', () => assert.deepEqual(validateEnv(good()), []));

test('rejects the known default placeholder', () => {
  const env = { ...good(), JWT_SECRET: 'your-super-secret-jwt-key-change-this-in-production-to-a-strong-random-string' };
  assert.match(validateEnv(env)[0], /placeholder/);
});

test('rejects short secrets in production', () => {
  assert.match(validateEnv({ ...good(), JWT_SECRET: 'abc123' })[0], /at least 32/);
});

test('short secret tolerated outside production, missing is not', () => {
  assert.deepEqual(validateEnv({ NODE_ENV: 'development', JWT_SECRET: 'short', MONGODB_URI: 'x' }), []);
  assert.ok(validateEnv({ NODE_ENV: 'development', MONGODB_URI: 'x' }).some((e) => /JWT_SECRET is missing/.test(e)));
});

test('lists every missing variable at once', () => {
  const errors = validateEnv({ NODE_ENV: 'production' });
  for (const name of ['JWT_SECRET', 'MONGODB_URI', 'STRIPE_SECRET_KEY_PROD', 'AWS_ACCESS_KEY_ID']) {
    assert.ok(errors.some((e) => e.includes(name)), `${name} should be reported`);
  }
});

test('assertEnv exits with code 1 on failure', () => {
  let code = null;
  const orig = console.error;
  console.error = () => {};
  assertEnv({ NODE_ENV: 'production' }, (c) => { code = c; });
  console.error = orig;
  assert.equal(code, 1);
});

test('getJwtSecretProblem accepts a strong secret', () => {
  assert.equal(getJwtSecretProblem(crypto.randomBytes(32).toString('hex')), null);
});
