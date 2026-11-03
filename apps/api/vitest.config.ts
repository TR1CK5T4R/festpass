import { defineConfig } from 'vitest/config';

try {
  process.loadEnvFile('../../.env');
} catch {
  // no .env file: rely on the environment (CI)
}
// Tests never touch the dev database, and their request logs would only be noise.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
if (process.env.DATABASE_URL_TEST) process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;

export default defineConfig({});
