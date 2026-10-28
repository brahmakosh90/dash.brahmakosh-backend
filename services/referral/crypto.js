// AES-256-GCM encryption for payout account numbers.
// Key comes from REFERRAL_PAYOUT_KEY and falls back to a key derived from JWT_SECRET.
import crypto from 'crypto';

const key = () => crypto.createHash('sha256').update(process.env.REFERRAL_PAYOUT_KEY || `referral:${process.env.JWT_SECRET}`).digest();

export const encrypt = (plain) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
};

export const decrypt = (blob) => {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
};
