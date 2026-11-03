import { getPresignedUrl, extractS3KeyFromUrl } from './storage.js';

// Single place that turns stored media (key and/or old public URL) into a playable, signed URL.
// Mobile endpoints used to return raw documents, whose stored URLs are not readable on a private
// bucket - that is why audio/video came back silent. Every endpoint serving media should use this.

export const MEDIA_URL_TTL_SECONDS = 6 * 60 * 60; // long enough for a full session, short enough to limit sharing

const MEDIA_KINDS = ['video', 'image', 'audio'];

// Hosts whose URLs point into our own buckets and can be re-signed from their path. A URL on any other host
// (YouTube, a third-party CDN...) is already playable as stored: turning its path into a "key" and signing it
// replaced it with a URL to an object that does not exist, so the track played silence.
const OWN_HOST_SUFFIXES = ['.amazonaws.com', '.r2.cloudflarestorage.com', '.r2.dev', '.brahmakosh.com'];

const ownHosts = () => {
  const hosts = new Set();
  for (const v of [process.env.R2_ENDPOINT, process.env.R2_PUBLIC_URL, ...(process.env.MEDIA_CDN_HOSTS || '').split(',')]) {
    const raw = String(v || '').trim();
    if (!raw) continue;
    try { hosts.add(new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase()); } catch { /* ignore bad env value */ }
  }
  return hosts;
};

export const isOwnStorageUrl = (url) => {
  if (typeof url !== 'string') return false;
  if (url.startsWith('s3://')) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return OWN_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) || ownHosts().has(host);
  } catch {
    return false;
  }
};

const signKey = async (key, ttl) => {
  try {
    return await getPresignedUrl(key, ttl);
  } catch (err) {
    console.error(`[mediaUrls] Could not sign "${key}":`, err.message);
    return null;
  }
};

/**
 * Returns a plain object where `<kind>Url` is a fresh signed URL for each of `kinds`
 * (resolved from `<kind>Key`, or from the old stored `<kind>Url`). If signing fails the
 * original URL is kept, so one bad asset never breaks a whole list.
 */
export const withSignedMedia = async (doc, kinds = MEDIA_KINDS, ttl = MEDIA_URL_TTL_SECONDS) => {
  const obj = typeof doc?.toObject === 'function' ? doc.toObject() : { ...doc };
  await Promise.all(
    kinds.map(async (kind) => {
      const key = obj[`${kind}Key`] || (isOwnStorageUrl(obj[`${kind}Url`]) ? extractS3KeyFromUrl(obj[`${kind}Url`]) : null);
      if (!key) return;
      const signed = await signKey(key, ttl);
      if (signed) obj[`${kind}Url`] = signed;
    })
  );
  return obj;
};

/**
 * Signs a single stored value that may be a storage key, a URL of our own bucket, or a third-party URL
 * (Archive.org, Wikimedia, YouTube...). Third-party URLs are playable as stored and are returned untouched;
 * signing them produced a link to a non-existent object. Never throws: on failure the stored value is kept.
 */
export const signStoredMedia = async (value, ttl = MEDIA_URL_TTL_SECONDS) => {
  if (typeof value !== 'string' || !value.trim()) return value;
  const v = value.trim();
  if (/^https?:\/\//i.test(v) && !isOwnStorageUrl(v)) return v;
  return (await signKey(v, ttl)) || value;
};

/** Batch version for arbitrary keys: returns { [key]: signedUrl | null } */
export const signKeys = async (keys, ttl = MEDIA_URL_TTL_SECONDS) => {
  const unique = [...new Set(keys.filter((k) => typeof k === 'string' && k.trim()))];
  const entries = await Promise.all(unique.map(async (k) => [k, await signKey(k, ttl)]));
  return Object.fromEntries(entries);
};
