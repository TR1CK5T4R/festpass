import { perUserLimit, soldOut, type OrderView } from '@festpass/shared';
import { Prisma, prisma } from './index.js';

// The booking path, in hand-written SQL so every lock it takes is visible and explainable.
//
// Correctness comes from Postgres alone: a conditional UPDATE per tier (the row lock decides who gets the
// last ticket) and the CHECK constraint sold_count <= capacity behind it. Nothing here makes a network
// call; the transaction holds row locks, and a slow call inside it would make every other buyer wait.

type Db = Prisma.TransactionClient | typeof prisma;

export interface BookingItem {
  tierId: string;
  qty: number;
}

/**
 * The answer to a booking request, exactly as it is stored for its Idempotency-Key and replayed for
 * retries: 201 with the order, or a 4xx with the error code the client should see.
 */
export type BookingAnswer =
  | { status: 201; body: { order: OrderView } }
  | {
      status: 404 | 409;
      body: { code: string; message: string; details: Record<string, unknown> };
    };

export interface ReserveInput {
  userId: string;
  eventId: string;
  items: BookingItem[];
  holdMinutes: number;
  idempotencyKey: string;
  /** SHA-256 of the request, to tell a retry from a different request that reuses the key. */
  requestHash: string;
}

/**
 * What one call did: booked the order, refused it (sold out, over the limit), or returned an earlier
 * answer for the same key. The caller gives Redis stock back unless it booked.
 */
export type BookingOutcome =
  { answer: BookingAnswer; outcome: 'booked' | 'rejected' | 'replayed' } | 'key-reused';

