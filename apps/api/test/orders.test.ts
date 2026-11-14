import { randomUUID } from 'node:crypto';
import { prisma } from '@festpass/db';
import { reconcileInventory } from '@festpass/db/inventory';
import { truncateAll } from '@festpass/db/testing';
import { redisKeys } from '@festpass/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gateRedis } from '../src/lib/redis.js';
import { bookingStats } from '../src/modules/orders/stats.js';
import { app, makeOrg, makeUser, makeUsers, type TestUser } from './helpers.js';

beforeEach(async () => {
  await truncateAll(prisma);
  // vitest.config points REDIS_URL at database 15; never flush anything else.
  if (gateRedis.options.db !== 15) throw new Error('tests must use redis database 15');
  await gateRedis.flushdb();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await prisma.$disconnect();
  gateRedis.disconnect();
});

const HOUR = 60 * 60 * 1000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

let owner: TestUser;
let orgId: string;

beforeEach(async () => {
  owner = await makeUser('Olivia');
  orgId = await makeOrg(owner);
});

/** A published event whose sale opened an hour ago, with the given tiers. */
async function saleEvent(tiers: { name: string; capacity: number; perUserLimit?: number }[]) {
  const created = await request(app)
    .post(`/api/v1/orgs/${orgId}/events`)
    .set(owner.auth)
    .send({
      title: `Fest ${randomUUID().slice(0, 6)}`,
      venue: 'MAIT Auditorium',
      startsAt: at(48 * HOUR),
      endsAt: at(52 * HOUR),
      saleStartsAt: at(-HOUR),
      saleEndsAt: at(24 * HOUR),
    });
  const eventId = created.body.event.id as string;
  const tierIds: string[] = [];
  for (const t of tiers) {
    const res = await request(app)
      .post(`/api/v1/orgs/${orgId}/events/${eventId}/tiers`)
      .set(owner.auth)
      .send({ pricePaise: 29_900, perUserLimit: 4, ...t });
    tierIds.push(res.body.tier.id);
  }
  await request(app).post(`/api/v1/orgs/${orgId}/events/${eventId}/publish`).set(owner.auth);
  return { eventId, tierIds };
}

const book = (
  user: TestUser,
  eventId: string,
  items: { tierId: string; qty: number }[],
  key: string = randomUUID(),
) =>
  request(app)
    .post(`/api/v1/events/${eventId}/orders`)
    .set(user.auth)
    .set('Idempotency-Key', key)
    .send({ items });

const soldCount = async (tierId: string) =>
  (await prisma.ticketTier.findUniqueOrThrow({ where: { id: tierId } })).soldCount;

