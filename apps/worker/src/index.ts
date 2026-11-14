import { prisma } from '@festpass/db';
import { reconcileInventory } from '@festpass/db/inventory';
import { JOBS, QUEUES } from '@festpass/shared';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { z } from 'zod';

// Background jobs, in their own process so a slow job can never slow down the API.
// Today: inventory reconciliation. Hold expiry, tickets and emails come on later days.

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

const inventoryQueue = new Queue(QUEUES.inventory, { connection });

// Every minute, set inv:{tierId} in Redis from Postgres for every event whose sale hasn't ended.
// upsertJobScheduler is idempotent: restarting the worker (or running two) keeps one schedule.
await inventoryQueue.upsertJobScheduler(
  JOBS.reconcileInventory,
  { every: 60_000 },
  { name: JOBS.reconcileInventory, opts: { removeOnComplete: 100, removeOnFail: 100 } },
);

const worker = new Worker(
  QUEUES.inventory,
  async (job) => {
    const drift = await reconcileInventory(connection);
    // Drift means the gate and Postgres disagreed: a failed release, a timed-out script, a restart.
    if (drift.length > 0) logger.warn({ job: job.id, drift }, 'fixed inventory drift in redis');
    else logger.debug({ job: job.id }, 'inventory in step with postgres');
    return { fixed: drift.length };
  },
  { connection },
);
worker.on('failed', (job, err) => logger.error({ job: job?.id, err }, 'job failed'));

logger.info({ queues: [QUEUES.inventory] }, 'worker started');

async function shutdown(signal: NodeJS.Signals) {
  logger.info({ signal }, 'worker shutting down');
  // close() waits for the job in progress to finish, so a reconciliation is never cut in half.
  await worker.close();
  await inventoryQueue.close();
  await Promise.allSettled([prisma.$disconnect(), connection.quit()]);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
