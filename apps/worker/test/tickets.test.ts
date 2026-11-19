import { randomUUID } from 'node:crypto';
import { prisma } from '@festpass/db';
import { truncateAll } from '@festpass/db/testing';
import { pino } from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { issueOrderTickets } from '../src/processors.js';

const log = pino({ level: 'silent' });

beforeEach(() => truncateAll(prisma));
afterAll(() => prisma.$disconnect());

/** An order for 2 Regular + 1 VIP tickets in the given status. */
async function order(status: 'PAID' | 'PENDING') {
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@test.dev`, name: 'Buyer', passwordHash: 'x' },
  });
  const org = await prisma.organization.create({
    data: { name: 'Club', slug: `club-${randomUUID()}` },
  });
  const event = await prisma.event.create({
    data: {
      orgId: org.id,
      title: 'Fest',
      slug: `fest-${randomUUID()}`,
      description: '',
      venue: 'Hall',
      startsAt: new Date(Date.now() + 48 * 3600_000),
      endsAt: new Date(Date.now() + 50 * 3600_000),
      saleStartsAt: new Date(Date.now() - 3600_000),
      saleEndsAt: new Date(Date.now() + 24 * 3600_000),
      status: 'PUBLISHED',
      tiers: {
        create: [
          { name: 'Regular', pricePaise: 10_000, capacity: 10, soldCount: 2 },
          { name: 'VIP', pricePaise: 50_000, capacity: 5, soldCount: 1 },
        ],
      },
    },
    include: { tiers: true },
  });
  const [regular, vip] = event.tiers;
  return prisma.order.create({
    data: {
      userId: user.id,
      eventId: event.id,
      status,
      amountPaise: 70_000,
      expiresAt: new Date(Date.now() + 600_000),
      items: {
        create: [
          { tierId: regular!.id, qty: 2, unitPricePaise: 10_000 },
          { tierId: vip!.id, qty: 1, unitPricePaise: 50_000 },
        ],
      },
    },
  });
}

const tickets = (orderId: string) =>
  prisma.ticket.findMany({
    where: { orderId },
    orderBy: { seq: 'asc' },
    select: { seq: true, qrVersion: true },
  });

describe('issue-tickets', () => {
  it('a paid order gets one ticket per unit, numbered 1..n, and becomes TICKETED', async () => {
    const { id } = await order('PAID');

    expect(await issueOrderTickets({ orderId: id }, log)).toEqual({
      issued: 3,
      status: 'TICKETED',
    });

    expect(await tickets(id)).toEqual([
      { seq: 1, qrVersion: 1 },
      { seq: 2, qrVersion: 1 },
      { seq: 3, qrVersion: 1 },
    ]);
    expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('TICKETED');
  });

  it('running the job twice (or at the same time) creates the tickets once', async () => {
    const { id } = await order('PAID');

    await Promise.all([
      issueOrderTickets({ orderId: id }, log),
      issueOrderTickets({ orderId: id }, log),
    ]);
    const again = await issueOrderTickets({ orderId: id }, log);

    expect(again).toEqual({ issued: 0, status: 'TICKETED' });
    expect(await tickets(id)).toHaveLength(3);
  });

  it('an order that is not paid gets no tickets', async () => {
    const { id } = await order('PENDING');
    expect(await issueOrderTickets({ orderId: id }, log)).toEqual({ issued: 0, status: 'PENDING' });
    expect(await tickets(id)).toEqual([]);
  });
});
