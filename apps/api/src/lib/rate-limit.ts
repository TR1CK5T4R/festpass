import type { Request, RequestHandler } from 'express';
import { RateLimitedError } from './errors.js';
import { logger } from './logger.js';
import { gateRedis } from './redis.js';

// The rate-limiting algorithm, in one place: routes only declare a limit and what to count per.
//
// Token bucket: every key has a bucket of `capacity` tokens; each request takes one; tokens flow back
// in at `refillPerSec` up to the capacity. A client can burst up to `capacity` requests at once, then
// is held to the refill rate on average. Instead of a timer, the refill is computed lazily on each
// request from the time since the last one, so an idle key costs nothing and expires on its own.

/**
 * KEYS[1]: the bucket (a hash with `tokens` and `ts`, the time of the last update in ms).
 * ARGV: capacity, refill per second.
 * Returns {allowed (1/0), whole tokens left, ms until the next token, ms until the bucket is full}.
 *
 * The clock is Redis's own TIME, not the API server's: every API instance asks the same clock, so a
 * server whose clock is a few seconds off can't hand out extra tokens (clock ahead) or wrongly refuse
 * (clock behind). The script runs atomically, so parallel requests can't both take the last token.
 */
const TOKEN_BUCKET = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2]) / 1000
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(bucket[1]) or capacity
local last = tonumber(bucket[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - last) * rate)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
local untilFull = math.ceil((capacity - tokens) / rate)
-- A full bucket behaves exactly like a missing key, so the key can expire once it would be full.
redis.call('PEXPIRE', KEYS[1], untilFull + 1000)
local untilNext = 0
if allowed == 0 then untilNext = math.ceil((1 - tokens) / rate) end
return {allowed, math.floor(tokens), untilNext, untilFull}`;

declare module 'ioredis' {
  interface RedisCommander {
    festpassRateLimit(
      key: string,
      capacity: number,
      refillPerSec: number,
    ): Promise<[number, number, number, number]>;
  }
}
gateRedis.defineCommand('festpassRateLimit', { lua: TOKEN_BUCKET, numberOfKeys: 1 });

export interface Limit {
  /** Requests allowed in one burst. */
  capacity: number;
  /** Tokens added back per second (the sustained rate). */
  refillPerSec: number;
}

export interface RateLimitOptions extends Limit {
  /** Names the bucket family in Redis, e.g. "login". */
  name: string;
  /** What to count per: an IP, a user, an IP and an email. */
  keyFn: (req: Request) => string;
}

// Same budget as the booking gate: a limiter that waits on a slow Redis would slow every request.
const TIMEOUT_MS = 50;

/**
 * Express middleware: 429 RATE_LIMITED with Retry-After once the bucket is empty, and RateLimit-*
 * headers on every answer so well-behaved clients can slow down before they hit the limit.
 *
 * If Redis is down or slow, the request is let through (fail open) and a warning is logged. The
 * limiter protects against abuse, not against incorrect data: Postgres constraints, the per-user
 * ticket limit and bcrypt's cost still hold without it, while failing closed would turn a Redis
 * outage into a full outage of login and booking, the opposite of what the booking gate was built for.
 */
export function rateLimit({
  name,
  keyFn,
  capacity,
  refillPerSec,
}: RateLimitOptions): RequestHandler {
  return async (req, res, next) => {
    let result: [number, number, number, number];
    try {
      result = await Promise.race([
        gateRedis.festpassRateLimit(`rl:${name}:${keyFn(req)}`, capacity, refillPerSec),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`no answer within ${TIMEOUT_MS} ms`)),
            TIMEOUT_MS,
          ).unref(),
        ),
      ]);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, limiter: name },
        'rate limiter unavailable, letting the request through',
      );
      return next();
    }

    const [allowed, remaining, untilNextMs, untilFullMs] = result;
    // IETF draft "RateLimit header fields for HTTP": the burst size, what's left of it, and the
    // seconds until it is fully refilled.
    res.setHeader('RateLimit-Limit', capacity);
    res.setHeader('RateLimit-Remaining', remaining);
    res.setHeader('RateLimit-Reset', Math.ceil(untilFullMs / 1000));
    if (allowed === 1) return next();

    const retryAfter = Math.max(1, Math.ceil(untilNextMs / 1000));
    res.setHeader('Retry-After', retryAfter);
    next(new RateLimitedError(retryAfter));
  };
}

// What to count per. Behind a reverse proxy req.ip is the proxy's address unless Express's
// "trust proxy" is set; that is configured with the deployment (Day 29).
export const byIp = (req: Request) => req.ip ?? 'unknown';
export const byUser = (req: Request) => req.user!.id;
/** Login: per IP *and* account, so guessing one account's password is slowed without locking out a
 *  whole campus that shares one public IP. Read from the raw body because this runs before validation. */
export const byIpAndEmail = (req: Request) =>
  `${byIp(req)}:${String((req.body as { email?: unknown } | undefined)?.email ?? '')
    .trim()
    .toLowerCase()}`;
