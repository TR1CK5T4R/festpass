import { findWaitingRoomEvent } from '@festpass/db/booking';
import type { QueueStatus } from '@festpass/shared';
import { joinWaitingRoom, waitingRoomPlace } from '@festpass/shared/server';
import { AppError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { gateRedis } from '../../lib/redis.js';
import { withTimeout } from '../orders/gate.js';

const REDIS_TIMEOUT_MS = 500;

// shortcut: one Postgres read per join and per status check; cache it if a big sale shows this in profiles.
async function loadOpenEvent(eventId: string) {
  const event = await findWaitingRoomEvent(eventId);
  if (!event || event.status === 'DRAFT') throw new NotFoundError('Event not found');
  if (event.status === 'CLOSED') {
    throw new ConflictError('EVENT_CLOSED', 'Booking for this event is closed');
  }
  const now = new Date();
  if (now < event.saleStartsAt) {
    throw new ConflictError('SALE_NOT_STARTED', 'Tickets are not on sale yet', {
      opensAt: event.saleStartsAt.toISOString(),
    });
  }
  if (now >= event.saleEndsAt) {
    throw new ConflictError('SALE_ENDED', 'Ticket sales have ended');
  }
  return event;
}

/**
 * Unlike the booking gate, this can't fall back on Postgres: the line lives only in Redis. Refusing here
 * is safe, because Postgres still protects the tickets and people already admitted can still book.
 */
async function fromRedis<T>(work: Promise<T>): Promise<T> {
  try {
    return await withTimeout(work, REDIS_TIMEOUT_MS);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'waiting room unavailable');
    throw new AppError(503, 'QUEUE_UNAVAILABLE', 'The waiting room is busy, try again shortly');
  }
}

async function describePlace(
  eventId: string,
  userId: string,
  admitRatePerSec: number,
): Promise<QueueStatus> {
  const place = await fromRedis(waitingRoomPlace(gateRedis, eventId, userId));
  if (!place) return { state: 'not_joined' };
  if ('token' in place) {
    return {
      state: 'admitted',
      token: place.token,
      expiresAt: new Date(Date.now() + place.ttlMs).toISOString(),
    };
  }
  const position = place.rank + 1;
  return {
    state: 'waiting',
    position,
    estimatedWaitSeconds: Math.ceil(position / admitRatePerSec),
  };
}

export async function join(eventId: string, userId: string): Promise<QueueStatus> {
  const event = await loadOpenEvent(eventId);
  if (!event.queueMode) return { state: 'not_required' };
  await fromRedis(joinWaitingRoom(gateRedis, eventId, userId));
  return describePlace(eventId, userId, event.admitRatePerSec);
}

export async function status(eventId: string, userId: string): Promise<QueueStatus> {
  const event = await loadOpenEvent(eventId);
  if (!event.queueMode) return { state: 'not_required' };
  return describePlace(eventId, userId, event.admitRatePerSec);
}
