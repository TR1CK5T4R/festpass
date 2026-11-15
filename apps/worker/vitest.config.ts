import { defineConfig } from 'vitest/config';

try {
  process.loadEnvFile('../../.env');
} catch {
  // no .env file: rely on the environment (CI)
}
if (!process.env.DATABASE_URL_TEST) {
  throw new Error('DATABASE_URL_TEST is not set; see .env.example');
}
// Same test stores as the API tests: the test database and Redis database 15 (never dev data).
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
process.env.REDIS_URL = new URL('/15', process.env.REDIS_URL ?? 'redis://localhost:6380').href;

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
  },
});
