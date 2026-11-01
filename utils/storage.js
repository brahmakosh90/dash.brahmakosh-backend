/**
 * utils/storage.js
 * Smart storage wrapper - routes uploads to S3, R2, or both
 * based on AppSettings.storageMode
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { uploadToR2, getR2Object, deleteFromR2, generateR2UploadUrl } from './r2.js';
import { extractS3KeyFromUrl } from './s3.js';
import AppSettings from '../models/AppSettings.js';

// Re-export extractS3KeyFromUrl so routes only need to import from storage.js
export { extractS3KeyFromUrl };

// ─── S3 Client ───────────────────────────────────────────────────────────────
const s3Client = new S3Client({
  // SDK >= 3.729 adds an empty-body CRC32 to presigned PUT URLs, which makes browser uploads fail; only checksum when required
  requestChecksumCalculation: 'WHEN_REQUIRED',
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const S3_BUCKET = process.env.AWS_BUCKET_NAME;

// Cache storageMode for 60 seconds to avoid DB hit on every upload
let _cachedMode = null;
let _cacheTime = 0;

const getStorageMode = async () => {
  const now = Date.now();
  if (_cachedMode && now - _cacheTime < 60000) return _cachedMode;
  try {
    const settings = await AppSettings.getSettings();
    _cachedMode = settings.storageMode || 'r2_only';
    _cacheTime = now;
    return _cachedMode;
  } catch {
    return 'r2_only';
  }
};

// Call this when storageMode is changed from dashboard to bust cache
export const bustStorageModeCache = () => {
  _cachedMode = null;
  _cacheTime = 0;
};

// ─── Upload Buffer ────────────────────────────────────────────────────────────
/**
 * Upload a buffer to storage based on current storageMode
 * Returns { key, url, r2Key? }
 */
export const uploadBuffer = async (buffer, key, contentType) => {
  const mode = await getStorageMode();

  if (mode === 'r2_only') {
    await uploadToR2(key, buffer, contentType);
    return { key, url: null, storage: 'r2' };
  }

  if (mode === 's3_only') {
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    });
    await s3Client.send(command);
    const url = `https://${S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    return { key, url, storage: 's3' };
  }

  // both: S3 first (fast response), R2 async backup
  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });
  await s3Client.send(command);
  const url = `https://${S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

  // R2 backup async - don't await, don't block response
  uploadToR2(key, buffer, contentType).catch((err) =>
    console.error('[Storage] R2 backup failed for key:', key, err.message)
  );

  return { key, url, storage: 'both' };
};

// ─── Upload File (multer file object) ────────────────────────────────────────
export const uploadFile = async (file, folder = '') => {
  const cleanFileName = file.originalname
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .toLowerCase();
  const key = folder ? `${folder}/${Date.now()}-${cleanFileName}` : `${Date.now()}-${cleanFileName}`;
  return uploadBuffer(file.buffer, key, file.mimetype);
};

// ─── Get Presigned URL ────────────────────────────────────────────────────────
/**
 * Get a presigned URL for reading a file
 * Tries R2 first if mode is r2_only or both, falls back to S3
 */
// A presigned URL differs on every call (it embeds the signing time), so browsers and the app could never
// cache images and re-downloaded them on every list load. Reuse one signed URL per key until half of its
// life is gone (max 12h): a stable URL is cacheable, and callers always get at least half the TTL left.
const SIGNED_URL_CACHE_MAX = 5000;
const SIGNED_URL_REUSE_MAX_MS = 12 * 60 * 60 * 1000;
const signedUrlCache = new Map(); // "mode|expiresIn|key" -> { url, reuseUntil }

const signUrlUncached = async (mode, key, expiresIn) => {
  if (mode === 'r2_only' || mode === 'both') {
    try {
      return await getR2Object(key, expiresIn);
    } catch (err) {
      if (mode === 'r2_only') throw err;
      // fallback to S3 if both mode and R2 fails
    }
  }

  // S3
  const rawKey = key.startsWith('http') ? new URL(key).pathname.substring(1) : key;
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: decodeURIComponent(rawKey),
    ResponseContentDisposition: 'inline',
    ResponseCacheControl: 'private, max-age=86400',
  });
  return getSignedUrl(s3Client, command, { expiresIn });
};

export const getPresignedUrl = async (key, expiresIn = 604800) => {
  const mode = await getStorageMode();
  const cacheKey = `${mode}|${expiresIn}|${key}`;
  const hit = signedUrlCache.get(cacheKey);
  if (hit && hit.reuseUntil > Date.now()) return hit.url;

  const url = await signUrlUncached(mode, key, expiresIn);

  if (signedUrlCache.size >= SIGNED_URL_CACHE_MAX) signedUrlCache.delete(signedUrlCache.keys().next().value);
  signedUrlCache.set(cacheKey, { url, reuseUntil: Date.now() + Math.min((expiresIn * 1000) / 2, SIGNED_URL_REUSE_MAX_MS) });
  return url;
};

// ─── Generate Upload URL (presigned PUT) ─────────────────────────────────────
export const generateUploadUrl = async (fileName, contentType, folder) => {
  const mode = await getStorageMode();
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(2, 15);
  const ext = fileName.includes('.') ? fileName.split('.').pop() : 'bin';
  const uniqueName = `${timestamp}_${randomId}.${ext}`;
  const key = folder ? `${folder}/${uniqueName}` : uniqueName;

  if (mode === 'r2_only') {
    // Use the same key for consistency
    const { S3Client: R2S3, PutObjectCommand: R2Put } = await import('@aws-sdk/client-s3');
    const { getSignedUrl: r2SignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const r2 = new R2S3({
      // SDK >= 3.729 adds an empty-body CRC32 to presigned PUT URLs, which makes browser uploads fail; only checksum when required
      requestChecksumCalculation: 'WHEN_REQUIRED',
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY,
        secretAccessKey: process.env.R2_SECRET_KEY,
      },
    });
    const command = new R2Put({ Bucket: process.env.R2_BUCKET, Key: key, ContentType: contentType });
    const uploadUrl = await r2SignedUrl(r2, command, { expiresIn: 3600 });
    return { uploadUrl, key, fileUrl: null };
  }

  // S3 or both
  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ContentType: contentType,
    CacheControl: 'max-age=31536000',
  });
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  const fileUrl = `https://${S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
  return { uploadUrl, key, fileUrl };
};

// ─── Delete ───────────────────────────────────────────────────────────────────
export const deleteFile = async (key) => {
  const mode = await getStorageMode();
  const cleanKey = key.startsWith('http') ? new URL(key).pathname.substring(1) : key;

  if (mode === 'r2_only') {
    await deleteFromR2(cleanKey);
    return;
  }

  if (mode === 's3_only') {
    const command = new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: decodeURIComponent(cleanKey) });
    await s3Client.send(command);
    return;
  }

  // both: delete from both
  await Promise.allSettled([
    deleteFromR2(cleanKey),
    s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: decodeURIComponent(cleanKey) }))
  ]);
};
