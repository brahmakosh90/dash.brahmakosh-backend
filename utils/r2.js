import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';

dotenv.config();

const r2Client = new S3Client({
  // SDK >= 3.729 adds an empty-body CRC32 to presigned PUT URLs, which makes browser uploads fail
  requestChecksumCalculation: 'WHEN_REQUIRED',
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

const R2_BUCKET = process.env.R2_BUCKET;

export const uploadToR2 = async (key, body, contentType) => {
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  });
  await r2Client.send(command);
  return { key };
};

export const getR2Object = async (key, expiresIn = 604800) => {
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ResponseContentDisposition: 'inline',
  });
  return getSignedUrl(r2Client, command, { expiresIn });
};

export const deleteFromR2 = async (key) => {
  const command = new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key });
  await r2Client.send(command);
};

export const generateR2UploadUrl = async (fileName, contentType, folder) => {
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(2, 15);
  const fileExtension = fileName.split('.').pop();
  const uniqueFileName = `${timestamp}_${randomId}.${fileExtension}`;
  const key = folder ? `${folder}/${uniqueFileName}` : uniqueFileName;

  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const uploadUrl = await getSignedUrl(r2Client, command, { expiresIn: 3600 });
  return { uploadUrl, key };
};

export { r2Client };
