import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

// lazyConnect: importing this module (e.g. from tests) opens no socket; the first command connects.
// After that ioredis reconnects by itself if Redis restarts.
export const redis = new Redis(env.REDIS_URL, { lazyConnect: true });

// Without a listener ioredis prints "Unhandled error event" on every failed reconnect.
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis connection error'));
