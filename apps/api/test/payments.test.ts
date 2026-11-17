import { prisma } from '@festpass/db';
import { truncateAll } from '@festpass/db/testing';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { gateRedis } from '../src/lib/redis.js';
import { paymentGateway } from '../src/modules/payments/gateway.js';
import {
  app,
  book,
  createSaleEvent,
  makeOrg,
  makeUser,
  makeUsers,
  type TestUser,
} from './helpers.js';

let createOrder: MockInstance<typeof paymentGateway.createOrder>;
let calls = 0;

beforeEach(async () => {
  await truncateAll(prisma);
  if (gateRedis.options.db !== 15) throw new Error('tests must use redis database 15');
  await gateRedis.flushdb();
  // The SDK is never called: a fake returns a new Razorpay-style order ID per call.
  calls = 0;
  createOrder = vi.spyOn(paymentGateway, 'createOrder').mockImplementation(async (input) => {
    calls++;
    return { id: `order_test${calls}`, amount: input.amountPaise, currency: 'INR' };
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => prisma.$disconnect());

const pay = (user: TestUser, orderId: string) =>
  request(app).post(`/api/v1/orders/${orderId}/pay`).set(user.auth);

/** A buyer holding 2 Regular tickets (₹299 each) in a published event. */
async function heldOrder() {
  const owner = await makeUser('Organizer');
  const orgId = await makeOrg(owner);
  const { eventId, tierIds } = await createSaleEvent(owner, orgId, [
    { name: 'Regular', capacity: 10 },
  ]);
  const buyer = await makeUser('Buyer');
  const res = await book(buyer, eventId, [{ tierId: tierIds[0]!, qty: 2 }]);
  return { buyer, orderId: res.body.order.id as string };
}

describe('POST /orders/:orderId/pay', () => {
  it('creates a Razorpay order for the amount, tied to our order ID, and returns what Checkout needs', async () => {
    const { buyer, orderId } = await heldOrder();

    const res = await pay(buyer, orderId);

    expect(res.status).toBe(200);
    expect(res.body.payment).toMatchObject({
      orderId,
      keyId: 'rzp_test_festpassTests',
      razorpayOrderId: 'order_test1',
      amountPaise: 59_800,
      currency: 'INR',
      prefill: { name: 'Buyer' },
    });
    expect(createOrder).toHaveBeenCalledWith({
      orderId,
      amountPaise: 59_800,
      notes: { userId: buyer.id },
    });
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(stored).toMatchObject({ razorpayOrderId: 'order_test1', status: 'PENDING' });
  });

  it('repeated pay calls reuse the same Razorpay order', async () => {
    const { buyer, orderId } = await heldOrder();

    const first = await pay(buyer, orderId);
    const second = await pay(buyer, orderId);

    expect(second.body.payment.razorpayOrderId).toBe(first.body.payment.razorpayOrderId);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it('parallel pay clicks all get the one Razorpay order that was stored', async () => {
    const { buyer, orderId } = await heldOrder();

    const responses = await Promise.all(Array.from({ length: 5 }, () => pay(buyer, orderId)));

    const ids = new Set(responses.map((r) => r.body.payment.razorpayOrderId));
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(ids).toEqual(new Set([stored.razorpayOrderId]));
  });

  it("rejects someone else's order with 404", async () => {
    const { orderId } = await heldOrder();
    const [stranger] = await makeUsers(1);

    expect((await pay(stranger!, orderId)).status).toBe(404);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('rejects an expired hold, even before the sweeper has marked it', async () => {
    const { buyer, orderId } = await heldOrder();
    await prisma.order.update({
      where: { id: orderId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await pay(buyer, orderId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HOLD_EXPIRED');
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('rejects an order that is already paid, or no longer pending', async () => {
    const { buyer, orderId } = await heldOrder();
    await prisma.order.update({ where: { id: orderId }, data: { status: 'PAID' } });
    const paid = await pay(buyer, orderId);
    await prisma.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' } });
    const cancelled = await pay(buyer, orderId);

    expect(paid.body.error).toMatchObject({
      code: 'ORDER_NOT_PENDING',
      details: { status: 'PAID' },
    });
    expect(cancelled.body.error).toMatchObject({
      code: 'ORDER_NOT_PENDING',
      details: { status: 'CANCELLED' },
    });
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('a Razorpay failure is a 502 and stores nothing, so the next try starts clean', async () => {
    const { buyer, orderId } = await heldOrder();
    createOrder.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    const failed = await pay(buyer, orderId);
    const retry = await pay(buyer, orderId);

    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('PAYMENT_PROVIDER_ERROR');
    expect(retry.status).toBe(200);
  });
});

describe('GET /orders/:orderId', () => {
  it('shows the owner their order with its event, and nobody else', async () => {
    const { buyer, orderId } = await heldOrder();
    const [stranger] = await makeUsers(1);

    const mine = await request(app).get(`/api/v1/orders/${orderId}`).set(buyer.auth);
    const theirs = await request(app).get(`/api/v1/orders/${orderId}`).set(stranger!.auth);

    expect(mine.status).toBe(200);
    expect(mine.body.order).toMatchObject({ id: orderId, status: 'PENDING', amountPaise: 59_800 });
    expect(mine.body.order.items).toEqual([
      expect.objectContaining({ tierName: 'Regular', qty: 2, unitPricePaise: 29_900 }),
    ]);
    expect(mine.body.event).toMatchObject({ venue: 'MAIT Auditorium' });
    expect(theirs.status).toBe(404);
  });
});
