import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '@festpass/db';
import { truncateAll } from '@festpass/db/testing';
import { connectMongo, disconnectMongo, ScanEvent } from '@festpass/mongo';
import type {
  AvailabilityUpdate,
  ClientToServerEvents,
  JoinResult,
  LiveScan,
  ServerToClientEvents,
} from '@festpass/shared';
import { announceAvailabilityChange } from '@festpass/shared/server';
import jwt from 'jsonwebtoken';
import { io as connectClient, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { gateRedis } from '../src/lib/redis.js';
import { attachSockets } from '../src/sockets/index.js';
import {
  addMember,
  app,
  book,
  createSaleEvent,
  makeOrg,
  makeUser,
  ticketedOrder,
  type TestUser,
} from './helpers.js';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

const instances: {
  server: HttpServer;
  close: () => Promise<void>;
  io: ReturnType<typeof attachSockets>['io'];
}[] = [];
const clients: Client[] = [];

async function startInstance() {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const sockets = attachSockets(server);
  const instance = { server, close: sockets.close, io: sockets.io };
  instances.push(instance);
  return instance;
}

function connect(instance: { server: HttpServer }, auth: { token?: unknown } = {}) {
  const { port } = instance.server.address() as AddressInfo;
  const client: Client = connectClient(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    auth,
    reconnection: false,
  });
  clients.push(client);
  return client;
}

const connected = (client: Client) =>
  new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('connect_error', reject);
  });

const join = (client: Client, eventId: string, room: 'public' | 'staff') =>
  new Promise<JoinResult>((resolve) => client.emit('event:join', { eventId, room }, resolve));

const tokenOf = (user: TestUser) => user.auth.Authorization.replace('Bearer ', '');

