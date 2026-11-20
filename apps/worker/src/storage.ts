import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { WorkerEnv } from './env.js';

/** Where ticket PDFs go. Tests pass an in-memory fake. */
export interface TicketStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** A GET link that works for `seconds`, then stops: the object itself is never public. */
  signedDownloadUrl(key: string, seconds: number, filename: string): Promise<string>;
}

export function s3TicketStorage(env: WorkerEnv): TicketStorage {
  const s3 = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
  return {
    async put(key, body, contentType) {
      await s3.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
    signedDownloadUrl(key, seconds, filename) {
      return getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key,
          ResponseContentDisposition: `attachment; filename="${filename}"`,
        }),
        { expiresIn: seconds },
      );
    },
  };
}
