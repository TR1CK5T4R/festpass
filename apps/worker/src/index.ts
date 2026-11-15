import { prisma } from '@festpass/db';
import { JOBS, QUEUES } from '@festpass/shared';
import { createQueue } from '@festpass/shared/server';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { z } from 'zod';
import { processJob } from './processors.js';

// Background jobs, in their own process so a slow job can never slow down the API.
// Today: hold expiry (each order's own delayed job plus a sweeper) and inventory reconciliation.

const parsed = z
  .object({
    DATABASE_URL: z.url(),
    REDIS_URL: z.url(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  console.error(`Invalid environment variables:\n${problems.join('\n')}\nSee .env.example.`);
  process.exit(1);
}
const env = parsed.data;
const logger = pino({ level: env.LOG_LEVEL, base: { process: 'worker' } });

// BullMQ needs maxRetriesPerRequest: null: its blocking commands must wait for Redis to come back
// instead of failing after a few retries.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
connection.on('error', (err) => logger.warn({ err: err.message }, 'redis connection error'));

const inventoryQueue = createQueue(QUEUES.inventory, connection);
const ordersQueue = createQueue(QUEUES.orders, connection);

// Repeating jobs. upsertJobScheduler is idempotent: restarting the worker (or running two) keeps one
// schedule per ID. Every minute: reset inv:* from Postgres, and expire holds whose own job never ran.
await inventoryQueue.upsertJobScheduler(
  JOBS.reconcileInventory,
  { every: 60_000 },
  { name: JOBS.reconcileInventory },
);
await ordersQueue.upsertJobScheduler(
  JOBS.sweepExpiredOrders,
  { every: 60_000 },
  { name: JOBS.sweepExpiredOrders },
);

// Each queue gets its own worker so a backlog of one can't delay the other.
const workers = [QUEUES.inventory, QUEUES.orders].map((name) => {
  const worker = new Worker(name, (job) => processJob(job, connection, logger), { connection });
  // Failed jobs are retried with backoff (createQueue) and kept in Bull Board once attempts run out.
  worker.on('failed', (job, err) =>
    logger.error({ job: job?.id, name: job?.name, attempt: job?.attemptsMade, err }, 'job failed'),
  );
  return worker;
});

logger.info({ queues: [QUEUES.inventory, QUEUES.orders] }, 'worker started');

async function shutdown(signal: NodeJS.Signals) {
  logger.info({ signal }, 'worker shutting down');
  // close() waits for the job in progress to finish, so a reconciliation is never cut in half.
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all([inventoryQueue.close(), ordersQueue.close()]);
  await Promise.allSettled([prisma.$disconnect(), connection.quit()]);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
