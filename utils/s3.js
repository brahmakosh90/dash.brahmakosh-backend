import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';

dotenv.config();

// Validate required environment variables
const requiredEnvVars = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'AWS_BUCKET_NAME'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.warn('⚠️  Missing AWS environment variables:', missingEnvVars);
  console.warn('S3 functionality will not work until these are configured.');
}

const s3Client = new S3Client({
  // SDK >= 3.729 adds an empty-body CRC32 to presigned PUT URLs, which makes browser uploads fail; only checksum when required
  requestChecksumCalculation: 'WHEN_REQUIRED',
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const decodeS3Key = (value) => {
  if (!value || typeof value !== 'string') return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// Generate presigned URL for uploading
export const putobject = async (key, contentType) => {
  try {
    const command = new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    });

    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 }); // 1 hour
    return signedUrl;
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    throw error;
  }
};

// Generate presigned URL for direct browser upload
export const generateUploadUrl = async (fileName, contentType, folder) => {
  try {
    // Generate unique key with timestamp and random ID
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 15);
    const fileExtension = fileName.split('.').pop();
    const uniqueFileName = `${timestamp}_${randomId}.${fileExtension}`;
    const key = folder ? `${folder}/${uniqueFileName}` : uniqueFileName;
    
    const command = new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
      CacheControl: 'max-age=31536000'
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    const fileUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    
    return { uploadUrl, fileUrl, key };
  } catch (error) {
    console.error('Error generating upload URL:', error);
    throw error;
  }
};

// Generate presigned URL for getting/reading an object
export const getobject = async (key, expiresIn = 604800) => {
  try {
    // If key is a URL, extract the key first
    const rawKey = key.startsWith('http') ? extractS3KeyFromUrl(key) : key;
    const actualKey = decodeS3Key(rawKey);
    
    if (!actualKey) {
      throw new Error('Invalid S3 key provided');
    }
    
    const command = new GetObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: actualKey,
      ResponseContentDisposition: 'inline',
      ResponseContentType: actualKey.match(/\.(mp4|webm|ogg)$/i) ? 'video/mp4' : 
                           actualKey.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? 'image/jpeg' : undefined,
      ResponseCacheControl: 'max-age=31536000, public',
      ResponseExpires: new Date(Date.now() + expiresIn * 1000).toISOString()
    });

    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn });
    return signedUrl;
  } catch (error) {
    console.error('Error generating get presigned URL:', error);
    throw error;
  }
};

// Generate presigned URL for a specific bucket and key
export const getobjectFor = async (bucket, key) => {
  try {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: 'inline',
      ResponseContentType: key.endsWith('.txt') ? 'text/plain; charset=utf-8' : undefined,
    });

    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 604800 });
    return signedUrl;
  } catch (error) {
    console.error('Error generating get presigned URL for bucket:', error);
    throw error;
  }
};

// Generate presigned URL for a specific bucket and region
export const getobjectForWithRegion = async (bucket, key, region) => {
  try {
    const regionalClient = new S3Client({
      // SDK >= 3.729 adds an empty-body CRC32 to presigned PUT URLs, which makes browser uploads fail; only checksum when required
      requestChecksumCalculation: 'WHEN_REQUIRED',
      region: region || process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: 'inline',
      ResponseContentType: key.endsWith('.txt') ? 'text/plain; charset=utf-8' : undefined,
    });
    const signedUrl = await getSignedUrl(regionalClient, command, { expiresIn: 604800 });
    return signedUrl;
  } catch (error) {
    console.error('Error generating regional presigned URL:', error);
    throw error;
  }
};

export const deleteObject = async (key) => {
  try {
    const command = new DeleteObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: decodeS3Key(key),
    });

    await s3Client.send(command);
  } catch (error) {
    console.error('Error deleting object:', error);
    throw error;
  }
};

/**
 * Extract S3 key from S3 URL
 * Supports multiple S3 URL formats:
 * - https://bucket.s3.region.amazonaws.com/key
 * - https://bucket.s3.amazonaws.com/key
 * - s3://bucket/key
 */
