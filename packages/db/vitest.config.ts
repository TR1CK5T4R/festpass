import { defineConfig } from 'vitest/config';

// These tests hit a real Postgres (DATABASE_URL), because a CHECK constraint can only be proven by the database.
try {
  process.loadEnvFile('../../.env');
} catch {
  // no .env file: rely on the environment (CI)
}

export default defineConfig({
  test: {
    // Test files share one database, so run them one at a time.
    fileParallelism: false,
  },
});
