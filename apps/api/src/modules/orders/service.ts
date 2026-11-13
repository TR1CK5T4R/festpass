import { createHash } from 'node:crypto';
import { findStoredAnswer, reserveTickets, type BookingAnswer } from '@festpass/db/booking';
import { prisma } from '@festpass/db';
import type { CreateOrderInput } from '@festpass/shared';
import { env } from '../../config/env.js';
import { AppError, bodyFieldErrors, ConflictError, NotFoundError } from '../../lib/errors.js';
import * as repo from './repository.js';

const keyReused = () =>
  new AppError(
    422,
    'IDEMPOTENCY_KEY_REUSED',
    'This Idempotency-Key was already used for a different request; send a new key',
  );

/**
 * Identifies "the same request": the event plus the items, sorted so their order doesn't matter.
 * A retry must send the same body; anything else with the same key is a client bug.
 */
function hashRequest(eventId: string, items: CreateOrderInput['items']) {
  const sorted = [...items].sort((a, b) => (a.tierId < b.tierId ? -1 : 1));
  return createHash('sha256')
    .update(JSON.stringify({ eventId, items: sorted }))
    .digest('hex');
}

/**
 * Checks done before the transaction, so it only ever runs for an event that can be booked right now.
 * Reads without locks: if the event changes a moment later, the transaction's own checks still hold.
 */
async function assertOnSale(eventId: string, items: CreateOrderInput['items'], now: Date) {
  const event = await repo.findEventForBooking(eventId);
  if (!event || event.status === 'DRAFT') throw new NotFoundError('Event not found');
  if (event.status === 'CLOSED') {
    throw new ConflictError('EVENT_CLOSED', 'Booking for this event is closed');
  }
  const tiers = new Map(event.tiers.map((t) => [t.id, t]));
  const missing = items.flatMap((item, i) =>
    tiers.has(item.tierId)
      ? []
      : [{ path: `items.${i}.tierId`, message: 'Not a ticket tier of this event' }],
  );
  if (missing.length > 0) throw bodyFieldErrors(missing);

  for (const item of items) {
    const tier = tiers.get(item.tierId)!;
    // A tier without its own window sells for the whole event sale window.
    const opens = tier.saleStartsAt ?? event.saleStartsAt;
    const closes = tier.saleEndsAt ?? event.saleEndsAt;
    if (now < opens) {
      throw new ConflictError('SALE_NOT_STARTED', 'Tickets are not on sale yet', {
        tierId: tier.id,
        opensAt: opens.toISOString(),
      });
    }
    if (now >= closes) {
      throw new ConflictError('SALE_ENDED', 'Ticket sales have ended', { tierId: tier.id });
    }
  }
}

export interface OrderResult {
  answer: BookingAnswer;
  /** True when this is a stored answer to an earlier request with the same key. */
  replayed: boolean;
}

export async function createOrder(
  userId: string,
  eventId: string,
  idempotencyKey: string,
  input: CreateOrderInput,
): Promise<OrderResult> {
  const requestHash = hashRequest(eventId, input.items);

  // A retry of a request that already ran gets the same answer, even if the sale has closed since.
  const stored = await findStoredAnswer(prisma, userId, idempotencyKey, requestHash);
  if (stored === 'key-reused') throw keyReused();
  if (stored) return { answer: stored, replayed: true };

  await assertOnSale(eventId, input.items, new Date());
  const answer = await reserveTickets({
    userId,
    eventId,
    items: input.items,
    holdMinutes: env.HOLD_MINUTES,
    idempotencyKey,
    requestHash,
  });
  if (answer === 'key-reused') throw keyReused();
  // Not perfectly exact: a concurrent duplicate that waited on the lock also gets a stored answer here,
  // and is reported as new. The answer itself is the same either way.
  return { answer, replayed: false };
}
