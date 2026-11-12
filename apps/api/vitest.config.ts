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
// Nothing listens on port 9, so revalidation calls fail at once instead of reaching a running web app.
process.env.WEB_REVALIDATE_URL = 'http://127.0.0.1:9/api/revalidate';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // Test files that use the database truncate it, so they must not run at the same time.
    fileParallelism: false,
  },
});
