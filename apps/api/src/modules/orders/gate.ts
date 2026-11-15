import { redisKeys } from '@festpass/shared';
import { releaseRedisStock } from '@festpass/shared/server';
import { env } from '../../config/env.js';
import { gateRedis } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';

// The Redis gate: turns most of a flash-sale crowd away in memory, before any Postgres transaction.
// It is only ever allowed to say "no" early. Every "yes" is decided again by Postgres (Day 11), and
// Redis numbers are reset from Postgres by reconcileInventory(). Postgres is the source of truth.

/**
 * KEYS: one pair per item: inv:{tierId}, usr:{eventId}:{userId}:{tierId}; then req:{userId}:{key}.
 * ARGV: one pair per item: qty, perUserLimit; then the TTLs of the usr and req keys in seconds.
 * Redis runs a script as one step: no other command runs between the checks and the writes, so two
 * buyers can't both see the last ticket. Plain GET-then-DECRBY from Node would have exactly that gap,
 * and a MULTI transaction can't decide anything based on what it read. All items pass, or none is taken.
 */
const RESERVE = `
local n = (#KEYS - 1) / 2
local request = KEYS[#KEYS]
-- A copy of a request that already passed (same Idempotency-Key, e.g. a double click) must not take
-- stock or count against the limit again: it skips the gate, and Postgres gives it the first answer.
if redis.call('EXISTS', request) == 1 then return {'DUPLICATE'} end
for i = 1, n do
  local stock = redis.call('GET', KEYS[2 * i - 1])
  if not stock then return {'MISS', i} end
  local qty = tonumber(ARGV[2 * i - 1])
  if tonumber(stock) < qty then return {'SOLD_OUT', i} end
  local held = tonumber(redis.call('GET', KEYS[2 * i]) or '0')
  if held + qty > tonumber(ARGV[2 * i]) then return {'LIMIT', i, held} end
end
for i = 1, n do
  local qty = tonumber(ARGV[2 * i - 1])
  redis.call('DECRBY', KEYS[2 * i - 1], qty)
  redis.call('INCRBY', KEYS[2 * i], qty)
  redis.call('EXPIRE', KEYS[2 * i], ARGV[#ARGV - 1])
end
redis.call('SET', request, 1, 'EX', ARGV[#ARGV])
return {'OK'}`;

declare module 'ioredis' {
  interface RedisCommander {
    festpassReserve(
      numKeys: number,
      ...args: (string | number)[]
    ): Promise<[string, number?, number?]>;
  }
}
// Sent once and then called by SHA (EVALSHA), so each booking sends only keys and numbers.
gateRedis.defineCommand('festpassReserve', { lua: RESERVE });

/** Slower than this and the gate is skipped: the point of the gate is to be faster than Postgres. */
const GATE_TIMEOUT_MS = 50;
// The usr key only has to cover holds still in flight: after that, Postgres counts paid tickets
// anyway. Keeping it short also means a release that never happened (a crash between the Postgres
// commit and the Redis call) heals by itself within minutes.
const USER_KEY_TTL_SECONDS = Math.ceil(env.HOLD_MINUTES * 60) + 5 * 60;
// Long enough to cover retries of an in-flight request; after that the stored answer in Postgres
// (checked before the gate) handles them.
const REQUEST_KEY_TTL_SECONDS = 60;

export interface GateItem {
  tierId: string;
  qty: number;
  perUserLimit: number;
}

export type GateResult =
  | { kind: 'passed' }
  | { kind: 'sold-out'; tierId: string }
  | { kind: 'over-limit'; tierId: string; held: number }
  /** Redis didn't answer in time, failed, or doesn't know the tier yet: Postgres alone decides. */
  | { kind: 'skipped'; reason: string };

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms).unref(),
    ),
  ]);
}

const keysFor = (eventId: string, userId: string, items: { tierId: string }[]) =>
  items.flatMap((i) => [
    redisKeys.inventory(i.tierId),
    redisKeys.userHeld(eventId, userId, i.tierId),
  ]);

export async function reserveInRedis(
  eventId: string,
  userId: string,
  idempotencyKey: string,
  items: GateItem[],
): Promise<GateResult> {
  try {
    const [result, index, held] = await withTimeout(
      gateRedis.festpassReserve(
        items.length * 2 + 1,
        ...keysFor(eventId, userId, items),
        `req:${userId}:${idempotencyKey}`,
        ...items.flatMap((i) => [i.qty, i.perUserLimit]),
        USER_KEY_TTL_SECONDS,
        REQUEST_KEY_TTL_SECONDS,
      ),
      GATE_TIMEOUT_MS,
    );
    const tierId = index ? items[index - 1]!.tierId : '';
    if (result === 'OK') return { kind: 'passed' };
    if (result === 'SOLD_OUT') return { kind: 'sold-out', tierId };
    if (result === 'LIMIT') return { kind: 'over-limit', tierId, held: held ?? 0 };
    if (result === 'DUPLICATE')
      return { kind: 'skipped', reason: 'duplicate of a request in flight' };
    return { kind: 'skipped', reason: `no inventory key for tier ${tierId}` };
  } catch (err) {
    // A timed-out script may still run in Redis later and take stock that Postgres never books.
    // That leaves Redis low until the next reconciliation; Postgres stays correct meanwhile.
    logger.warn(
      { err: (err as Error).message },
      'redis gate unavailable, booking through Postgres only',
    );
    return { kind: 'skipped', reason: 'redis unavailable' };
  }
}

/**
 * Gives tickets back to the gate: compensation when Postgres didn't book, and after a hold is
 * cancelled or expires. Never throws; if Redis is unreachable, it stays too low until reconciliation.
 */
export async function releaseInRedis(
  eventId: string,
  userId: string,
  items: { tierId: string; qty: number }[],
) {
  try {
    await withTimeout(releaseRedisStock(gateRedis, eventId, userId, items), GATE_TIMEOUT_MS);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, eventId },
      'could not release redis stock; reconciliation will fix it',
    );
  }
}