const statusCounts = (responses: request.Response[]) =>
  responses.reduce<Record<string, number>>((acc, r) => {
    const key = r.status === 201 ? '201' : `${r.status} ${r.body.error.code}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

// Every booking test runs three times: with the gate working, with Redis failing every command, and
// with Redis too slow to answer within the gate's 50 ms. The results must be identical: Postgres alone
// decides, and the gate only turns requests away earlier.
const REDIS_MODES = ['working', 'throwing', 'too slow'] as const;

describe.each(REDIS_MODES)('with redis %s', (mode) => {
  beforeEach(() => {
    if (mode === 'working') return;
    const fail = () =>
      mode === 'throwing'
        ? Promise.reject(new Error('Connection is closed.'))
        : new Promise<never>(() => {}); // never answers
    for (const command of ['festpassReserve', 'festpassRelease', 'mget', 'set'] as const) {
      vi.spyOn(gateRedis, command).mockImplementation(fail as never);
    }
  });

  describe('flash sale concurrency', () => {
    it('200 buyers, 10 tickets: exactly 10 orders, 190 SOLD_OUT, sold_count 10', async () => {
      const { eventId, tierIds } = await saleEvent([{ name: 'Regular', capacity: 10 }]);
      const buyers = await makeUsers(200);
      const before = { ...bookingStats };

      const responses = await Promise.all(
        buyers.map((buyer) => book(buyer, eventId, [{ tierId: tierIds[0]!, qty: 1 }])),
      );

      expect(statusCounts(responses)).toEqual({ '201': 10, '409 SOLD_OUT': 190 });
      expect(await soldCount(tierIds[0]!)).toBe(10);
      expect(await prisma.order.count({ where: { status: 'PENDING' } })).toBe(10);
      // Where the 190 refusals came from: Redis when it works, Postgres when it doesn't.
      const delta = (k: keyof typeof bookingStats) => bookingStats[k] - before[k];
      if (mode === 'working') {
        expect([delta('rejectedAtGate'), delta('rejectedAtPostgres')]).toEqual([190, 0]);
      } else {
        expect([delta('gateSkipped'), delta('rejectedAtPostgres')]).toEqual([200, 190]);
      }
    });

    it('one user firing 20 parallel requests with a limit of 2 gets at most 2', async () => {
      const { eventId, tierIds } = await saleEvent([
        { name: 'Regular', capacity: 100, perUserLimit: 2 },
      ]);
      const buyer = await makeUser('Eager');

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => book(buyer, eventId, [{ tierId: tierIds[0]!, qty: 1 }])),
      );

      expect(statusCounts(responses)).toEqual({ '201': 2, '409 PER_USER_LIMIT': 18 });
      expect(await soldCount(tierIds[0]!)).toBe(2);
    });

    it('opposite item orders in parallel never deadlock (rows are always locked in tier-ID order)', async () => {
      const { eventId, tierIds } = await saleEvent([
        { name: 'Day pass', capacity: 500 },
        { name: 'Workshop', capacity: 500 },
      ]);
      const [a, b] = tierIds as [string, string];
      const buyers = await makeUsers(60);

      const responses = await Promise.all(
        buyers.map((buyer, i) =>
          book(
            buyer,
            eventId,
            i % 2 === 0
              ? [
                  { tierId: a, qty: 1 },
                  { tierId: b, qty: 1 },
                ]
              : [
                  { tierId: b, qty: 1 },
                  { tierId: a, qty: 1 },
                ],
          ),
        ),
      );

      expect(statusCounts(responses)).toEqual({ '201': 60 });
      expect([await soldCount(a), await soldCount(b)]).toEqual([60, 60]);
    });

    it('if the second tier is sold out, the first tier is given back and no order is created', async () => {
      const { eventId, tierIds } = await saleEvent([
        { name: 'Day pass', capacity: 50 },
        { name: 'Workshop', capacity: 1 },
      ]);
      const [pass, workshop] = tierIds as [string, string];
      const buyer = await makeUser();

      const res = await book(buyer, eventId, [
        { tierId: pass, qty: 2 },
        { tierId: workshop, qty: 2 },
      ]);

      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'SOLD_OUT',
        details: { tierId: workshop, tierName: 'Workshop' },
      });
      expect([await soldCount(pass), await soldCount(workshop)]).toEqual([0, 0]);
      expect(await prisma.order.count()).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('the same key and body replays the first response without booking again', async () => {
      const { eventId, tierIds } = await saleEvent([{ name: 'Regular', capacity: 10 }]);
      const buyer = await makeUser();
      const key = randomUUID();
      const items = [{ tierId: tierIds[0]!, qty: 2 }];

      const first = await book(buyer, eventId, items, key);
      const retry = await book(buyer, eventId, items, key);

      expect(first.status).toBe(201);
      expect(first.body.order).toMatchObject({ status: 'PENDING', amountPaise: 59_800 });
      expect(retry.status).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);
      expect(await soldCount(tierIds[0]!)).toBe(2);
    });

    it('the same key with a different body is a 422', async () => {
      const { eventId, tierIds } = await saleEvent([{ name: 'Regular', capacity: 10 }]);
      const buyer = await makeUser();
      const key = randomUUID();

      await book(buyer, eventId, [{ tierId: tierIds[0]!, qty: 1 }], key);
      const reused = await book(buyer, eventId, [{ tierId: tierIds[0]!, qty: 3 }], key);

      expect(reused.status).toBe(422);
      expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await soldCount(tierIds[0]!)).toBe(1);
    });

    it('10 parallel copies of one request create one order, and all get it', async () => {
      const { eventId, tierIds } = await saleEvent([{ name: 'Regular', capacity: 10 }]);
      const buyer = await makeUser();
      const key = randomUUID();

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          book(buyer, eventId, [{ tierId: tierIds[0]!, qty: 1 }], key),
        ),
      );

      expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201));
      expect(new Set(responses.map((r) => r.body.order.id)).size).toBe(1);
      expect(await soldCount(tierIds[0]!)).toBe(1);
    });

    it('a SOLD_OUT decided by Postgres is replayed too, even after tickets are added', async () => {
      const { eventId, tierIds } = await saleEvent([{ name: 'Regular', capacity: 1 }]);
      const [first, second] = await makeUsers(2);
      const key = randomUUID();
      await book(first!, eventId, [{ tierId: tierIds[0]!, qty: 1 }]);
      // Make the gate step aside, so this refusal comes from Postgres and is stored under the key.
      // (Refusals from the gate itself are not stored; see the redis gate tests.)
      if (mode === 'working') await gateRedis.set(redisKeys.inventory(tierIds[0]!), '5');
      const soldOut = await book(second!, eventId, [{ tierId: tierIds[0]!, qty: 1 }], key);
      await prisma.ticketTier.update({ where: { id: tierIds[0]! }, data: { capacity: 5 } });

      const retry = await book(second!, eventId, [{ tierId: tierIds[0]!, qty: 1 }], key);

      expect(soldOut.body.error.code).toBe('SOLD_OUT');
      expect(retry.status).toBe(409);
      expect(retry.body.error.code).toBe('SOLD_OUT');
      expect(retry.headers['idempotent-replayed']).toBe('true');
    });

    it('one key sent for two different events at once: one order, the other gets 422', async () => {
      const one = await saleEvent([{ name: 'Regular', capacity: 10 }]);
      const two = await saleEvent([{ name: 'Regular', capacity: 10 }]);
      const buyer = await makeUser();
      const key = randomUUID();

      const responses = await Promise.all([
        book(buyer, one.eventId, [{ tierId: one.tierIds[0]!, qty: 1 }], key),
        book(buyer, two.eventId, [{ tierId: two.tierIds[0]!, qty: 1 }], key),
      ]);

      expect(statusCounts(responses)).toEqual({ '201': 1, '422 IDEMPOTENCY_KEY_REUSED': 1 });
      expect(await prisma.order.count()).toBe(1);
    });
  });

  describe('booking checks', () => {
    it('needs an Idempotency-Key that is a UUID', async () => {
      const { eventId, tierIds } = await saleEvent([{ name: 'Regular', capacity: 10 }]);
      const res = await request(app)
        .post(`/api/v1/events/${eventId}/orders`)
        .set(owner.auth)
        .send({ items: [{ tierId: tierIds[0], qty: 1 }] });

      expect(res.status).toBe(400);
      expect(res.body.error.details.fields).toEqual([
        expect.objectContaining({ location: 'headers', path: 'idempotency-key' }),
      ]);
    });

    it('needs a login', async () => {
      const { eventId, tierIds } = await saleEvent([{ name: 'Regular', capacity: 10 }]);
      const res = await request(app)
        .post(`/api/v1/events/${eventId}/orders`)
        .set('Idempotency-Key', randomUUID())
        .send({ items: [{ tierId: tierIds[0], qty: 1 }] });
      expect(res.status).toBe(401);
    });

    it('rejects a tier from another event, and duplicate tiers', async () => {
      const one = await saleEvent([{ name: 'Regular', capacity: 10 }]);
      const two = await saleEvent([{ name: 'Regular', capacity: 10 }]);
      const buyer = await makeUser();

      const foreign = await book(buyer, one.eventId, [{ tierId: two.tierIds[0]!, qty: 1 }]);
      const twice = await book(buyer, one.eventId, [
        { tierId: one.tierIds[0]!, qty: 1 },
        { tierId: one.tierIds[0]!, qty: 1 },
      ]);

      expect(foreign.status).toBe(400);
      expect(foreign.body.error.details.fields[0].path).toBe('items.0.tierId');
      expect(twice.status).toBe(400);
    });

    it('a draft is not found, a closed event and a sale that has not started are 409', async () => {
      const buyer = await makeUser();
      const live = await saleEvent([{ name: 'Regular', capacity: 10 }]);
      const draft = await request(app)
        .post(`/api/v1/orgs/${orgId}/events`)
        .set(owner.auth)
        .send({
          title: 'Draft Fest',
          venue: 'Hall',
          startsAt: at(48 * HOUR),
          endsAt: at(50 * HOUR),
          saleStartsAt: at(-HOUR),
          saleEndsAt: at(24 * HOUR),
        });
      const draftTier = await request(app)
        .post(`/api/v1/orgs/${orgId}/events/${draft.body.event.id}/tiers`)
        .set(owner.auth)
        .send({ name: 'Regular', pricePaise: 100, capacity: 5 });
      const early = await saleEvent([{ name: 'Regular', capacity: 10 }]);
      await prisma.event.update({
        where: { id: early.eventId },
        data: { saleStartsAt: new Date(Date.now() + HOUR) },
      });

      const fromDraft = await book(buyer, draft.body.event.id, [
        { tierId: draftTier.body.tier.id, qty: 1 },
      ]);
      const tooEarly = await book(buyer, early.eventId, [{ tierId: early.tierIds[0]!, qty: 1 }]);
      await request(app).post(`/api/v1/orgs/${orgId}/events/${live.eventId}/close`).set(owner.auth);
      const closed = await book(buyer, live.eventId, [{ tierId: live.tierIds[0]!, qty: 1 }]);

      expect(fromDraft.status).toBe(404);
      expect(tooEarly.body.error.code).toBe('SALE_NOT_STARTED');
      expect(closed.body.error.code).toBe('EVENT_CLOSED');
    });

    it('holds for HOLD_MINUTES and copies the price at booking time', async () => {
      const { eventId, tierIds } = await saleEvent([{ name: 'Regular', capacity: 10 }]);
      const buyer = await makeUser();
      const before = Date.now();

      const res = await book(buyer, eventId, [{ tierId: tierIds[0]!, qty: 3 }]);

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: res.body.order.id },
        include: { items: true },
      });
      const holdMs = order.expiresAt.getTime() - before;
      expect(holdMs).toBeGreaterThan(9.9 * 60_000);
      expect(holdMs).toBeLessThan(10.1 * 60_000);
      expect(order).toMatchObject({ status: 'PENDING', amountPaise: 89_700, userId: buyer.id });
      expect(order.items).toEqual([expect.objectContaining({ qty: 3, unitPricePaise: 29_900 })]);
    });
  });
});

describe('redis gate', () => {
  const stock = async (tierId: string) => gateRedis.get(redisKeys.inventory(tierId));

  it("publishing puts each tier's stock in redis", async () => {
    const { tierIds } = await saleEvent([
      { name: 'Regular', capacity: 10 },
      { name: 'VIP', capacity: 3 },
    ]);
    expect([await stock(tierIds[0]!), await stock(tierIds[1]!)]).toEqual(['10', '3']);
  });

  it('compensation: when Postgres refuses after the gate let a request through, the stock goes back', async () => {
    const { eventId, tierIds } = await saleEvent([{ name: 'Regular', capacity: 10 }]);
    const tierId = tierIds[0]!;
    // Postgres is sold out but Redis hasn't heard yet (drift): the gate says yes, Postgres says no.
    await prisma.ticketTier.update({ where: { id: tierId }, data: { soldCount: 10 } });
    const buyer = await makeUser();
    const before = bookingStats.compensated;

    const res = await book(buyer, eventId, [{ tierId, qty: 2 }]);

    expect(res.body.error.code).toBe('SOLD_OUT');
    expect(bookingStats.compensated - before).toBe(1);
    expect(await stock(tierId)).toBe('10'); // took 2, gave 2 back
    expect(await gateRedis.exists(redisKeys.userHeld(eventId, buyer.id, tierId))).toBe(0);
  });

  it('a refusal from the gate is not stored: a retry with the same key asks again', async () => {
    const { eventId, tierIds } = await saleEvent([{ name: 'Regular', capacity: 1 }]);
    const tierId = tierIds[0]!;
    const [first, second] = await makeUsers(2);
    const key = randomUUID();
    await book(first!, eventId, [{ tierId, qty: 1 }]);

    const refused = await book(second!, eventId, [{ tierId, qty: 1 }], key);
    // A ticket comes back (Day 13 will do this when a hold expires) and Redis is told.
    await prisma.ticketTier.update({ where: { id: tierId }, data: { capacity: 2 } });
    await reconcileInventory(gateRedis);
    const retry = await book(second!, eventId, [{ tierId, qty: 1 }], key);

    expect(refused.body.error.code).toBe('SOLD_OUT');
    expect(await prisma.idempotencyKey.count({ where: { userId: second!.id } })).toBe(1);
    expect(retry.status).toBe(201);
  });

  it("a tier redis doesn't know is booked through Postgres, and its key is filled in", async () => {
    const { eventId, tierIds } = await saleEvent([{ name: 'Regular', capacity: 10 }]);
    const tierId = tierIds[0]!;
    await gateRedis.del(redisKeys.inventory(tierId)); // e.g. Redis restarted without its data
    const buyer = await makeUser();

    const res = await book(buyer, eventId, [{ tierId, qty: 1 }]);

    expect(res.status).toBe(201);
    await vi.waitFor(async () => expect(await stock(tierId)).toBe('9'));
  });

  it('reconciliation finds a corrupted or missing key and sets it from Postgres', async () => {
    const { tierIds } = await saleEvent([
      { name: 'Regular', capacity: 10 },
      { name: 'VIP', capacity: 3 },
    ]);
    const [regular, vip] = tierIds as [string, string];
    await prisma.ticketTier.update({ where: { id: regular }, data: { soldCount: 4 } });
    await gateRedis.set(redisKeys.inventory(regular), '999');
    await gateRedis.del(redisKeys.inventory(vip));

    const drift = await reconcileInventory(gateRedis);

    expect(drift).toEqual(
      expect.arrayContaining([
        { tierId: regular, redis: 999, postgres: 6 },
        { tierId: vip, redis: null, postgres: 3 },
      ]),
    );
    expect([await stock(regular), await stock(vip)]).toEqual(['6', '3']);
    expect(await reconcileInventory(gateRedis)).toEqual([]); // nothing left to fix
  });
});
