import { prisma } from '@festpass/db';
import { pingMongo } from '@festpass/mongo';
import { redis } from '../../lib/redis.js';

// The cheapest round trip each data store supports; each throws if the store is unreachable.

export async function pingPostgres(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

export async function pingRedis(): Promise<void> {
  await redis.ping();
}

export { pingMongo };
