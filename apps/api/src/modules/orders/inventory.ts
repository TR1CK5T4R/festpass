import { reconcileInventory } from '@festpass/db/inventory';
import { logger } from '../../lib/logger.js';
import { gateRedis } from '../../lib/redis.js';
import { withTimeout } from './gate.js';

/**
 * Sets inv:{tierId} for one event's tiers from Postgres. Called after publishing and after tier
 * changes on a published event, once the database work is done. If Redis is down this only logs:
 * the gate is skipped for unknown tiers, and the worker's reconciliation fills them in later.
 * Bounded by a timeout, so a hanging Redis can never hold up publishing.
 */
export async function syncInventory(eventId: string) {
  try {
    const drift = await withTimeout(reconcileInventory(gateRedis, { eventId }), 1000);
    if (drift.length > 0) logger.debug({ eventId, drift }, 'inventory keys set from Postgres');
  } catch (err) {
    logger.warn({ err: (err as Error).message, eventId }, 'could not sync inventory to redis');
  }
}
