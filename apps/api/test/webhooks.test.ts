import { randomUUID } from 'node:crypto';
import { prisma } from '@festpass/db';
import { releaseHold } from '@festpass/db/booking';
import { truncateAll } from '@festpass/db/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paymentsQueue, ticketsQueue } from '../src/lib/queues.js';
import { gateRedis } from '../src/lib/redis.js';
import { sign } from '../src/modules/webhooks/signature.js';
import { app, book, createSaleEvent, makeOrg, makeUser } from './helpers.js';

const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET!;

beforeEach(async () => {
  await truncateAll(prisma);
  if (gateRedis.options.db !== 15) throw new Error('tests must use redis database 15');
  await gateRedis.flushdb();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => prisma.$disconnect());

/** A buyer holding 2 tickets (₹299 each) of a tier with `capacity`. */
async function heldOrder(capacity = 10) {
  const owner = await makeUser('Organizer');
  const orgId = await makeOrg(owner);
  const { eventId, tierIds } = await createSaleEvent(owner, orgId, [{ name: 'Regular', capacity }]);
  const buyer = await makeUser('Buyer');
  const res = await book(buyer, eventId, [{ tierId: tierIds[0]!, qty: 2 }]);
  return { orderId: res.body.order.id as string, tierId: tierIds[0]!, eventId };
}

/** A body shaped like Razorpay's, for one payment of our order (matched through notes.orderId). */
const captured = (
  orderId: string,
  paymentId = `pay_${randomUUID().slice(0, 14)}`,
  event = 'payment.captured',
) =>
  JSON.stringify({
    entity: 'event',
    event,
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          amount: 59_800,
          currency: 'INR',
          status: 'captured',
          order_id: null,
          notes: { orderId },
        },
      },
    },
  });

const deliver = (body: string, signature: string | null = sign(body, SECRET)) => {
  const req = request(app)
    .post('/api/v1/webhooks/razorpay')
    .set('Content-Type', 'application/json');
  if (signature !== null) req.set('X-Razorpay-Signature', signature);
  return req.send(body);
};

