import { createHash } from 'node:crypto';
import { findStoredAnswer, reserveTickets, type BookingAnswer } from '@festpass/db/booking';
import { prisma } from '@festpass/db';
import { perUserLimit, soldOut, type CreateOrderInput } from '@festpass/shared';
import { env } from '../../config/env.js';
import { AppError, bodyFieldErrors, ConflictError, NotFoundError } from '../../lib/errors.js';
import { releaseInRedis, reserveInRedis, type GateItem } from './gate.js';
import { syncInventory } from './inventory.js';
import * as repo from './repository.js';
import { bookingStats } from './stats.js';

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
 * Returns the requested tiers (name and limit), which the gate needs.
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
  return tiers;
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

  const tiers = await assertOnSale(eventId, input.items, new Date());
  const gateItems: GateItem[] = input.items.map((i) => ({
    ...i,
    perUserLimit: tiers.get(i.tierId)!.perUserLimit,
  }));

  // 1. Redis gate: most of a flash-sale crowd is refused here, in memory. Its "no" answers are not
  //    stored under the Idempotency-Key (that would cost a Postgres write per refusal, which is what
  //    the gate exists to avoid): nothing was booked, so a retry simply asks again.
  const gate = await reserveInRedis(eventId, userId, idempotencyKey, gateItems);
  if (gate.kind === 'sold-out' || gate.kind === 'over-limit') {
    bookingStats.rejectedAtGate++;
    const tier = tiers.get(gate.tierId)!;
    const refusal = gate.kind === 'sold-out' ? soldOut(tier) : perUserLimit(tier, gate.held);
    throw new ConflictError(refusal.code, refusal.message, refusal.details);
  }
  if (gate.kind === 'skipped') bookingStats.gateSkipped++;

  // 2. Postgres decides (Day 11). 3. Compensation: if Redis took stock for an order Postgres didn't
  //    book (refused, a replay, or an error), give it back so Redis doesn't drift low.
  const compensate = async () => {
    if (gate.kind !== 'passed') return;
    bookingStats.compensated++;
    await releaseInRedis(eventId, userId, gateItems);
  };
  let result;
  try {
    result = await reserveTickets({
      userId,
      eventId,
      items: input.items,
      holdMinutes: env.HOLD_MINUTES,
      idempotencyKey,
      requestHash,
    });
  } catch (err) {
    await compensate();
    throw err;
  }
  if (result === 'key-reused' || result.outcome !== 'booked') await compensate();
  // Tiers Redis didn't know get their keys now (after the commit, so they include this booking), and
  // the next request is gated again.
  if (gate.kind === 'skipped' && gate.reason.startsWith('no inventory key'))
    void syncInventory(eventId);
  if (result === 'key-reused') throw keyReused();
  if (result.outcome === 'booked') bookingStats.booked++;
  if (result.outcome === 'rejected') bookingStats.rejectedAtPostgres++;
  return { answer: result.answer, replayed: result.outcome === 'replayed' };
}