export const extractS3KeyFromUrl = (url) => {
  if (!url || typeof url !== 'string') {
    return null;
  }
  
  // Handle s3:// protocol
  if (url.startsWith('s3://')) {
    const parts = url.replace('s3://', '').split('/');
    if (parts.length > 1) {
      return decodeS3Key(parts.slice(1).join('/'));
    }
    return null;
  }
  
  // Handle HTTP/HTTPS URLs
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const urlObj = new URL(url);
      // Remove leading slash from pathname
      const key = decodeS3Key(urlObj.pathname.substring(1));
      return key || null;
    } catch (error) {
      console.error('Error parsing S3 URL:', error);
      // Fallback: try to extract key manually
      // Pattern: https://bucket.s3.region.amazonaws.com/key or https://bucket.s3.amazonaws.com/key
      const match = url.match(/s3[.-]([^.]+)\.amazonaws\.com\/(.+)$/);
      if (match && match[2]) {
        return decodeS3Key(match[2]);
      }
      return null;
    }
  }
  
  // If it's already a key (no http:// or s3://), return as-is
  return url;
};

// Upload file directly to S3
export const uploadToS3 = async (file, folder = '') => {
  console.log('=== S3 UPLOAD START ===');
  console.log('File details:', {
    originalname: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
    hasBuffer: !!file.buffer,
    bufferLength: file.buffer?.length
  });
  console.log('AWS Config:', {
    region: process.env.AWS_REGION,
    bucket: process.env.AWS_BUCKET_NAME,
    hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
    hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY
  });
  
  try {
    // Validate required fields
    if (!file || !file.buffer) {
      throw new Error('Invalid file: missing file buffer');
    }
    
    if (!process.env.AWS_BUCKET_NAME) {
      throw new Error('AWS_BUCKET_NAME not configured');
    }
    
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      throw new Error('AWS credentials not configured');
    }
    
    // Clean filename - remove spaces and special characters
    const cleanFileName = file.originalname
      .replace(/\s+/g, '_')  // Replace spaces with underscores
      .replace(/[^a-zA-Z0-9._-]/g, '')  // Remove special characters
      .toLowerCase();
    
    const key = folder ? `${folder}/${Date.now()}-${cleanFileName}` : `${Date.now()}-${cleanFileName}`;
    console.log('Generated S3 key:', key);
    
    const command = new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      CacheControl: 'max-age=31536000',
      // Add metadata for better handling
      Metadata: {
        'uploaded-by': 'brahmkosh-app',
        'upload-timestamp': Date.now().toString()
      }
    });
    console.log('S3 command created, sending...');

    const result = await s3Client.send(command);
    console.log('S3 upload result:', result);
    
    // Return both key and URL for storage
    const fileUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    console.log('Generated file URL:', fileUrl);
    
    return {
      key: key,
      Location: fileUrl,  // Add Location for backward compatibility
      url: fileUrl
    };
  } catch (error) {
    console.error('=== S3 UPLOAD ERROR ===');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error code:', error.code);
    console.error('Error stack:', error.stack);
    throw error;
  }
};

/**
 * Upload a Buffer directly to S3 (for audio, etc.)
 * @param {Buffer} buffer - Raw buffer to upload
 * @param {string} folder - S3 folder prefix (e.g. 'voice-agent-audio')
 * @param {string} filename - Filename with extension (e.g. 'user_123.wav')
 * @param {string} contentType - MIME type (e.g. 'audio/wav', 'audio/mpeg')
 */
export const uploadBufferToS3 = async (buffer, folder, filename, contentType) => {
  if (!process.env.AWS_BUCKET_NAME || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error('AWS not configured');
  }
  const key = folder ? `${folder}/${Date.now()}_${filename}` : `${Date.now()}_${filename}`;
  const command = new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });
  await s3Client.send(command);
  const url = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
  return { key, url };
};

// Delete file from S3 using URL or key
export const deleteFromS3 = async (keyOrUrl) => {
  try {
    let key;
    
    // Check if it's a URL or just a key
    if (keyOrUrl.startsWith('http')) {
      // Extract key from S3 URL
      const url = new URL(keyOrUrl);
      key = decodeS3Key(url.pathname.substring(1)); // Remove leading slash
    } else {
      // It's already a key
      key = decodeS3Key(keyOrUrl);
    }
    
    const command = new DeleteObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
    });

    await s3Client.send(command);
  } catch (error) {
    console.error('Error deleting from S3:', error);
    throw error;
  }
};

export { s3Client };

