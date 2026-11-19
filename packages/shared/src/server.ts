import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { Queue, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { signedPart, type TicketQrPayload } from './qr.ts';
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

/** Reads the private ticket key (PKCS#8 DER, base64url, from `pnpm keys:generate`). Throws if it isn't Ed25519. */
export function loadTicketPrivateKey(base64url: string): KeyObject {
  const key = createPrivateKey({
    key: Buffer.from(base64url, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  if (key.asymmetricKeyType !== 'ed25519')
    throw new Error('TICKET_SIGNING_PRIVATE_KEY is not an Ed25519 key');
  return key;
}

/**
 * Signs a ticket QR code with Node's crypto (server only: this module never reaches the browser, and
 * neither does the key). Ed25519 is deterministic, so the same ticket and version always give the
 * same QR string.
 */
export function encodeTicket({ t, e, v, iat }: TicketQrPayload, privateKey: KeyObject): string {
  const payloadPart = Buffer.from(JSON.stringify({ t, e, v, iat })).toString('base64url');
  const signature = sign(null, Buffer.from(signedPart(payloadPart)), privateKey);
  return `${signedPart(payloadPart)}.${signature.toString('base64url')}`;
}

/** encodeTicket with the key bound once, e.g. the API's key from env. */
export const createTicketSigner = (privateKey: KeyObject) => (payload: TicketQrPayload) =>
  encodeTicket(payload, privateKey);
