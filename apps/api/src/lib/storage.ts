import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { env } from '../config/env.js';

// Path-style URLs (http://host/bucket/key) work on SeaweedFS, MinIO and R2 alike; virtual-host style
// (http://bucket.host/key) would need wildcard DNS for localhost.
export const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
});

/**
 * Signs a browser form upload for exactly this key. The conditions are inside the signed policy, so the
 * storage server itself rejects a bigger file or a different Content-Type; nothing here sees the bytes.
 * Signing is local computation, not a network call.
 */
export function presignPost(key: string, contentType: string, maxBytes: number, expiresIn: number) {
  return createPresignedPost(s3, {
    Bucket: env.S3_BUCKET,
    Key: key,
    Conditions: [
      ['content-length-range', 1, maxBytes],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
    Expires: expiresIn,
  });
}

/** What storage says about an object, or null if there is no object at this key. */
export async function headObject(key: string) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return { contentType: head.ContentType ?? '', size: head.ContentLength ?? 0 };
  } catch (err) {
    if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

export const publicUrl = (key: string) => `${env.S3_PUBLIC_URL}/${key}`;
