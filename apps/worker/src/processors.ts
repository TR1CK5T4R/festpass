import { findOverdueHolds, releaseHold, type ReleasedHold } from '@festpass/db/booking';
import { reconcileInventory } from '@festpass/db/inventory';
import { expireOrderJobSchema, JOBS } from '@festpass/shared';
import { releaseRedisStock } from '@festpass/shared/server';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

// What each job does, kept apart from the BullMQ wiring in index.ts so tests can call it directly.

/** The most overdue holds the sweeper expires per run; anything left waits for the next minute. */
const SWEEP_BATCH = 500;

/**
 * After the Postgres release has committed, gives the gate its stock back. A failure here only logs:
 * failing the job would retry it, but the retry would find the order already EXPIRED and do nothing,
 * so Redis would stay low anyway. Reconciliation (every minute) fixes inv:*, and usr:* keys expire.
 */
async function releaseInRedis(redis: Redis, hold: ReleasedHold, log: Logger) {
  try {
    await releaseRedisStock(redis, hold.eventId, hold.userId, hold.items);
  } catch (err) {
    log.warn(
      { err: (err as Error).message, orderId: hold.orderId },
      'redis release failed; reconciliation will fix it',
    );
  }
}

/** expire-order: ends one hold whose time is up. Running it twice, or after a cancel, does nothing. */
export async function expireOrder(data: unknown, redis: Redis, log: Logger) {
  const { orderId, requestId } = expireOrderJobSchema.parse(data);
  const hold = await releaseHold(orderId, 'EXPIRED');
  if (!hold) {
    log.debug(
      { orderId, requestId },
      'hold already ended (paid, cancelled or expired), nothing to do',
    );
    return { released: false };
  }
  await releaseInRedis(redis, hold, log);
  log.info({ orderId, requestId, items: hold.items }, 'hold expired, tickets back on sale');
  return { released: true };
}

/**
 * sweep-expired-orders: the safety net for expiry jobs that never ran (Redis lost them, the API
 * couldn't queue one, the worker was down past the deadline). Uses the same guarded release, so an
 * order its own job expires at the same moment is still released once.
 */
export async function sweepExpiredOrders(redis: Redis, log: Logger) {
  let expired = 0;
  for (const orderId of await findOverdueHolds(SWEEP_BATCH)) {
    const hold = await releaseHold(orderId, 'EXPIRED');
    if (!hold) continue;
    await releaseInRedis(redis, hold, log);
    expired++;
  }
  if (expired > 0) log.warn({ expired }, 'sweeper expired holds whose job never ran');
  return { expired };
}

export async function reconcile(redis: Redis, log: Logger) {
  const drift = await reconcileInventory(redis);
  // Drift means the gate and Postgres disagreed: a failed release, a timed-out script, a restart.
  if (drift.length > 0) log.warn({ drift }, 'fixed inventory drift in redis');
  return { fixed: drift.length };
}

/** Routes a job to its processor by name. */
export function processJob(job: Job, redis: Redis, log: Logger) {
  const jobLog = log.child({ job: job.id, name: job.name, attempt: job.attemptsMade + 1 });
  switch (job.name) {
    case JOBS.expireOrder:
      return expireOrder(job.data, redis, jobLog);
    case JOBS.sweepExpiredOrders:
      return sweepExpiredOrders(redis, jobLog);
    case JOBS.reconcileInventory:
      return reconcile(redis, jobLog);
    default:
      throw new Error(`unknown job ${job.name}`);
  }
}
