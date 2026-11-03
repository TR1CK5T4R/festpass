import { defineConfig } from 'vitest/config';

// These tests hit a real Postgres, because a CHECK constraint can only be proven by the database.
try {
  process.loadEnvFile('../../.env');
} catch {
  // no .env file: rely on the environment (CI)
}
if (!process.env.DATABASE_URL_TEST) {
  throw new Error('DATABASE_URL_TEST is not set; see .env.example');
}
// Point the Prisma singleton at the test database before any test file imports it.
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // Test files share one database, so run them one at a time.
    fileParallelism: false,
  },
});