const orderStatus = async (orderId: string) =>
  (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;
const soldCount = async (tierId: string) =>
  (await prisma.ticketTier.findUniqueOrThrow({ where: { id: tierId } })).soldCount;

describe('signature check', () => {
  it.each([
    ['a wrong signature', 'deadbeef'.repeat(8)],
    ['no signature', null],
    ['a signature from another secret', sign('x', 'another-secret-0123456789')],
  ])('%s gets 400 and changes nothing', async (_name, signature) => {
    const { orderId } = await heldOrder();
    const res = await deliver(captured(orderId), signature);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(await prisma.payment.count()).toBe(0);
    expect(await orderStatus(orderId)).toBe('PENDING');
  });

  it('a body changed after signing fails (the signature covers the exact bytes)', async () => {
    const { orderId } = await heldOrder();
    const body = captured(orderId);
    const signature = sign(body, SECRET);
    // Same JSON value, different bytes: re-serialising would break the signature just like this.
    const reformatted = JSON.stringify(JSON.parse(body), null, 2);

    expect((await deliver(reformatted, signature)).status).toBe(400);
    expect((await deliver(body, signature)).status).toBe(200);
  });
});

describe('payment.captured', () => {
  it('records the payment, moves the order to PAID and queues issue-tickets keyed by the order ID', async () => {
    const { orderId } = await heldOrder();

    const res = await deliver(captured(orderId, 'pay_once'));

    expect(res.body).toEqual({ handled: true, outcome: 'paid' });
    expect(await orderStatus(orderId)).toBe('PAID');
    expect(
      await prisma.payment.findMany({ select: { razorpayPaymentId: true, status: true } }),
    ).toEqual([{ razorpayPaymentId: 'pay_once', status: 'captured' }]);
    expect((await ticketsQueue.getJob(orderId))?.data).toMatchObject({ orderId });
  });

  it('the same webhook 5 times, one after another: one payment, one PAID transition, one job', async () => {
    const { orderId } = await heldOrder();
    const body = captured(orderId, 'pay_repeat');
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push((await deliver(body)).body.outcome);

    expect(outcomes).toEqual(['paid', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
    expect(await prisma.payment.count()).toBe(1);
    expect(await orderStatus(orderId)).toBe('PAID');
    expect(await ticketsQueue.getJobCountByTypes('waiting', 'active', 'completed', 'failed')).toBe(
      1,
    );
  });

  it('5 copies at the same moment, plus order.paid for the same payment: still one of each', async () => {
    const { orderId } = await heldOrder();
    const responses = await Promise.all([
      ...Array.from({ length: 5 }, () => deliver(captured(orderId, 'pay_burst'))),
      deliver(captured(orderId, 'pay_burst', 'order.paid')),
    ]);

    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(responses.filter((r) => r.body.outcome === 'paid')).toHaveLength(1);
    expect(await prisma.payment.count()).toBe(1);
    expect(await ticketsQueue.getJobCountByTypes('waiting')).toBe(1);
  });

  it('if queuing the job failed, a redelivery queues it (follow-ups come from stored state)', async () => {
    const { orderId } = await heldOrder();
    const body = captured(orderId, 'pay_retry');
    vi.spyOn(ticketsQueue, 'add').mockRejectedValueOnce(new Error('Connection is closed.'));

    const first = await deliver(body);
    const redelivered = await deliver(body);

    expect(first.status).toBe(500); // Razorpay will deliver again
    expect(redelivered.body.outcome).toBe('duplicate');
    expect(await ticketsQueue.getJob(orderId)).toBeDefined();
  });

  it('other events are acknowledged and ignored; payments for unknown orders too', async () => {
    const { orderId } = await heldOrder();
    const failed = await deliver(captured(orderId, 'pay_failed', 'payment.failed'));
    const stranger = await deliver(captured(randomUUID()));

    expect(failed.body).toEqual({ handled: false, reason: 'ignored payment.failed' });
    expect(stranger.body).toEqual({ handled: false, reason: 'unknown order' });
    expect(await prisma.payment.count()).toBe(0);
  });
});

describe('late payments', () => {
  async function expire(orderId: string) {
    await prisma.order.update({
      where: { id: orderId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await releaseHold(orderId, 'EXPIRED');
  }

  it('paid after the hold expired, tickets still there: re-reserved and PAID', async () => {
    const { orderId, tierId } = await heldOrder();
    await expire(orderId);
    expect(await soldCount(tierId)).toBe(0);

    const res = await deliver(captured(orderId));

    expect(res.body.outcome).toBe('paid');
    expect(await orderStatus(orderId)).toBe('PAID');
    expect(await soldCount(tierId)).toBe(2);
    expect(await ticketsQueue.getJob(orderId)).toBeDefined();
  });

  it('paid after the hold expired, tickets gone: stays EXPIRED and a refund is queued', async () => {
    const { orderId, tierId } = await heldOrder(2);
    await expire(orderId);
    await prisma.ticketTier.update({ where: { id: tierId }, data: { soldCount: 1 } }); // only 1 left

    const res = await deliver(captured(orderId, 'pay_late'));

    expect(res.body.outcome).toBe('refund');
    expect(await orderStatus(orderId)).toBe('EXPIRED');
    expect(await soldCount(tierId)).toBe(1); // nothing taken, not even partly
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { razorpayPaymentId: 'pay_late' },
    });
    expect(payment.status).toBe('refund_pending');
    expect((await paymentsQueue.getJob(payment.id))?.data).toMatchObject({ paymentId: payment.id });
    expect(await ticketsQueue.getJob(orderId)).toBeUndefined();
  });

  it('a second, different payment for a paid order is refunded and the order stays PAID', async () => {
    const { orderId } = await heldOrder();
    await deliver(captured(orderId, 'pay_first'));

    const second = await deliver(captured(orderId, 'pay_second'));

    expect(second.body.outcome).toBe('refund');
    expect(await orderStatus(orderId)).toBe('PAID');
    const refund = await prisma.payment.findUniqueOrThrow({
      where: { razorpayPaymentId: 'pay_second' },
    });
    expect(refund.status).toBe('refund_pending');
  });

  it('a payment for a cancelled order is refunded', async () => {
    const { orderId } = await heldOrder();
    await releaseHold(orderId, 'CANCELLED');

    expect((await deliver(captured(orderId))).body.outcome).toBe('refund');
    expect(await orderStatus(orderId)).toBe('CANCELLED');
  });
});
