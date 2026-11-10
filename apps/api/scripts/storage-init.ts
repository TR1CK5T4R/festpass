// Creates the bucket, makes banner keys publicly readable and lets the web app POST uploads to it.
// Safe to run again: every step either creates or overwrites with the same settings.
import {
  CreateBucketCommand,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { env } from '../src/config/env.js';
import { s3 } from '../src/lib/storage.js';

const Bucket = env.S3_BUCKET;

try {
  await s3.send(new CreateBucketCommand({ Bucket }));
  console.log(`created bucket ${Bucket}`);
} catch (err) {
  const exists = ['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'];
  if (!(err instanceof S3ServiceException && exists.includes(err.name))) throw err;
  console.log(`bucket ${Bucket} already exists`);
}

// Anyone may read banners, and only banners. Everything else in the bucket (ticket PDFs later) stays
// private and is only reachable through short-lived pre-signed GET URLs.
// (R2 has no bucket policies: in production banners will live in a bucket that has public access on.)
const policy = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'PublicReadBanners',
      Effect: 'Allow',
      Principal: '*',
      Action: ['s3:GetObject'],
      Resource: [`arn:aws:s3:::${Bucket}/orgs/*/events/*/banner/*`],
    },
  ],
};
await s3.send(new PutBucketPolicyCommand({ Bucket, Policy: JSON.stringify(policy) }));
console.log('public-read policy set for orgs/*/events/*/banner/*');

// The browser POSTs the file straight to storage, so storage (not the API) must allow the web origin.
await s3.send(
  new PutBucketCorsCommand({
    Bucket,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: env.WEB_ORIGINS,
          AllowedMethods: ['POST', 'GET'],
          AllowedHeaders: ['*'],
          MaxAgeSeconds: 3600,
        },
      ],
    },
  }),
);
console.log(`CORS allows ${env.WEB_ORIGINS.join(', ')}`);