/** Collects a client's messages from now on. */
function collect(client: Client) {
  const availability: AvailabilityUpdate[] = [];
  const scans: LiveScan[] = [];
  client.on('availability', (update) => availability.push(update));
  client.on('scan', (scan) => scans.push(scan));
  return { availability, scans };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function saleEvent(capacity = 10) {
  const owner = await makeUser('Organizer');
  const orgId = await makeOrg(owner);
  const { eventId, tierIds } = await createSaleEvent(owner, orgId, [{ name: 'Regular', capacity }]);
  return { owner, orgId, eventId, tierId: tierIds[0]! };
}

beforeAll(() => connectMongo(process.env.MONGODB_URI!));
beforeEach(async () => {
  await truncateAll(prisma);
  if (gateRedis.options.db !== 15) throw new Error('tests must use redis database 15');
  await gateRedis.flushdb();
  await ScanEvent.deleteMany({});
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  for (const instance of instances.splice(0)) await instance.close();
});
afterAll(async () => {
  await prisma.$disconnect();
  await disconnectMongo();
});

describe('joining rooms', () => {
  it('lets an anonymous client join a public room and sends the current numbers at once', async () => {
    const { eventId, tierId } = await saleEvent(10);
    const client = connect(await startInstance());
    await connected(client);
    const { availability } = collect(client);

    await expect(join(client, eventId, 'public')).resolves.toEqual({ ok: true });

    await vi.waitFor(() =>
      expect(availability).toEqual([{ eventId, tiers: [{ id: tierId, available: 10 }] }]),
    );
  });

  it('tells a draft nothing: its numbers are not public', async () => {
    const owner = await makeUser('Organizer');
    const orgId = await makeOrg(owner);
    const draft = await request(app)
      .post(`/api/v1/orgs/${orgId}/events`)
      .set(owner.auth)
      .send({
        title: 'Draft',
        venue: 'Hall',
        startsAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
        endsAt: new Date(Date.now() + 50 * 3_600_000).toISOString(),
        saleStartsAt: new Date(Date.now() - 3_600_000).toISOString(),
        saleEndsAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      });
    const client = connect(await startInstance());
    await connected(client);
    const { availability } = collect(client);

    await join(client, draft.body.event.id, 'public');
    await sleep(100);

    expect(availability).toEqual([]);
  });

  it('refuses the staff room to an anonymous client', async () => {
    const { eventId } = await saleEvent();
    const client = connect(await startInstance());
    await connected(client);

    await expect(join(client, eventId, 'staff')).resolves.toEqual({
      ok: false,
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses the staff room to a logged-in user outside the club, who then hears nothing', async () => {
    const order = await ticketedOrder();
    const stranger = await makeUser('Eve');
    const scanner = await makeUser('Sam');
    await addMember(order.orgId, scanner.id, 'SCANNER');
    const client = connect(await startInstance(), { token: tokenOf(stranger) });
    await connected(client);
    const { scans } = collect(client);

    await expect(join(client, order.eventId, 'staff')).resolves.toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    const tickets = await request(app).get('/api/v1/me/tickets').set(order.buyer.auth);
    await request(app)
      .post(`/api/v1/events/${order.eventId}/checkins`)
      .set(scanner.auth)
      .send({ qr: tickets.body.tickets[0].qr, deviceId: 'phone-1' });
    await sleep(100);

    expect(scans).toEqual([]);
  });

  it('gives the same refusal for an event that does not exist', async () => {
    const stranger = await makeUser('Eve');
    const client = connect(await startInstance(), { token: tokenOf(stranger) });
    await connected(client);

    await expect(join(client, '00000000-0000-4000-8000-000000000000', 'staff')).resolves.toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
  });

  it('rejects a bad room name or event ID', async () => {
    const client = connect(await startInstance());
    await connected(client);

    await expect(join(client, 'not-a-uuid', 'public')).resolves.toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
    await expect(
      join(client, '00000000-0000-4000-8000-000000000000', 'admin' as 'public'),
    ).resolves.toEqual({ ok: false, code: 'VALIDATION_FAILED' });
  });
});

describe('the handshake', () => {
  it.each([
    ['garbage', 'not-a-token'],
    ['not a string', 42],
    ['expired', jwt.sign({}, process.env.JWT_ACCESS_SECRET!, { subject: 'u1', expiresIn: -10 })],
    [
      'signed with another key',
      jwt.sign({}, 'another-secret-another-secret-12345', { subject: 'u1' }),
    ],
  ])('refuses a token that is %s', async (_, token) => {
    const client = connect(await startInstance(), { token });
    await expect(connected(client)).rejects.toThrow('UNAUTHORIZED');
  });

  it('ends the connection when the token expires, so the membership is checked again', async () => {
    const { eventId, owner } = await saleEvent();
    const shortLived = jwt.sign({}, process.env.JWT_ACCESS_SECRET!, {
      subject: owner.id,
      expiresIn: 1,
    });
    const client = connect(await startInstance(), { token: shortLived });
    await connected(client);
    await expect(join(client, eventId, 'staff')).resolves.toEqual({ ok: true });

    const reason = await new Promise((resolve) => client.once('disconnect', resolve));

    expect(reason).toBe('io server disconnect');
  });
});

describe('availability updates', () => {
  it('reach the public room after a booking and a cancel, with numbers and nothing else', async () => {
    const { eventId, tierId } = await saleEvent(10);
    const client = connect(await startInstance());
    await connected(client);
    await join(client, eventId, 'public');
    const { availability } = collect(client);
    await vi.waitFor(() => expect(availability.at(-1)?.tiers[0]?.available).toBe(10));

    const buyer = await makeUser('Asha Secret-Name');
    const booked = await book(buyer, eventId, [{ tierId, qty: 3 }]);
    await vi.waitFor(() => expect(availability.at(-1)?.tiers[0]?.available).toBe(7));

    // Nothing about the buyer, in any message the room has received.
    const everything = JSON.stringify(availability);
    expect(everything).not.toContain('Secret-Name');
    expect(everything).not.toContain(buyer.id);
    expect(everything).not.toContain(buyer.email);
    expect(Object.keys(availability.at(-1)!).sort()).toEqual(['eventId', 'tiers']);
    expect(Object.keys(availability.at(-1)!.tiers[0]!).sort()).toEqual(['available', 'id']);

    await request(app).post(`/api/v1/orders/${booked.body.order.id}/cancel`).set(buyer.auth);
    await vi.waitFor(() => expect(availability.at(-1)?.tiers[0]?.available).toBe(10));
  });

  it('stays quiet for a replayed booking', async () => {
    const { eventId, tierId } = await saleEvent(10);
    const buyer = await makeUser('Asha');
    const key = '11111111-1111-4111-8111-111111111111';
    await book(buyer, eventId, [{ tierId, qty: 1 }], key);
    await sleep(600); // the first booking's update has come and gone

    const publish = vi.spyOn(gateRedis, 'publish');
    await book(buyer, eventId, [{ tierId, qty: 1 }], key);

    expect(publish).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('a change from another process (the worker) reaches the room too', async () => {
    const { eventId, tierId } = await saleEvent(10);
    const client = connect(await startInstance());
    await connected(client);
    await join(client, eventId, 'public');
    const { availability } = collect(client);
    await vi.waitFor(() => expect(availability).toHaveLength(1));

    await prisma.ticketTier.update({ where: { id: tierId }, data: { soldCount: 4 } });
    await announceAvailabilityChange(gateRedis, eventId);

    await vi.waitFor(() => expect(availability.at(-1)?.tiers[0]?.available).toBe(6));
  });

  it('holds the limit across instances: rapid changes give about 2 sends a second in total', async () => {
    const { eventId } = await saleEvent(10);
    const one = await startInstance();
    const two = await startInstance();
    const client = connect(two);
    await connected(client);
    await join(client, eventId, 'public');
    const { availability } = collect(client);
    await vi.waitFor(() => expect(availability).toHaveLength(1));
    availability.length = 0;
    expect(one).toBeDefined();

    const stop = Date.now() + 1000;
    while (Date.now() < stop) {
      await announceAvailabilityChange(gateRedis, eventId);
      await sleep(5);
    }
    await sleep(600);

    expect(availability.length).toBeGreaterThanOrEqual(2);
    expect(availability.length).toBeLessThanOrEqual(4);
  });
});

describe('the Redis adapter', () => {
  it('delivers to a client connected to a different API instance', async () => {
    const { eventId } = await saleEvent();
    const one = await startInstance();
    const two = await startInstance();
    const client = connect(two);
    await connected(client);
    await join(client, eventId, 'public');
    const { availability } = collect(client);
    await vi.waitFor(() => expect(availability).toHaveLength(1));

    const update = { eventId, tiers: [{ id: 'from-instance-one', available: 1 }] };
    one.io.to(`event:${eventId}:public`).emit('availability', update);

    await vi.waitFor(() => expect(availability.at(-1)).toEqual(update));
  });
});

describe('the staff room', () => {
  it('gets each scan, a public room does not, and the summary agrees', async () => {
    const order = await ticketedOrder();
    const scanner = await makeUser('Sam');
    await addMember(order.orgId, scanner.id, 'SCANNER');
    const instance = await startInstance();
    const staff = connect(instance, { token: tokenOf(order.owner) });
    const anon = connect(instance);
    await Promise.all([connected(staff), connected(anon)]);
    await expect(join(staff, order.eventId, 'staff')).resolves.toEqual({ ok: true });
    await join(anon, order.eventId, 'public');
    const staffHears = collect(staff);
    const anonHears = collect(anon);

    const tickets = (await request(app).get('/api/v1/me/tickets').set(order.buyer.auth)).body
      .tickets as { id: string; qr: string }[];
    const scan = (qr: string) =>
      request(app)
        .post(`/api/v1/events/${order.eventId}/checkins`)
        .set(scanner.auth)
        .send({ qr, deviceId: 'phone-1', gateId: 'north' });
    await scan(tickets[0]!.qr);
    await scan(tickets[0]!.qr);

    await vi.waitFor(() => expect(staffHears.scans).toHaveLength(2));
    expect(staffHears.scans.map((s) => s.result)).toEqual(['ACCEPTED', 'DUPLICATE']);
    expect(staffHears.scans[0]).toMatchObject({
      ticketId: tickets[0]!.id,
      tierName: 'Regular',
      gateId: 'north',
      offline: false,
    });
    expect(anonHears.scans).toEqual([]);

    await vi.waitFor(async () => {
      const res = await request(app)
        .get(`/api/v1/events/${order.eventId}/checkins/summary`)
        .set(scanner.auth);
      expect(res.status).toBe(200);
      expect(res.body.summary.checkedIn).toBe(1);
      expect(res.body.summary.totalTickets).toBe(3);
      expect(res.body.summary.recent.map((s: LiveScan) => s.result).sort()).toEqual([
        'ACCEPTED',
        'DUPLICATE',
      ]);
    });
  });

  it('hears nothing extra when a batch is sent again', async () => {
    const order = await ticketedOrder();
    const instance = await startInstance();
    const staff = connect(instance, { token: tokenOf(order.owner) });
    await connected(staff);
    await join(staff, order.eventId, 'staff');
    const { scans } = collect(staff);
    const tickets = (await request(app).get('/api/v1/me/tickets').set(order.buyer.auth)).body
      .tickets as { qr: string }[];
    const body = {
      deviceId: 'phone-1',
      scans: [{ clientScanId: 'scan-1', qr: tickets[0]!.qr, scannedAt: new Date().toISOString() }],
    };
    const send = () =>
      request(app)
        .post(`/api/v1/events/${order.eventId}/checkins/batch`)
        .set(order.owner.auth)
        .send(body);

    await send();
    await send();
    await sleep(100);

    expect(scans).toHaveLength(1);
    expect(scans[0]!.offline).toBe(true);
  });

  it('keeps the summary to the club', async () => {
    const { eventId } = await saleEvent();
    const stranger = await makeUser('Eve');
    const res = await request(app)
      .get(`/api/v1/events/${eventId}/checkins/summary`)
      .set(stranger.auth);
    expect(res.status).toBe(404);
  });
});
