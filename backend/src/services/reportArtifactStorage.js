'use strict';

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const SIGNED_URL_TTL_SECONDS = 15 * 60;
let client = null;

function getS3Client() {
  if (!process.env.REPORTS_S3_BUCKET) {
    const error = new Error('REPORTS_S3_BUCKET is required for asynchronous reports');
    error.code = 'REPORT_STORAGE_UNAVAILABLE';
    throw error;
  }
  if (!client) {
    client = new S3Client({
      region: process.env.REPORTS_S3_REGION || process.env.AWS_REGION || 'us-east-1',
      ...(process.env.REPORTS_S3_ENDPOINT ? {
        endpoint: process.env.REPORTS_S3_ENDPOINT,
        forcePathStyle: true,
      } : {}),
    });
  }
  return client;
}

async function storeReportArtifact(key, body, contentType) {
  await getS3Client().send(new PutObjectCommand({
    Bucket: process.env.REPORTS_S3_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    ServerSideEncryption: 'AES256',
  }));
}

function createReportDownloadUrl(key, expiresIn = SIGNED_URL_TTL_SECONDS) {
  const command = new GetObjectCommand({
    Bucket: process.env.REPORTS_S3_BUCKET,
    Key: key,
  });
  return getSignedUrl(getS3Client(), command, { expiresIn });
}

module.exports = { storeReportArtifact, createReportDownloadUrl, SIGNED_URL_TTL_SECONDS };