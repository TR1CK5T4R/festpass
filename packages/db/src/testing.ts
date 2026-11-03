import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from './generated/prisma/client.js';

// Test-only helpers, exported as @festpass/db/testing so they never end up in app code by accident.

const packageDir = fileURLToPath(new URL('..', import.meta.url));

/** Applies every migration to DATABASE_URL_TEST (creating the database if needed). Used by Vitest globalSetup. */
export function migrateTestDatabase(): void {
  const url = process.env.DATABASE_URL_TEST;
  if (!url)
    throw new Error('DATABASE_URL_TEST is not set; tests never run against the dev database');
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: packageDir,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

/** Empties every table so each test starts from a known state. Refuses to run outside a *_test database. */
export async function truncateAll(db: PrismaClient): Promise<void> {
  const [row] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (!row?.name.endsWith('_test')) {
    throw new Error(`refusing to truncate "${row?.name}": not a *_test database`);
  }
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  // Table names come from the Postgres catalog, not user input, so building the statement is safe.
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
