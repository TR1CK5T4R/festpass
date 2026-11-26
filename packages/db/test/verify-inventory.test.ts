import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/index.js';
import { findInventoryProblems } from '../src/inventory.js';

// The load-test check (pnpm loadtest:verify) must fail on any oversell, so it is tested on data broken
// on purpose. Its own event, users and orders are removed afterwards.
const slug = `verify-test-${randomUUID()}`;
let eventId: string;
let tierId: string;
let userId: string;

const order = (status: 'PENDING' | 'TICKETED' | 'EXPIRED', qty: number) =>
  prisma.order.create({
    data: {
      userId,
      eventId,
      status,
      amountPaise: 0,
      expiresAt: new Date(),
      items: { create: { tierId, qty, unitPricePaise: 0 } },
    },
  });

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: 'Verify test', slug } });
  const event = await prisma.event.create({
    data: {
      orgId: org.id,
      title: 'Verify test',
      slug,
      description: '',
      venue: '',
      startsAt: new Date('2027-01-01T10:00:00Z'),
      endsAt: new Date('2027-01-01T18:00:00Z'),
      saleStartsAt: new Date('2026-12-01T00:00:00Z'),
      saleEndsAt: new Date('2026-12-31T00:00:00Z'),
      tiers: { create: { name: 'Regular', pricePaise: 0, capacity: 5 } },
    },
    include: { tiers: true },
  });
  eventId = event.id;
  tierId = event.tiers[0]!.id;
  userId = (
    await prisma.user.create({ data: { email: `${slug}@test.dev`, name: 'B', passwordHash: 'x' } })
  ).id;
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { eventId } }); // cascades to the items
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.event.deleteMany({ where: { slug } });
  await prisma.organization.deleteMany({ where: { slug } });
  await prisma.$disconnect();
});

const setSold = (soldCount: number) =>
  prisma.ticketTier.update({ where: { id: tierId }, data: { soldCount } });

describe('findInventoryProblems', () => {
  it('passes when sold_count is exactly what live orders hold (expired ones not counted)', async () => {
    await order('TICKETED', 2);
    await order('PENDING', 1);
    await order('EXPIRED', 4);
    await setSold(3);

    expect(await findInventoryProblems(prisma, eventId)).toEqual([]);
  });

  it('fails when sold_count and the orders disagree', async () => {
    await setSold(2);

    expect(await findInventoryProblems(prisma, eventId)).toEqual([
      expect.objectContaining({ tierId, capacity: 5, soldCount: 2, held: 3 }),
    ]);
  });

  it('fails on an oversell: orders holding more tickets than the tier has', async () => {
    await order('TICKETED', 3); // 6 held, capacity 5
    await setSold(5);

    expect(await findInventoryProblems(prisma, eventId)).toEqual([
      expect.objectContaining({ tierId, capacity: 5, soldCount: 5, held: 6 }),
    ]);
  });
});
