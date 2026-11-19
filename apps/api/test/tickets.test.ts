import { prisma } from '@festpass/db';
import { recordCapturedPayment } from '@festpass/db/payments';
import { issueTickets } from '@festpass/db/tickets';
import { truncateAll } from '@festpass/db/testing';
import { verifyTicket } from '@festpass/shared';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { gateRedis } from '../src/lib/redis.js';
import {
  app,
  book,
  createSaleEvent,
  makeOrg,
  makeUser,
  makeUsers,
  type TestUser,
} from './helpers.js';

const PUBLIC_KEY = process.env.TICKET_PUBLIC_KEY_FOR_TESTS!;

beforeEach(async () => {
  await truncateAll(prisma);
  if (gateRedis.options.db !== 15) throw new Error('tests must use redis database 15');
  await gateRedis.flushdb();
});
afterAll(() => prisma.$disconnect());

/** A buyer with a paid, ticketed order for 3 tickets: what the webhook and the worker leave behind. */
async function ticketedOrder() {
  const owner = await makeUser('Organizer');
  const orgId = await makeOrg(owner);
  const { eventId, tierIds } = await createSaleEvent(owner, orgId, [
    { name: 'Regular', capacity: 10 },
  ]);
  const buyer = await makeUser('Buyer');
  const booked = await book(buyer, eventId, [{ tierId: tierIds[0]!, qty: 3 }]);
  const orderId = booked.body.order.id as string;
  await recordCapturedPayment({
    orderId,
    razorpayPaymentId: `pay_${orderId.slice(0, 8)}`,
    rawPayload: {},
  });
  await issueTickets(orderId);
  return { buyer, orderId, eventId };
}

const myTickets = (user: TestUser) => request(app).get('/api/v1/me/tickets').set(user.auth);

describe('tickets', () => {
  it('GET /me/tickets lists the tickets with QR strings that verify with the public key', async () => {
    const { buyer, orderId, eventId } = await ticketedOrder();

    const res = await myTickets(buyer);

    expect(res.status).toBe(200);
    expect(res.body.tickets.map((t: { seq: number }) => t.seq)).toEqual([1, 2, 3]);
    for (const ticket of res.body.tickets) {
      expect(ticket).toMatchObject({
        orderId,
        qrVersion: 1,
        checkedInAt: null,
        tier: { name: 'Regular' },
      });
      expect(ticket.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(await verifyTicket(ticket.qr, PUBLIC_KEY)).toEqual({
        valid: true,
        payload: { t: ticket.id, e: eventId, v: 1, iat: expect.any(Number) },
      });
    }
  });

  it('the same ticket always gets the same QR string (nothing stored, nothing random)', async () => {
    const { buyer } = await ticketedOrder();
    const [first, second] = [await myTickets(buyer), await myTickets(buyer)];
    expect(second.body.tickets.map((t: { qr: string }) => t.qr)).toEqual(
      first.body.tickets.map((t: { qr: string }) => t.qr),
    );
  });

  it('GET /tickets/:id is for the owner only; others get 404 and an empty list', async () => {
    const { buyer } = await ticketedOrder();
    const [stranger] = await makeUsers(1);
    const ticketId = (await myTickets(buyer)).body.tickets[0].id as string;

    const mine = await request(app).get(`/api/v1/tickets/${ticketId}`).set(buyer.auth);
    const theirs = await request(app).get(`/api/v1/tickets/${ticketId}`).set(stranger!.auth);

    expect(mine.body.ticket.id).toBe(ticketId);
    expect(theirs.status).toBe(404);
    expect((await myTickets(stranger!)).body.tickets).toEqual([]);
  });

  it('reissuing bumps qrVersion: the new QR says v=2, so the old one (v=1) is now outdated', async () => {
    const { buyer } = await ticketedOrder();
    const before = (await myTickets(buyer)).body.tickets[0];

    const res = await request(app).post(`/api/v1/tickets/${before.id}/reissue`).set(buyer.auth);

    expect(res.body.ticket.qrVersion).toBe(2);
    expect(res.body.ticket.qr).not.toBe(before.qr);
    const [old, current] = [
      await verifyTicket(before.qr, PUBLIC_KEY),
      await verifyTicket(res.body.ticket.qr, PUBLIC_KEY),
    ];
    // Both are genuine signatures; the gate (Day 19) compares the version with the database.
    expect(old.valid && old.payload.v).toBe(1);
    expect(current.valid && current.payload.v).toBe(2);
  });

  it('a ticket already used at the gate cannot be reissued', async () => {
    const { buyer } = await ticketedOrder();
    const ticket = (await myTickets(buyer)).body.tickets[0];
    await prisma.ticket.update({ where: { id: ticket.id }, data: { checkedInAt: new Date() } });

    const res = await request(app).post(`/api/v1/tickets/${ticket.id}/reissue`).set(buyer.auth);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TICKET_USED');
  });
});
