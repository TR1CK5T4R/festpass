import { redisKeys } from '@festpass/shared';
import { logger } from './logger.js';
import { gateRedis } from './redis.js';

// Cache-aside for public event reads. A read asks Redis first; on a miss it loads from Postgres and
// stores the answer for TTL_SECONDS. Postgres stays the source of truth: losing the cache only costs speed.

const TTL_SECONDS = 30;
// Same budget as the booking gate: a cache slower than this would cost more than it saves.
const TIMEOUT_MS = 50;
const GENERATION_KEY = 'cache:events:gen';

/**
 * Every cached key ends in the current generation, and invalidating bumps it. Bumping instead of
 * deleting closes a race: a request that read the old row just before an edit committed would otherwise
 * write that old row back after the delete, and it would be served for 30 s. Under the new generation
 * nobody reads that key again; it expires on its own. Read in the same script as the value: one round trip.
 */
const GET_CURRENT = `
local gen = redis.call('GET', KEYS[1]) or '0'
return {gen, redis.call('GET', ARGV[1] .. ':' .. gen)}`;

declare module 'ioredis' {
  interface RedisCommander {
    festpassCacheGet(genKey: string, prefix: string): Promise<[string, string | null]>;
  }
}
gateRedis.defineCommand('festpassCacheGet', { lua: GET_CURRENT, numberOfKeys: 1 });

/** A Redis call that gives up quickly. Null means "no answer", and the caller goes to Postgres. */
async function quickly<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`no answer within ${TIMEOUT_MS} ms`)),
          TIMEOUT_MS,
        ).unref(),
      ),
    ]);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'cache unavailable, reading from postgres');
    return null;
  }
}

/** Loads in flight in this process, by key, so a crowd missing the same key shares one query. */
const loading = new Map<string, Promise<unknown>>();

/**
 * The cached value for `key`, or `load()`'s result (stored for next time). Either way the value has been
 * through JSON (dates become ISO strings), so a hit and a miss answer exactly the same; `W` is that wire
 * shape. A null from `load()` (not found) isn't cached.
 *
 * When a popular key expires, every request arriving in that moment would query Postgres at once (a cache
 * stampede). Here they wait for the same load instead: one query per API instance, not one per request.
 */
export async function cached<W>(key: string, load: () => Promise<unknown>): Promise<W | null> {
  const current = await quickly(() => gateRedis.festpassCacheGet(GENERATION_KEY, key));
  if (current?.[1]) return JSON.parse(current[1]) as W;

  const fullKey = `${key}:${current?.[0] ?? 'none'}`;
  let pending = loading.get(fullKey) as Promise<W | null> | undefined;
  if (!pending) {
    pending = (async () => {
      const value = await load();
      if (value === null) return null;
      const json = JSON.stringify(value);
      // Stored under the generation read before loading, and only if Redis answered at all.
      if (current) void quickly(() => gateRedis.set(fullKey, json, 'EX', TTL_SECONDS));
      return JSON.parse(json) as W;
    })().finally(() => loading.delete(fullKey));
    loading.set(fullKey, pending);
  }
  return pending;
}

/**
 * Makes every cached public event read stale. Called after the change has committed and before the web
 * app is asked to rebuild its pages, so the rebuild reads fresh data. If Redis is down this only logs:
 * the cache is unreachable for readers too, and anything stored expires within 30 s.
 */
export async function invalidatePublicEvents() {
  await quickly(() => gateRedis.incr(GENERATION_KEY));
}

/** Tickets left per tier as the booking gate sees them (inv:*), or null where Redis has no number. */
export async function liveStock(tierIds: string[]): Promise<(number | null)[]> {
  if (tierIds.length === 0) return [];
  const values = await quickly(() => gateRedis.mget(tierIds.map(redisKeys.inventory)));
  return tierIds.map((_, i) => (values?.[i] == null ? null : Number(values[i])));
}
