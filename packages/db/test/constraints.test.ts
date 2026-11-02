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
