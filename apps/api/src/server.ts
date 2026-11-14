import { prisma } from '@festpass/db';
import { connectMongo, disconnectMongo } from '@festpass/mongo';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { gateRedis, redis } from './lib/redis.js';
import { logBookingStatsEvery } from './modules/orders/stats.js';

// Mongoose needs an explicit first connect; Prisma and ioredis connect on first use.
// Failing fast here lets the process manager restart us instead of serving with a dead dependency.
try {
  await connectMongo(env.MONGODB_URI);
} catch (err) {
  logger.fatal({ err }, 'could not connect to MongoDB');
  process.exit(1);
}

const server = createApp().listen(env.API_PORT, () => {
  logger.info(`api listening on http://localhost:${env.API_PORT}`);
});

logBookingStatsEvery(60_000);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  // Never hang forever on a stuck request; the platform would kill us anyway.
  setTimeout(() => {
    logger.error('shutdown timed out after 10 s, forcing exit');
    process.exit(1);
  }, 10_000).unref();

  // 1. Stop accepting connections and let in-flight requests finish (Node also closes idle keep-alive sockets).
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // 2. Only then close the stores those requests were using.
  await Promise.allSettled([
    prisma.$disconnect(),
    redis.quit(),
    gateRedis.quit(),
    disconnectMongo(),
  ]);
  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
