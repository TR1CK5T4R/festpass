import { redisKeys } from '@festpass/shared';
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

/**
 * Gives back what RESERVE took (KEYS as above; ARGV: qty per item). Stock is only added to a key that
 * still exists: creating a missing key with just the released quantity would claim far too few
 * tickets are left. Reconciliation sets missing keys from Postgres instead.
 */
const RELEASE = `
for i = 1, #KEYS / 2 do
  local qty = tonumber(ARGV[i])
  if redis.call('EXISTS', KEYS[2 * i - 1]) == 1 then redis.call('INCRBY', KEYS[2 * i - 1], qty) end
  if redis.call('DECRBY', KEYS[2 * i], qty) <= 0 then redis.call('DEL', KEYS[2 * i]) end
end
return 'OK'`;

declare module 'ioredis' {
  interface RedisCommander {
    festpassReserve(
      numKeys: number,
      ...args: (string | number)[]
    ): Promise<[string, number?, number?]>;
    festpassRelease(numKeys: number, ...args: (string | number)[]): Promise<string>;
  }
}
// Sent once and then called by SHA (EVALSHA), so each booking sends only keys and numbers.
gateRedis.defineCommand('festpassReserve', { lua: RESERVE });
gateRedis.defineCommand('festpassRelease', { lua: RELEASE });

/** Slower than this and the gate is skipped: the point of the gate is to be faster than Postgres. */
const GATE_TIMEOUT_MS = 50;
// The usr key outlives any hold; it only needs to last through the sale. It is a hint, not the record.
const USER_KEY_TTL_SECONDS = 24 * 60 * 60;
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

/** Compensation: gives back what reserveInRedis took when Postgres didn't book the order. */
export async function releaseInRedis(eventId: string, userId: string, items: GateItem[]) {
  try {
    await withTimeout(
      gateRedis.festpassRelease(
        items.length * 2,
        ...keysFor(eventId, userId, items),
        ...items.map((i) => i.qty),
      ),
      GATE_TIMEOUT_MS,
    );
  } catch (err) {
    // Redis now shows fewer tickets than Postgres has; reconciliation puts it right within a minute.
    logger.warn(
      { err: (err as Error).message, eventId },
      'could not release redis stock; reconciliation will fix it',
    );
  }
}
