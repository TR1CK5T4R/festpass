import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

// One client per process: it owns a connection pool, so creating one per request would exhaust Postgres.
// The pool only connects on the first query, so importing this module never needs a running database.
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

export * from './generated/prisma/client.js';
