import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reserveTickets } from '../src/booking.js';
import { prisma } from '../src/index.js';

// Each run creates its own user, org, event and tier with unique names, then deletes them.
const slug = `booking-test-${randomUUID()}`;
let userId: string;
let eventId: string;
let tierId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `${slug}@test.dev`, name: 'Booking test', passwordHash: 'x' },
  });
  const org = await prisma.organization.create({ data: { name: 'Booking test', slug } });
  const event = await prisma.event.create({
    data: {
      orgId: org.id,
      title: 'Booking test',
      slug,
      description: '',
      venue: '',
      startsAt: new Date('2027-01-01T10:00:00Z'),
      endsAt: new Date('2027-01-01T18:00:00Z'),
      saleStartsAt: new Date('2026-01-01T00:00:00Z'),
      saleEndsAt: new Date('2026-12-31T00:00:00Z'),
      status: 'PUBLISHED',
      tiers: { create: { name: 'Regular', pricePaise: 10_000, capacity: 10 } },
    },
    include: { tiers: true },
  });
  userId = user.id;
  eventId = event.id;
  tierId = event.tiers[0]!.id;
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } }); // idempotency keys cascade
  await prisma.event.delete({ where: { id: eventId } });
  await prisma.organization.delete({ where: { slug } });
  await prisma.$disconnect();
});

describe('reserveTickets', () => {
  it('when another request stores the same key first, the whole booking rolls back and reports key-reused', async () => {
    const key = randomUUID();
    let booking: Promise<unknown> | undefined;

    // Another request (here: a hand-held transaction) has inserted this key but not committed. The
    // booking can't see that row yet, so it reserves a ticket and then blocks on the unique index
    // when it inserts its own key. Once the other transaction commits, the booking's INSERT fails.
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          INSERT INTO idempotency_keys (user_id, key, request_hash, status, response)
          VALUES (${userId}::uuid, ${key}::uuid, 'another-request', 201, '{}'::jsonb)`;
        booking = reserveTickets({
          userId,
          eventId,
          items: [{ tierId, qty: 1 }],
          holdMinutes: 10,
          idempotencyKey: key,
          requestHash: 'this-request',
        });
        await new Promise((resolve) => setTimeout(resolve, 500)); // let it reach the INSERT and wait
      },
      { timeout: 5000 },
    );

    expect(await booking).toBe('key-reused');
    const tier = await prisma.ticketTier.findUniqueOrThrow({ where: { id: tierId } });
    expect(tier.soldCount).toBe(0); // its UPDATE was rolled back with everything else
    expect(await prisma.order.count({ where: { userId } })).toBe(0);
  });
});
