import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { prisma } from '@festpass/db';
import { truncateAll } from '@festpass/db/testing';
import {
  ADMISSION_HEADER,
  redisKeys,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@festpass/shared';
import { admitNext, signAdmissionToken } from '@festpass/shared/server';
import jwt from 'jsonwebtoken';
import { pino } from 'pino';
import { io as connectClient, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { LOG_REDACT_PATHS } from '../src/lib/logger.js';
import { gateRedis } from '../src/lib/redis.js';
import { attachSockets } from '../src/sockets/index.js';
import {
  app,
  book,
  createSaleEvent,
  makeOrg,
  makeUser,
  makeUsers,
  type TestUser,
} from './helpers.js';

const SECRET = process.env.ADMISSION_TOKEN_SECRET!;

/** A published event whose sale is open, with the waiting room on (set the way the organizer sets it). */
async function queueEvent(admitRatePerSec = 1) {
  const owner = await makeUser('Organizer');
  const orgId = await makeOrg(owner, `Club ${randomUUID().slice(0, 8)}`);
  const { eventId, tierIds } = await createSaleEvent(owner, orgId, [
    { name: 'Regular', capacity: 10 },
  ]);
  const res = await request(app)
    .patch(`/api/v1/orgs/${orgId}/events/${eventId}`)
    .set(owner.auth)
    .send({ queueMode: true, admitRatePerSec });
  expect(res.status).toBe(200);
  return { owner, orgId, eventId, tierId: tierIds[0]! };
}

const join = (user: TestUser, eventId: string) =>
  request(app).post(`/api/v1/events/${eventId}/queue/join`).set(user.auth);
const status = (user: TestUser, eventId: string) =>
  request(app).get(`/api/v1/events/${eventId}/queue/status`).set(user.auth);

const bookWith = (
  user: TestUser,
  eventId: string,
  tierId: string,
  token?: string,
  key?: string,
) => {
  const req = request(app)
    .post(`/api/v1/events/${eventId}/orders`)
    .set(user.auth)
    .set('Idempotency-Key', key ?? randomUUID());
  if (token) void req.set(ADMISSION_HEADER, token);
  return req.send({ items: [{ tierId, qty: 1 }] });
};

beforeEach(async () => {
  await truncateAll(prisma);
  await gateRedis.flushdb();
});

describe('POST /events/:eventId/queue/join', () => {
  it('gives each user a place in join order, with a wait of position / rate', async () => {
    const { eventId } = await queueEvent(2);
    const [a, b, c] = await makeUsers(3);

    expect((await join(a!, eventId)).body).toEqual({
      state: 'waiting',
      position: 1,
      estimatedWaitSeconds: 1,
    });
    expect((await join(b!, eventId)).body.position).toBe(2);
    expect((await join(c!, eventId)).body).toEqual({
      state: 'waiting',
      position: 3,
      estimatedWaitSeconds: 2,
    });
  });

  it('keeps one entry per user: joining again keeps the same place', async () => {
    const { eventId } = await queueEvent();
    const [a, b] = await makeUsers(2);
    await join(a!, eventId);
    await join(b!, eventId);

    expect((await join(a!, eventId)).body.position).toBe(1);
    expect(await gateRedis.zcard(redisKeys.waitingRoom(eventId))).toBe(2);
  });

  it('survives a reload: status reports the place without joining', async () => {
    const { eventId } = await queueEvent();
    const [a, b] = await makeUsers(2);
    expect((await status(a!, eventId)).body).toEqual({ state: 'not_joined' });
    await join(a!, eventId);
    await join(b!, eventId);

    expect((await status(b!, eventId)).body.position).toBe(2);
  });

  it('does not queue anyone when queue mode is off', async () => {
    const owner = await makeUser();
    const orgId = await makeOrg(owner);
    const { eventId } = await createSaleEvent(owner, orgId, [{ name: 'Regular', capacity: 5 }]);

    const res = await join(owner, eventId);

    expect(res.body).toEqual({ state: 'not_required' });
    expect(await gateRedis.exists(redisKeys.waitingRoom(eventId))).toBe(0);
  });

  it('refuses to queue before the sale, after it, and for missing or closed events', async () => {
    const { owner, orgId, eventId } = await queueEvent();
    const path = `/api/v1/orgs/${orgId}/events/${eventId}`;
    const buyer = await makeUser();
    const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

    await request(app)
      .patch(path)
      .set(owner.auth)
      .send({ saleStartsAt: hours(1) });
    const early = await join(buyer, eventId);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('SALE_NOT_STARTED');

    await request(app)
      .patch(path)
      .set(owner.auth)
      .send({ saleStartsAt: hours(-2), saleEndsAt: hours(-1) });
    expect((await join(buyer, eventId)).body.error.code).toBe('SALE_ENDED');

    await request(app)
      .patch(path)
      .set(owner.auth)
      .send({ saleEndsAt: hours(1) });
    await request(app).post(`${path}/close`).set(owner.auth);
    expect((await join(buyer, eventId)).body.error.code).toBe('EVENT_CLOSED');

    expect((await join(buyer, randomUUID())).status).toBe(404);
    expect(await gateRedis.exists(redisKeys.waitingRoom(eventId))).toBe(0);
  });

  it('needs a login and a valid event ID', async () => {
    const { eventId } = await queueEvent();
    expect((await request(app).post(`/api/v1/events/${eventId}/queue/join`)).status).toBe(401);
    expect((await join(await makeUser(), 'not-a-uuid')).status).toBe(400);
  });

  it('rate-limits join per user, and status is not limited', async () => {
    const { eventId } = await queueEvent();
    const limited = createApp({ rateLimits: { queueJoin: { capacity: 2, refillPerSec: 0.001 } } });
    const [a, b] = await makeUsers(2);
    const post = (user: TestUser) =>
      request(limited).post(`/api/v1/events/${eventId}/queue/join`).set(user.auth);

    await post(a!);
    await post(a!);
    const third = await post(a!);

    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
    expect((await post(b!)).status).toBe(200);
    expect((await status(a!, eventId)).body.position).toBe(1);
  });

  it('answers 503 when Redis cannot be reached', async () => {
    const { eventId } = await queueEvent();
    const buyer = await makeUser();
    const spy = vi.spyOn(gateRedis, 'eval').mockRejectedValueOnce(new Error('down'));

    const res = await join(buyer, eventId);

    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('QUEUE_UNAVAILABLE');
  });
});

describe('admission', () => {
  it('admits users in join order', async () => {
    const { eventId } = await queueEvent();
    const users = await makeUsers(10);
    for (const user of users) await join(user, eventId);

    const admitted: string[] = [];
    for (let i = 0; i < users.length; i++) {
      admitted.push(...(await admitNext(gateRedis, eventId, 1, SECRET)));
    }

    expect(admitted).toEqual(users.map((u) => u.id));
  });

  it('moves the next person up and hands the token to whoever was admitted', async () => {
    const { eventId } = await queueEvent();
    const [a, b] = await makeUsers(2);
    await join(a!, eventId);
    await join(b!, eventId);

    await admitNext(gateRedis, eventId, 1, SECRET);

    const first = (await status(a!, eventId)).body;
    expect(first.state).toBe('admitted');
    const secondsLeft = (Date.parse(first.expiresAt) - Date.now()) / 1000;
    expect(secondsLeft).toBeGreaterThan(290);
    expect(secondsLeft).toBeLessThanOrEqual(300);
    expect(jwt.decode(first.token)).toMatchObject({ sub: a!.id, eventId });
    expect((await status(b!, eventId)).body.position).toBe(1);
  });

  it('keeps an admitted user admitted when they join again', async () => {
    const { eventId } = await queueEvent();
    const a = await makeUser();
    await join(a, eventId);
    await admitNext(gateRedis, eventId, 1, SECRET);

    expect((await join(a, eventId)).body.state).toBe('admitted');
    expect(await gateRedis.zcard(redisKeys.waitingRoom(eventId))).toBe(0);
  });

  it('lets someone back in line once their unused admission has run out', async () => {
    const { eventId } = await queueEvent();
    const a = await makeUser();
    await join(a, eventId);
    await admitNext(gateRedis, eventId, 1, SECRET);
    await gateRedis.del(redisKeys.admission(eventId, a.id));

    expect((await join(a, eventId)).body).toMatchObject({ state: 'waiting', position: 1 });
  });

  it('admits each user once when two runs overlap', async () => {
    const { eventId } = await queueEvent();
    const users = await makeUsers(3);
    for (const user of users) await join(user, eventId);

    const runs = await Promise.all([
      admitNext(gateRedis, eventId, 2, SECRET),
      admitNext(gateRedis, eventId, 2, SECRET),
    ]);

    const everyone = runs.flat();
    expect(new Set(everyone).size).toBe(everyone.length);
    expect(await gateRedis.zcard(redisKeys.waitingRoom(eventId))).toBe(3 - everyone.length);
  });

  it('marks a room active on the first join and inactive once it is empty', async () => {
    const { eventId } = await queueEvent();
    const a = await makeUser();
    await join(a, eventId);
    expect(await gateRedis.sismember(redisKeys.activeWaitingRooms, eventId)).toBe(1);

    await admitNext(gateRedis, eventId, 1, SECRET);

    expect(await gateRedis.sismember(redisKeys.activeWaitingRooms, eventId)).toBe(0);
  });
});

describe('POST /events/:eventId/orders with queue mode on', () => {
  it('rejects a booking without a token, and takes no stock', async () => {
    const { eventId, tierId } = await queueEvent();
    const buyer = await makeUser();

    const res = await bookWith(buyer, eventId, tierId);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMISSION_REQUIRED');
    const tier = await prisma.ticketTier.findUniqueOrThrow({ where: { id: tierId } });
    expect(tier.soldCount).toBe(0);
    expect(await gateRedis.get(redisKeys.inventory(tierId))).toBe('10');
  });

  it('books with the token the queue issued', async () => {
    const { eventId, tierId } = await queueEvent();
    const buyer = await makeUser();
    await join(buyer, eventId);
    await admitNext(gateRedis, eventId, 1, SECRET);
    const { token } = (await status(buyer, eventId)).body;

    expect((await bookWith(buyer, eventId, tierId, token)).status).toBe(201);
  });

  it('rejects an expired token', async () => {
    const { eventId, tierId } = await queueEvent();
    const buyer = await makeUser();
    const expired = jwt.sign({ eventId }, SECRET, { subject: buyer.id, expiresIn: -1 });

    const res = await bookWith(buyer, eventId, tierId, expired);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMISSION_REQUIRED');
  });

  it("rejects another user's token, another event's token, and a forged one", async () => {
    const { eventId, tierId } = await queueEvent();
    const [buyer, friend] = await makeUsers(2);
    const accessSecret = process.env.JWT_ACCESS_SECRET!;

    for (const token of [
      signAdmissionToken(friend!.id, eventId, SECRET),
      signAdmissionToken(buyer!.id, randomUUID(), SECRET),
      signAdmissionToken(buyer!.id, eventId, accessSecret),
      'not-a-token',
    ]) {
      expect((await bookWith(buyer!, eventId, tierId, token)).status).toBe(403);
    }
  });

  it('still returns a booked order to a retry whose token has since expired', async () => {
    const { eventId, tierId } = await queueEvent();
    const buyer = await makeUser();
    const key = randomUUID();
    const first = await bookWith(
      buyer,
      eventId,
      tierId,
      signAdmissionToken(buyer.id, eventId, SECRET),
      key,
    );
    expect(first.status).toBe(201);

    const expired = jwt.sign({ eventId }, SECRET, { subject: buyer.id, expiresIn: -1 });
    const retry = await bookWith(buyer, eventId, tierId, expired, key);

    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.order.id).toBe(first.body.order.id);
  });

  it('still lets the booking engine say no: a token does not reserve a ticket', async () => {
    const { eventId, tierId } = await queueEvent();
    await prisma.ticketTier.update({ where: { id: tierId }, data: { soldCount: 10 } });
    await gateRedis.set(redisKeys.inventory(tierId), '0');
    const buyer = await makeUser();

    const res = await bookWith(
      buyer,
      eventId,
      tierId,
      signAdmissionToken(buyer.id, eventId, SECRET),
    );

    expect(res.body.error.code).toBe('SOLD_OUT');
  });

  it('needs no token once the organizer turns queue mode off', async () => {
    const { owner, orgId, eventId, tierId } = await queueEvent();
    const buyer = await makeUser();
    await request(app)
      .patch(`/api/v1/orgs/${orgId}/events/${eventId}`)
      .set(owner.auth)
      .send({ queueMode: false });

    expect((await book(buyer, eventId, [{ tierId, qty: 1 }])).status).toBe(201);
    expect((await status(buyer, eventId)).body).toEqual({ state: 'not_required' });
  });
});

describe('logging', () => {
  it('never writes an admission token to the request log', () => {
    let line = '';
    const log = pino({ redact: LOG_REDACT_PATHS }, { write: (s: string) => void (line = s) });

    log.info({ req: { headers: { [ADMISSION_HEADER]: 'the-token' } } }, 'request completed');

    expect(line).not.toContain('the-token');
  });
});

describe('organizer controls', () => {
  it('changes the admit rate, which the wait estimate uses at once', async () => {
    const { owner, orgId, eventId } = await queueEvent(1);
    const users = await makeUsers(10);
    for (const user of users) await join(user, eventId);
    expect((await status(users[9]!, eventId)).body.estimatedWaitSeconds).toBe(10);

    await request(app)
      .patch(`/api/v1/orgs/${orgId}/events/${eventId}`)
      .set(owner.auth)
      .send({ admitRatePerSec: 5 });

    expect((await status(users[9]!, eventId)).body.estimatedWaitSeconds).toBe(2);
  });

  it('does not let a stranger change the settings', async () => {
    const { orgId, eventId } = await queueEvent();
    const res = await request(app)
      .patch(`/api/v1/orgs/${orgId}/events/${eventId}`)
      .set((await makeUser()).auth)
      .send({ queueMode: false });
    expect([403, 404]).toContain(res.status);
  });
});

describe('queue:admitted over Socket.IO', () => {
  type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function startInstance() {
    const server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const sockets = attachSockets(server);
    cleanups.push(() => sockets.close());
    // Let the subscribe finish, or a message published right away is missed.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return server;
  }

  async function connect(server: ReturnType<typeof createApp.prototype.listen>, user?: TestUser) {
    const { port } = server.address() as AddressInfo;
    const token = user?.auth.Authorization.replace('Bearer ', '');
    const client: Client = connectClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      auth: token ? { token } : {},
      reconnection: false,
    });
    cleanups.push(() => void client.disconnect());
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('connect_error', reject);
    });
    const heard: { eventId: string }[] = [];
    client.on('queue:admitted', (message) => heard.push(message));
    return heard;
  }

  it('reaches only the admitted user, once, across two API instances', async () => {
    const { eventId } = await queueEvent();
    const [first, second] = await makeUsers(2);
    const instance1 = await startInstance();
    const instance2 = await startInstance();
    const heardFirst = await connect(instance2, first);
    const heardSecond = await connect(instance1, second);
    const heardAnonymous = await connect(instance1);
    await join(first!, eventId);
    await join(second!, eventId);

    await admitNext(gateRedis, eventId, 1, SECRET);

    await vi.waitFor(() => expect(heardFirst).toEqual([{ eventId }]));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(heardFirst).toHaveLength(1);
    expect(heardSecond).toEqual([]);
    expect(heardAnonymous).toEqual([]);
  });
});
