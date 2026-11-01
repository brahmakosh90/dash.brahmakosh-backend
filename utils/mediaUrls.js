import { getPresignedUrl, extractS3KeyFromUrl } from './storage.js';

// Single place that turns stored media (key and/or old public URL) into a playable, signed URL.
// Mobile endpoints used to return raw documents, whose stored URLs are not readable on a private
// bucket - that is why audio/video came back silent. Every endpoint serving media should use this.

export const MEDIA_URL_TTL_SECONDS = 6 * 60 * 60; // long enough for a full session, short enough to limit sharing

const MEDIA_KINDS = ['video', 'image', 'audio'];

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
      const key = obj[`${kind}Key`] || (obj[`${kind}Url`] ? extractS3KeyFromUrl(obj[`${kind}Url`]) : null);
      if (!key) return;
      const signed = await signKey(key, ttl);
      if (signed) obj[`${kind}Url`] = signed;
    })
  );
  return obj;
};

/** Batch version for arbitrary keys: returns { [key]: signedUrl | null } */
export const signKeys = async (keys, ttl = MEDIA_URL_TTL_SECONDS) => {
  const unique = [...new Set(keys.filter((k) => typeof k === 'string' && k.trim()))];
  const entries = await Promise.all(unique.map(async (k) => [k, await signKey(k, ttl)]));
  return Object.fromEntries(entries);
};
