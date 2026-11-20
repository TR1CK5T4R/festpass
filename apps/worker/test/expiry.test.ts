import { randomUUID } from 'node:crypto';
import { prisma } from '@festpass/db';
import { reserveTickets } from '@festpass/db/booking';
import { truncateAll } from '@festpass/db/testing';
import { JOBS, QUEUES, redisKeys } from '@festpass/shared';
import { createQueue } from '@festpass/shared/server';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { expireOrder, processJob, sweepExpiredOrders } from '../src/processors.js';

const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
const log = pino({ level: 'silent' });
const deps = { redis, log };

let eventId: string;
let tierId: string;

beforeEach(async () => {
  await truncateAll(prisma);
  if (redis.options.db !== 15) throw new Error('tests must use redis database 15');
  await redis.flushdb();

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
      tiers: { create: { name: 'Regular', pricePaise: 10_000, capacity: 10 } },
    },
    include: { tiers: true },
  });
  eventId = event.id;
  tierId = event.tiers[0]!.id;
  await redis.set(redisKeys.inventory(tierId), '10');
});

afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});

/** A hold like the API makes one: the gate takes the stock in Redis, then Postgres books it. */
async function hold(holdSeconds: number, qty = 1) {
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@test.dev`, name: 'Buyer', passwordHash: 'x' },
  });
  await redis.decrby(redisKeys.inventory(tierId), qty);
  await redis.incrby(redisKeys.userHeld(eventId, user.id, tierId), qty);
  const result = await reserveTickets({
    userId: user.id,
    eventId,
    items: [{ tierId, qty }],
    holdSeconds,
    idempotencyKey: randomUUID(),
    requestHash: 'test',
  });
  if (result === 'key-reused' || result.answer.status !== 201) throw new Error('booking failed');
  return { order: result.answer.body.order, userId: user.id };
}

const state = async (orderId: string) => ({
  status: (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status,
  sold: (await prisma.ticketTier.findUniqueOrThrow({ where: { id: tierId } })).soldCount,
  redisStock: await redis.get(redisKeys.inventory(tierId)),
});

describe('hold expiry', () => {
  it('a 2-second hold expires through its delayed job and the tickets go back on sale', async () => {
    const queue = createQueue(QUEUES.orders, redis);
    const worker = new Worker(QUEUES.orders, (job) => processJob(job, deps), {
      connection: redis,
    });
    try {
      const { order, userId } = await hold(2, 3);
      // What the API does after booking: one job per order, due when the hold runs out.
      await queue.add(
        JOBS.expireOrder,
        { orderId: order.id },
        { jobId: order.id, delay: Date.parse(order.expiresAt) - Date.now() },
      );
      expect(await state(order.id)).toEqual({ status: 'PENDING', sold: 3, redisStock: '7' });

      await vi.waitFor(async () => expect((await state(order.id)).status).toBe('EXPIRED'), {
        timeout: 8000,
        interval: 200,
      });

      expect(await state(order.id)).toEqual({ status: 'EXPIRED', sold: 0, redisStock: '10' });
      expect(await redis.exists(redisKeys.userHeld(eventId, userId, tierId))).toBe(0);
      expect((await queue.getJob(order.id))?.finishedOn).toBeTypeOf('number');
    } finally {
      await worker.close();
      await queue.close();
    }
  });

  it('running the expiry twice releases the stock once', async () => {
    const { order } = await hold(0); // already due
    await hold(600); // someone else's hold keeps 1 ticket sold

    const first = await expireOrder({ orderId: order.id }, deps);
    const second = await expireOrder({ orderId: order.id }, deps);

    expect([first, second]).toEqual([{ released: true }, { released: false }]);
    expect(await state(order.id)).toEqual({ status: 'EXPIRED', sold: 1, redisStock: '9' });
  });

  it('the job and the sweeper racing on the same order still release it once', async () => {
    const { order } = await hold(0, 2);

    await Promise.all([
      expireOrder({ orderId: order.id }, deps),
      sweepExpiredOrders(deps),
      expireOrder({ orderId: order.id }, deps),
    ]);

    expect(await state(order.id)).toEqual({ status: 'EXPIRED', sold: 0, redisStock: '10' });
  });

  it('a job that fires early leaves the hold alone', async () => {
    const { order } = await hold(600);
    expect(await expireOrder({ orderId: order.id }, deps)).toEqual({ released: false });
    expect((await state(order.id)).status).toBe('PENDING');
  });

  it('the sweeper expires overdue holds whose job never ran, and only those', async () => {
    const overdue = [await hold(0), await hold(0)];
    const current = await hold(600);

    expect(await sweepExpiredOrders(deps)).toEqual({ expired: 2 });
    expect(await sweepExpiredOrders(deps)).toEqual({ expired: 0 });

    for (const { order } of overdue) expect((await state(order.id)).status).toBe('EXPIRED');
    expect(await state(current.order.id)).toEqual({ status: 'PENDING', sold: 1, redisStock: '9' });
  });

  it('rejects a malformed job payload instead of guessing', async () => {
    await expect(expireOrder({ orderId: 'not-a-uuid' }, deps)).rejects.toThrow();
  });
});
