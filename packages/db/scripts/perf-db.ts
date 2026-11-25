import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../src/generated/prisma/client.js';

// The performance database: the dev server's Postgres, but its own database (festpass_perf), so 100k
// generated tickets never mix with the demo data and can be thrown away at any time.

try {
  process.loadEnvFile('../../.env');
} catch {
  // no .env file: rely on the environment
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set; see .env.example');

const devUrl = new URL(process.env.DATABASE_URL);
export const perfUrl = new URL(devUrl);
perfUrl.pathname = '/festpass_perf';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

/** Creates festpass_perf if needed and applies every migration to it. */
export async function preparePerfDatabase() {
  const dev = new PrismaClient({ adapter: new PrismaPg({ connectionString: devUrl.href }) });
  const [exists] = await dev.$queryRaw<unknown[]>`
    SELECT 1 FROM pg_database WHERE datname = 'festpass_perf'`;
  if (!exists) await dev.$executeRawUnsafe('CREATE DATABASE festpass_perf');
  await dev.$disconnect();
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: packageDir,
    env: { ...process.env, DATABASE_URL: perfUrl.href },
    stdio: 'inherit',
  });
}

/** A client for festpass_perf that refuses to run against anything else. */
export async function perfClient(log: Prisma.LogDefinition[] = []) {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: perfUrl.href }), log });
  const [row] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (row?.name !== 'festpass_perf') throw new Error(`refusing to use "${row?.name}"`);
  return db;
}
