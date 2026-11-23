import { announceAvailabilityChange } from '@festpass/shared/server';
import type { AvailabilityUpdate } from '@festpass/shared';
import { logger } from '../lib/logger.js';
import { gateRedis } from '../lib/redis.js';
import { findTierAvailability } from '../modules/events/repository.js';

export const THROTTLE_WINDOW_MS = 500; // at most 2 updates a second per event

/**
 * Called after a booking, cancel or late payment has committed. Fire and forget on the fail-fast client:
 * a live number is a nicety, so a Redis problem must never slow down or fail a booking.
 */
export function announceChange(eventId: string) {
  announceAvailabilityChange(gateRedis, eventId).catch((err: Error) =>
    logger.warn({ err: err.message, eventId }, 'could not announce an availability change'),
  );
}

interface ThrottleOptions {
  windowMs: number;
  /** True for the one caller that gets to send this window's update, across all API instances. */
  claim: (eventId: string, windowMs: number) => Promise<boolean>;
  send: (eventId: string) => void;
}

/**
 * At most one send per window for each event, however many changes arrive. The send is at the END of
 * the window and reads the numbers then, so the last change is always included. Debouncing would be
 * wrong here: it waits for a quiet moment, and during a flash sale there isn't one, so people would see
 * nothing until the rush was over.
 */
export function createAvailabilityThrottle({ windowMs, claim, send }: ThrottleOptions) {
  const scheduled = new Set<string>();
  return async function changed(eventId: string) {
    if (scheduled.has(eventId)) return; // this instance already has a send coming
    if (!(await claim(eventId, windowMs))) return; // another instance does
    scheduled.add(eventId);
    setTimeout(() => {
      scheduled.delete(eventId);
      send(eventId);
    }, windowMs);
  };
}

const SNAPSHOT_MAX_AGE_MS = 1_000;

/**
 * Current numbers, from Postgres. Everyone joining gets a snapshot, because the cached page can be a
 * minute old. Shared for a second, so a thousand people opening the page (or reconnecting together
 * after a network blip) cost one query, not a thousand.
 */
export function createAvailabilityReader() {
  const cache = new Map<string, { at: number; update: Promise<AvailabilityUpdate | null> }>();

  function read(eventId: string) {
    const update = findTierAvailability(eventId).then((tiers) => {
      // Random IDs must not grow the cache.
      if (tiers.length === 0) {
        cache.delete(eventId);
        return null;
      }
      return {
        eventId,
        tiers: tiers.map((t) => ({ id: t.id, available: t.capacity - t.soldCount })),
      };
    });
    update.catch(() => cache.delete(eventId));
    cache.set(eventId, { at: Date.now(), update });
    return update;
  }

  return {
    /** Fresh numbers, for an update. Also replaces the snapshot, so anyone joining next is up to date. */
    fresh: read,
    snapshot(eventId: string) {
      const cached = cache.get(eventId);
      return cached && Date.now() - cached.at < SNAPSHOT_MAX_AGE_MS ? cached.update : read(eventId);
    },
  };
}