/** The stored answer for this key, 'key-reused' if the key belongs to a different request, or null. */
export async function findStoredAnswer(
  db: Db,
  userId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<BookingAnswer | 'key-reused' | null> {
  const [row] = await db.$queryRaw<{ request_hash: string; status: number; response: unknown }[]>`
    SELECT request_hash, status, response FROM idempotency_keys
    WHERE user_id = ${userId}::uuid AND key = ${idempotencyKey}::uuid`;
  if (!row) return null;
  if (row.request_hash !== requestHash) return 'key-reused';
  return { status: row.status, body: row.response } as BookingAnswer;
}

/**
 * Reserves tickets and creates a PENDING order that holds them for `holdMinutes`, in one transaction.
 * Returns the answer (also stored under the Idempotency-Key) and what happened, or 'key-reused'.
 */
export async function reserveTickets(input: ReserveInput): Promise<BookingOutcome> {
  try {
    return await prisma.$transaction((tx) => reserveInTransaction(tx, input), {
      // READ COMMITTED is enough: a conditional UPDATE re-checks its WHERE clause against the latest
      // committed row once it gets the row lock, and each statement sees everything committed before it.
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      // In a flash sale many transactions queue for the same tier row and for pool connections.
      // Each one is a few milliseconds, but the queue can be long; these bound the wait.
      maxWait: 10_000,
      timeout: 10_000,
    });
  } catch (err) {
    // Two requests with the same key for *different* events don't share an advisory lock, so both can
    // reach the INSERT; the unique (user_id, key) index stops the second, and its whole transaction
    // (order included) rolls back. It then gets the first request's answer, which is 'key-reused'.
    if (!isUniqueViolation(err)) throw err;
    const stored = await findStoredAnswer(
      prisma,
      input.userId,
      input.idempotencyKey,
      input.requestHash,
    );
    if (!stored) throw err;
    return stored === 'key-reused' ? stored : { answer: stored, outcome: 'replayed' };
  }
}

async function reserveInTransaction(
  tx: Prisma.TransactionClient,
  { userId, eventId, items, holdMinutes, idempotencyKey, requestHash }: ReserveInput,
): Promise<BookingOutcome> {
  // 1. One user's requests for one event run one at a time from here until COMMIT or ROLLBACK, when
  //    Postgres releases the lock by itself. Without it, 20 parallel requests from one user could all
  //    read "you hold 0 tickets" before any of them inserts its order, and all pass the per-user limit.
  //    Other users are not affected: the lock is keyed on (userId, eventId).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${eventId}`}, 0))`;

  // 2. A retry of the same request that was waiting on the lock now finds the first one's answer.
  const stored = await findStoredAnswer(tx, userId, idempotencyKey, requestHash);
  if (stored === 'key-reused') return stored;
  if (stored) return { answer: stored, outcome: 'replayed' };

  const store = (a: BookingAnswer) => storeAnswer(tx, userId, idempotencyKey, requestHash, a);
  const reject = async (
    status: 404 | 409,
    body: { code: string; message: string; details: Record<string, unknown> },
  ) => ({ answer: await store({ status, body }), outcome: 'rejected' }) as const;

  // 3. Per-user limit: tickets this user already holds in each tier (unpaid holds count too, or someone
  //    could stack holds to block a tier), plus this request, must stay within the tier's limit.
  const tierIds = items.map((i) => i.tierId);
  const tiers = await tx.$queryRaw<
    { id: string; name: string; per_user_limit: number; held: number }[]
  >`
    SELECT t.id, t.name, t.per_user_limit,
           COALESCE((SELECT SUM(oi.qty) FROM order_items oi
                     JOIN orders o ON o.id = oi.order_id
                     WHERE oi.tier_id = t.id AND o.user_id = ${userId}::uuid
                       AND o.status IN ('PENDING', 'PAID', 'TICKETED')), 0)::int AS held
    FROM ticket_tiers t
    WHERE t.event_id = ${eventId}::uuid AND t.id = ANY(${tierIds}::uuid[])`;
  const byId = new Map(tiers.map((t) => [t.id, t]));
  for (const item of items) {
    const tier = byId.get(item.tierId);
    if (!tier) {
      return reject(404, {
        code: 'NOT_FOUND',
        message: 'Ticket tier not found',
        details: { tierId: item.tierId },
      });
    }
    if (tier.held + item.qty > tier.per_user_limit) {
      return reject(409, perUserLimit({ ...tier, perUserLimit: tier.per_user_limit }, tier.held));
    }
  }

  // 4. Take the tickets. Each UPDATE locks its tier row; sorting by tier ID makes every transaction lock
  //    rows in the same order, so two orders for tiers {A, B} and {B, A} can't each hold one row while
  //    waiting for the other (a deadlock). The WHERE clause is the whole check: there is no "read the
  //    count, then write" gap for another request to slip into. The savepoint lets a sold-out tier undo
  //    the tiers already taken while the transaction still commits its stored answer.
  await tx.$executeRaw`SAVEPOINT reserve`;
  const sorted = [...items].sort((a, b) => (a.tierId < b.tierId ? -1 : 1));
  const prices = new Map<string, number>();
  for (const item of sorted) {
    const [row] = await tx.$queryRaw<{ price_paise: number }[]>`
      UPDATE ticket_tiers
      SET sold_count = sold_count + ${item.qty}, updated_at = now()
      WHERE id = ${item.tierId}::uuid AND sold_count + ${item.qty} <= capacity
      RETURNING price_paise`;
    if (!row) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT reserve`;
      return reject(409, soldOut(byId.get(item.tierId)!));
    }
    // The price comes from the locked row, so an organizer's edit can't change it mid-booking.
    prices.set(item.tierId, row.price_paise);
  }

  // 5. The order holds the tickets until expires_at; an expired hold gives them back (Day 13).
  const amount = items.reduce((sum, i) => sum + i.qty * prices.get(i.tierId)!, 0);
  const [order] = await tx.$queryRaw<{ id: string; expires_at: Date }[]>`
    INSERT INTO orders (user_id, event_id, status, amount_paise, expires_at)
    VALUES (${userId}::uuid, ${eventId}::uuid, 'PENDING', ${amount},
            now() + make_interval(mins => ${holdMinutes}::int))
    RETURNING id, expires_at`;
  for (const item of items) {
    await tx.$executeRaw`
      INSERT INTO order_items (order_id, tier_id, qty, unit_price_paise)
      VALUES (${order!.id}::uuid, ${item.tierId}::uuid, ${item.qty}, ${prices.get(item.tierId)!})`;
  }

  const created = await store({
    status: 201,
    body: {
      order: {
        id: order!.id,
        eventId,
        status: 'PENDING',
        amountPaise: amount,
        expiresAt: order!.expires_at.toISOString(),
        items: items.map((i) => ({
          tierId: i.tierId,
          tierName: byId.get(i.tierId)!.name,
          qty: i.qty,
          unitPricePaise: prices.get(i.tierId)!,
        })),
      },
    },
  });
  return { answer: created, outcome: 'booked' };
}

/** Saves the answer under the key in the same transaction as the order, so they commit or fail together. */
async function storeAnswer(
  tx: Prisma.TransactionClient,
  userId: string,
  idempotencyKey: string,
  requestHash: string,
  answer: BookingAnswer,
): Promise<BookingAnswer> {
  await tx.$executeRaw`
    INSERT INTO idempotency_keys (user_id, key, request_hash, status, response)
    VALUES (${userId}::uuid, ${idempotencyKey}::uuid, ${requestHash}, ${answer.status},
            ${JSON.stringify(answer.body)}::jsonb)`;
  return answer;
}

function isUniqueViolation(err: unknown): boolean {
  // Prisma reports raw-query failures as P2010 and keeps the Postgres error code (23505 = unique_violation).
  type AdapterMeta = { driverAdapterError?: { cause?: { originalCode?: string } } };
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    (err.meta as AdapterMeta | undefined)?.driverAdapterError?.cause?.originalCode === '23505'
  );
}
