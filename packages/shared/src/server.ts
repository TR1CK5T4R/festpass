import { Queue, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { redisKeys } from './redis-keys.ts';

// Server-only helpers (BullMQ, ioredis), imported as @festpass/shared/server by the API and the worker.
// Kept out of the main entry so the web app's bundle never pulls them in.

/**
 * One way to create a queue, so the API (adding jobs) and the worker (running them) agree on the
 * defaults: up to 5 attempts with exponential backoff (1 s, 2 s, 4 s, 8 s), a short history of
 * completed jobs, and failed jobs kept until someone looks at them in Bull Board.
 */
export function createQueue(name: string, connection: ConnectionOptions) {
  return new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: false,
    },
  });
}

/**
 * Gives tickets back to the Redis gate. KEYS: one pair per item: inv:{tierId},
 * usr:{eventId}:{userId}:{tierId}; ARGV: qty per item. Stock is only added to a key that still exists:
 * creating a missing key with just the released quantity would claim far too few tickets are left
 * (reconciliation sets missing keys from Postgres instead).
 */
const RELEASE = `
for i = 1, #KEYS / 2 do
  local qty = tonumber(ARGV[i])
  if redis.call('EXISTS', KEYS[2 * i - 1]) == 1 then redis.call('INCRBY', KEYS[2 * i - 1], qty) end
  if redis.call('DECRBY', KEYS[2 * i], qty) <= 0 then redis.call('DEL', KEYS[2 * i]) end
end
return 'OK'`;

export function releaseRedisStock(
  redis: Redis,
  eventId: string,
  userId: string,
  items: { tierId: string; qty: number }[],
): Promise<unknown> {
  const keys = items.flatMap((i) => [
    redisKeys.inventory(i.tierId),
    redisKeys.userHeld(eventId, userId, i.tierId),
  ]);
  return redis.eval(RELEASE, keys.length, ...keys, ...items.map((i) => i.qty));
}
