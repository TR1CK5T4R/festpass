import { generateKeyPairSync } from 'node:crypto';
import { defineConfig } from 'vitest/config';

try {
  process.loadEnvFile('../../.env');
} catch {
  // no .env file: rely on the environment (CI)
}
if (!process.env.DATABASE_URL_TEST) {
  throw new Error('DATABASE_URL_TEST is not set; see .env.example');
}
// Tests never touch the dev database, and their request logs would only be noise.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
// Redis database 15 for tests, so flushing it between tests never touches dev data in database 0.
process.env.REDIS_URL = new URL('/15', process.env.REDIS_URL ?? 'redis://localhost:6380').href;
process.env.MONGODB_URI = new URL(
  '/festpass_test',
  process.env.MONGODB_URI ?? 'mongodb://localhost:27018',
).href;
process.env.ADMIN_EMAILS = 'admin@festpass.test';
// Fake test-mode keys: tests replace paymentGateway.createOrder, so Razorpay is never called.
process.env.RAZORPAY_KEY_ID = 'rzp_test_festpassTests';
process.env.RAZORPAY_KEY_SECRET = 'not-a-real-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
// A fresh ticket key pair per run, so no signing key is ever stored for tests.
const ticketKeys = generateKeyPairSync('ed25519');
process.env.TICKET_SIGNING_PRIVATE_KEY = ticketKeys.privateKey
  .export({ format: 'der', type: 'pkcs8' })
  .toString('base64url');
process.env.TICKET_PUBLIC_KEY_FOR_TESTS = ticketKeys.publicKey.export({ format: 'jwk' }).x;
process.env.ADMISSION_TOKEN_SECRET = 'test-admission-secret-0123456789abcdef';
// Limits high enough that no other suite is throttled; rate-limit.test.ts builds apps with small ones.
for (const name of ['LOGIN', 'REGISTER', 'ORDERS', 'PRESIGN', 'QUEUE_JOIN']) {
  process.env[`RATE_LIMIT_${name}`] = '100000/600000';
}
// Nothing listens on port 9, so revalidation calls fail at once instead of reaching a running web app.
process.env.WEB_REVALIDATE_URL = 'http://127.0.0.1:9/api/revalidate';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // Test files that use the database truncate it, so they must not run at the same time.
    fileParallelism: false,
  },
});
