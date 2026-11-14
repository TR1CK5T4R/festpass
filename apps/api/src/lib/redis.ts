import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

// lazyConnect: importing this module (e.g. from tests) opens no socket; the first command connects.
// After that ioredis reconnects by itself if Redis restarts.
export const redis = new Redis(env.REDIS_URL, { lazyConnect: true });

// Without a listener ioredis prints "Unhandled error event" on every failed reconnect.
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis connection error'));

/**
 * A second client just for the booking gate, tuned to fail fast. With no offline queue, a command
 * fails at once while Redis is unreachable instead of waiting for a reconnect (and possibly running
 * minutes later, after the booking already went through Postgres). The gate then falls back to the
 * Postgres-only path, which is always correct, just slower under load.
 */
export const gateRedis = new Redis(env.REDIS_URL, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 0,
});
gateRedis.on('error', (err) => logger.warn({ err: err.message }, 'gate redis connection error'));
