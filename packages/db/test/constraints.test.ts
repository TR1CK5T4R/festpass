import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/index.js';

// Each run creates its own org, event and tier with a unique slug, then deletes them.
const slug = `constraint-test-${randomUUID()}`;
let tierId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: 'Constraint test', slug } });
  const event = await prisma.event.create({
    data: {
      orgId: org.id,
      title: 'Constraint test',
      slug,
      description: '',
      venue: '',
      startsAt: new Date('2027-01-01T10:00:00Z'),
      endsAt: new Date('2027-01-01T18:00:00Z'),
      saleStartsAt: new Date('2026-12-01T00:00:00Z'),
      saleEndsAt: new Date('2026-12-31T00:00:00Z'),
      tiers: { create: { name: 'Regular', pricePaise: 10_000, capacity: 10 } },
    },
    include: { tiers: true },
  });
  tierId = event.tiers[0]!.id;
});

afterAll(async () => {
  await prisma.event.deleteMany({ where: { slug } }); // cascades to the tier
  await prisma.organization.deleteMany({ where: { slug } });
  await prisma.$disconnect();
});

describe('ticket_tiers CHECK constraints', () => {
  it('allows selling up to exactly capacity', async () => {
    const updated = await prisma.$executeRaw`
      UPDATE ticket_tiers SET sold_count = capacity WHERE id = ${tierId}::uuid`;

    expect(updated).toBe(1);
  });

  // Raw SQL on purpose: this is the path the booking engine uses, and it bypasses any app-level checks.
  it('rejects sold_count above capacity', async () => {
    await expect(
      prisma.$executeRaw`UPDATE ticket_tiers SET sold_count = capacity + 1 WHERE id = ${tierId}::uuid`,
    ).rejects.toThrow(/ticket_tiers_sold_count_within_capacity/);
  });

  it('rejects a negative sold_count', async () => {
    await expect(
      prisma.$executeRaw`UPDATE ticket_tiers SET sold_count = -1 WHERE id = ${tierId}::uuid`,
    ).rejects.toThrow(/ticket_tiers_sold_count_within_capacity/);
  });

  it('rejects a per-user limit outside 1..10', async () => {
    await expect(
      prisma.ticketTier.update({ where: { id: tierId }, data: { perUserLimit: 11 } }),
    ).rejects.toThrow(/ticket_tiers_per_user_limit_range/);
  });
});

describe('tickets (order_id, event_id) foreign key', () => {
  it("refuses a ticket whose event isn't its order's event", async () => {
    const { eventId: ownEvent } = await prisma.ticketTier.findUniqueOrThrow({
      where: { id: tierId },
    });
    const other = await prisma.event.create({
      data: {
        orgId: (await prisma.event.findUniqueOrThrow({ where: { id: ownEvent } })).orgId,
        title: 'Other',
        slug: `${slug}-other`,
        description: '',
        venue: '',
        startsAt: new Date('2027-01-01T10:00:00Z'),
        endsAt: new Date('2027-01-01T18:00:00Z'),
        saleStartsAt: new Date('2026-12-01T00:00:00Z'),
        saleEndsAt: new Date('2026-12-31T00:00:00Z'),
      },
    });
    const user = await prisma.user.create({
      data: { email: `${slug}@test.dev`, name: 'Buyer', passwordHash: 'x' },
    });
    const order = await prisma.order.create({
      data: { userId: user.id, eventId: ownEvent, amountPaise: 0, expiresAt: new Date() },
    });
    const insert = (eventId: string, seq: number) => prisma.$executeRaw`
      INSERT INTO tickets (order_id, event_id, tier_id, owner_user_id, seq, code)
      VALUES (${order.id}::uuid, ${eventId}::uuid, ${tierId}::uuid, ${user.id}::uuid, ${seq},
              ${`${slug}-${seq}`})`;
    try {
      await expect(insert(other.id, 1)).rejects.toThrow(/tickets_order_id_event_id_fkey/);
      await expect(insert(ownEvent, 2)).resolves.toBe(1);
    } finally {
      await prisma.ticket.deleteMany({ where: { orderId: order.id } });
      await prisma.order.delete({ where: { id: order.id } });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.event.delete({ where: { id: other.id } });
    }
  });
});
