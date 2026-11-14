import { redisKeys } from '@festpass/shared';
import { prisma } from './index.js';

/** The two Redis commands reconciliation needs. An ioredis client fits; so does a fake in tests. */
export interface InventoryStore {
  mget(keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string): Promise<unknown>;
}

export interface InventoryDrift {
  tierId: string;
  /** What Redis said (null: the key was missing) and what Postgres says. */
  redis: number | null;
  postgres: number;
}

/**
 * Makes every inv:{tierId} equal capacity - sold_count from Postgres, the source of truth, for the
 * tiers of published events whose sale hasn't ended (or of one event). Returns what it had to fix.
 *
 * Redis drifts because the gate and Postgres can't be updated atomically together: a release that
 * failed while Redis was unreachable, a gate script that timed out but ran anyway, a Redis restart.
 * Small races with bookings in flight can leave Redis slightly *above* Postgres for a moment, which
 * is harmless (Postgres refuses the extra requests); the next run corrects it either way.
 */
export async function reconcileInventory(
  store: InventoryStore,
  { eventId, now = new Date() }: { eventId?: string; now?: Date } = {},
): Promise<InventoryDrift[]> {
  const tiers = await prisma.ticketTier.findMany({
    where: {
      event: { status: 'PUBLISHED', saleEndsAt: { gt: now }, ...(eventId && { id: eventId }) },
    },
    select: { id: true, capacity: true, soldCount: true },
  });
  if (tiers.length === 0) return [];

  const current = await store.mget(tiers.map((t) => redisKeys.inventory(t.id)));
  const drift: InventoryDrift[] = [];
  for (const [i, tier] of tiers.entries()) {
    const postgres = tier.capacity - tier.soldCount;
    const redis = current[i] == null ? null : Number(current[i]);
    if (redis !== postgres) {
      await store.set(redisKeys.inventory(tier.id), String(postgres));
      drift.push({ tierId: tier.id, redis, postgres });
    }
  }
  return drift;
}
