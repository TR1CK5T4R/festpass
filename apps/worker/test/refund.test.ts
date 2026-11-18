import { randomUUID } from 'node:crypto';
import { prisma } from '@festpass/db';
import { recordCapturedPayment } from '@festpass/db/payments';
import { truncateAll } from '@festpass/db/testing';
import { pino } from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { refundPayment } from '../src/processors.js';
import type { RefundGateway } from '../src/refunds.js';

const log = pino({ level: 'silent' });

beforeEach(() => truncateAll(prisma));
afterAll(() => prisma.$disconnect());

/** An EXPIRED order whose late payment found no tickets left: a payment marked refund_pending. */
async function paymentToRefund() {
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
      tiers: { create: { name: 'Regular', pricePaise: 10_000, capacity: 1, soldCount: 1 } },
    },
    include: { tiers: true },
  });
  const order = await prisma.order.create({
    data: {
      userId: user.id,
      eventId: event.id,
      status: 'EXPIRED',
      amountPaise: 10_000,
      expiresAt: new Date(Date.now() - 1000),
      items: { create: { tierId: event.tiers[0]!.id, qty: 1, unitPricePaise: 10_000 } },
    },
  });
  const outcome = await recordCapturedPayment({
    orderId: order.id,
    razorpayPaymentId: `pay_${randomUUID().slice(0, 14)}`,
    rawPayload: {},
  });
  if (outcome.kind !== 'refund') throw new Error(`expected a refund, got ${outcome.kind}`);
  return { orderId: order.id, paymentId: outcome.paymentId };
}

const fakeRazorpay = () => ({ refund: vi.fn<RefundGateway['refund']>().mockResolvedValue() });

const state = async (orderId: string, paymentId: string) => ({
  order: (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status,
  payment: (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status,
});

describe('refund-payment', () => {
  it('refunds through Razorpay, then marks the payment refunded and the expired order REFUNDED', async () => {
    const { orderId, paymentId } = await paymentToRefund();
    const razorpay = fakeRazorpay();

    expect(await refundPayment({ paymentId }, razorpay, log)).toEqual({ refunded: true });

    expect(razorpay.refund).toHaveBeenCalledOnce();
    expect(await state(orderId, paymentId)).toEqual({ order: 'REFUNDED', payment: 'refunded' });
  });

  it('running it twice refunds once', async () => {
    const { paymentId } = await paymentToRefund();
    const razorpay = fakeRazorpay();

    await refundPayment({ paymentId }, razorpay, log);
    expect(await refundPayment({ paymentId }, razorpay, log)).toEqual({ refunded: false });
    expect(razorpay.refund).toHaveBeenCalledOnce();
  });

  it('if Razorpay fails, nothing is marked and the job throws so BullMQ retries it', async () => {
    const { orderId, paymentId } = await paymentToRefund();
    const razorpay = fakeRazorpay();
    razorpay.refund.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    await expect(refundPayment({ paymentId }, razorpay, log)).rejects.toThrow('ETIMEDOUT');
    expect(await state(orderId, paymentId)).toEqual({
      order: 'EXPIRED',
      payment: 'refund_pending',
    });

    await refundPayment({ paymentId }, razorpay, log); // the retry
    expect(await state(orderId, paymentId)).toEqual({ order: 'REFUNDED', payment: 'refunded' });
  });
});
