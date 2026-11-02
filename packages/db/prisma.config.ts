import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads .env itself. Load the repo-root .env if it exists (CI sets real env vars instead).
try {
  process.loadEnvFile('../../.env');
} catch {
  // no .env file: rely on the environment
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx src/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
