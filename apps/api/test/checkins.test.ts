import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { prisma } from '@festpass/db';
import { truncateAll } from '@festpass/db/testing';
import { connectMongo, disconnectMongo, ScanEvent } from '@festpass/mongo';
import { createTicketSigner } from '@festpass/shared/server';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { scansQueue } from '../src/lib/queues.js';
import { gateRedis } from '../src/lib/redis.js';
import { addMember, app, makeUser, ticketedOrder, type TestUser } from './helpers.js';

beforeAll(() => connectMongo(process.env.MONGODB_URI!));
beforeEach(async () => {
  await truncateAll(prisma);
  if (gateRedis.options.db !== 15) throw new Error('tests must use redis database 15');
  await gateRedis.flushdb();
  if (ScanEvent.db.name !== 'festpass_test') {
    throw new Error('tests must use the festpass_test mongo database');
  }
  await ScanEvent.deleteMany({});
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await prisma.$disconnect();
  await disconnectMongo();
});

/** An event with tickets, and a volunteer with the SCANNER role in its club. */
async function gate() {
  const order = await ticketedOrder();
  await prisma.user.update({
    where: { id: order.buyer.id },
    data: { college: 'MAIT', branch: 'IT', graduationYear: 2027 },
  });
  const scanner = await makeUser('Sam');
  await addMember(order.orgId, scanner.id, 'SCANNER');
  const tickets = (await request(app).get('/api/v1/me/tickets').set(order.buyer.auth)).body
    .tickets as { id: string; qr: string; code: string }[];
  return { ...order, scanner, tickets };
}

const scan = (user: TestUser, eventId: string, qr: string) =>
  request(app)
    .post(`/api/v1/events/${eventId}/checkins`)
    .set(user.auth)
    .send({ qr, deviceId: 'phone-1', gateId: 'north' });

const scanEvents = (eventId: string) => ScanEvent.find({ 'meta.eventId': eventId }).lean();

/** Scan events are written after the answer, so wait for them. */
const waitForScanEvents = (eventId: string, count: number) =>
  vi.waitFor(async () => expect(await scanEvents(eventId)).toHaveLength(count));

describe('POST /events/:eventId/checkins', () => {
  it('accepts a ticket once; a second scan is a 409 saying when and by whom', async () => {
    const { eventId, scanner, tickets } = await gate();
    const ticket = tickets[0]!;

    const first = await scan(scanner, eventId, ticket.qr);
    const second = await scan(scanner, eventId, ticket.qr);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      result: 'ACCEPTED',
      ticket: { id: ticket.id, code: ticket.code, tierName: 'Regular', attendeeName: 'Buyer' },
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({
      code: 'ALREADY_CHECKED_IN',
      details: {
        ticketId: ticket.id,
        firstScannedAt: first.body.ticket.checkedInAt,
        firstScannedBy: { id: scanner.id, name: 'Sam' },
      },
    });
  });

  it('ten parallel scans of one ticket: exactly one ACCEPTED, nine duplicates', async () => {
    const { eventId, scanner, tickets } = await gate();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => scan(scanner, eventId, tickets[0]!.qr)),
    );

    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    const conflicts = responses.filter((r) => r.status === 409);
    expect(conflicts).toHaveLength(9);
    for (const r of conflicts) expect(r.body.error.code).toBe('ALREADY_CHECKED_IN');
    await waitForScanEvents(eventId, 10);
    const results = (await scanEvents(eventId)).map((e) => e.result);
    expect(results.filter((r) => r === 'ACCEPTED')).toHaveLength(1);
  });

  it('rejects a ticket for another event', async () => {
    const { scanner, tickets } = await gate();
    const other = await gate();
    await addMember(other.orgId, scanner.id, 'SCANNER');

    const res = await scan(scanner, other.eventId, tickets[0]!.qr);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WRONG_EVENT');
    expect(
      (await prisma.ticket.findUniqueOrThrow({ where: { id: tickets[0]!.id } })).checkedInAt,
    ).toBeNull();
  });

  it('rejects an old QR after a reissue, and accepts the new one', async () => {
    const { eventId, scanner, buyer, tickets } = await gate();
    const reissued = await request(app)
      .post(`/api/v1/tickets/${tickets[0]!.id}/reissue`)
      .set(buyer.auth);

    const old = await scan(scanner, eventId, tickets[0]!.qr);
    const current = await scan(scanner, eventId, reissued.body.ticket.qr);

    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe('QR_REVOKED');
    expect(current.body.result).toBe('ACCEPTED');
  });

  it.each([
    ['a tampered QR', (qr: string) => `${qr.slice(0, 12)}x${qr.slice(13)}`],
    ['text that is not a ticket', () => 'https://example.com/free-entry'],
    [
      'a QR signed with another key',
      (qr: string) => {
        const [, payload] = qr.split('.');
        const json = JSON.parse(Buffer.from(payload!, 'base64url').toString());
        return createTicketSigner(generateKeyPairSync('ed25519').privateKey)(json);
      },
    ],
  ])('rejects %s and records it without trusting anything in it', async (_name, mangle) => {
    const { eventId, scanner, tickets } = await gate();

    const res = await scan(scanner, eventId, mangle(tickets[0]!.qr));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_QR');
    await waitForScanEvents(eventId, 1);
    expect((await scanEvents(eventId))[0]).toMatchObject({ result: 'INVALID', ticketId: null });
  });

  it("needs the checkin:scan permission in the event's club", async () => {
    const { eventId, tickets } = await gate();
    const stranger = await makeUser('Eve');

    expect((await scan(stranger, eventId, tickets[0]!.qr)).status).toBe(404);
    expect((await request(app).post(`/api/v1/events/${eventId}/checkins`).send({})).status).toBe(
      401,
    );
  });
});

describe('scan events', () => {
  it('go to a time-series collection, with the attendee fields copied at write time', async () => {
    const { eventId, scanner, tickets } = await gate();

    await scan(scanner, eventId, tickets[0]!.qr);
    await waitForScanEvents(eventId, 1);

    const [info] = await ScanEvent.db.db!.listCollections({ name: 'scan_events' }).toArray();
    expect(info?.type).toBe('timeseries');
    expect((await scanEvents(eventId))[0]).toMatchObject({
      meta: { eventId, type: 'GATE', gateOrBoothId: 'north' },
      ticketId: tickets[0]!.id,
      scannerUserId: scanner.id,
      deviceId: 'phone-1',
      result: 'ACCEPTED',
      offline: false,
      college: 'MAIT',
      branch: 'IT',
      graduationYear: 2027,
      tierName: 'Regular',
    });
  });

  it('if MongoDB fails, the check-in stands and a retry job is queued', async () => {
    const { eventId, scanner, tickets } = await gate();
    vi.spyOn(ScanEvent, 'create').mockRejectedValueOnce(new Error('mongo is down') as never);

    const res = await scan(scanner, eventId, tickets[0]!.qr);

    expect(res.body.result).toBe('ACCEPTED');
    await vi.waitFor(async () => expect(await scansQueue.getWaitingCount()).toBe(1));
    const [job] = await scansQueue.getWaiting();
    expect(job).toMatchObject({
      name: 'write-scan-event',
      data: { ticketId: tickets[0]!.id, result: 'ACCEPTED' },
    });
    expect(job!.opts.attempts).toBe(10);
    expect(
      (await prisma.ticket.findUniqueOrThrow({ where: { id: tickets[0]!.id } })).checkedInAt,
    ).not.toBeNull();
  });
});

describe('POST /events/:eventId/checkins/batch', () => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const batch = (user: TestUser, eventId: string, scans: object[]) =>
    request(app)
      .post(`/api/v1/events/${eventId}/checkins/batch`)
      .set(user.auth)
      .send({ deviceId: 'phone-2', gateId: 'south', scans });

  it('processes scans in client-time order and returns a result per scan, in that order', async () => {
    const { eventId, scanner, tickets } = await gate();
    const [a, b] = tickets as [(typeof tickets)[0], (typeof tickets)[0]];

    // Sent out of order: the same ticket twice, a bad code, and another ticket.
    const res = await batch(scanner, eventId, [
      { clientScanId: 'late-a', qr: a.qr, scannedAt: at(1) },
      { clientScanId: 'bad', qr: 'not-a-ticket', scannedAt: at(3) },
      { clientScanId: 'early-a', qr: a.qr, scannedAt: at(5) },
      { clientScanId: 'b', qr: b.qr, scannedAt: at(2) },
    ]);

    expect(res.status).toBe(200);
    expect(
      res.body.results.map((r: { clientScanId: string; result: string }) => [
        r.clientScanId,
        r.result,
      ]),
    ).toEqual([
      ['early-a', 'ACCEPTED'],
      ['bad', 'INVALID'],
      ['b', 'ACCEPTED'],
      ['late-a', 'DUPLICATE'],
    ]);
    expect(res.body.results[3]).toMatchObject({
      ticketId: a.id,
      firstScannedBy: { id: scanner.id, name: 'Sam' },
    });
  });

  it("records them as offline scans at the phone's time, but never in the future", async () => {
    const { eventId, scanner, tickets } = await gate();
    const past = at(30);
    const future = new Date(Date.now() + 3_600_000).toISOString();

    await batch(scanner, eventId, [
      { clientScanId: '1', qr: tickets[0]!.qr, scannedAt: past },
      { clientScanId: '2', qr: tickets[1]!.qr, scannedAt: future },
    ]);
    await waitForScanEvents(eventId, 2);

    const events = await scanEvents(eventId);
    const byTicket = (id: string) => events.find((e) => e.ticketId === id)!;
    expect(byTicket(tickets[0]!.id)).toMatchObject({
      offline: true,
      deviceId: 'phone-2',
      ts: new Date(past),
    });
    expect(byTicket(tickets[1]!.id).ts.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('a batch sent again after a lost response gets the same answer, not a false conflict', async () => {
    const { eventId, scanner, tickets } = await gate();
    const scans = [{ clientScanId: 'scan-1', qr: tickets[0]!.qr, scannedAt: at(2) }];

    const first = await batch(scanner, eventId, scans);
    const resent = await batch(scanner, eventId, scans);
    const otherPhone = await batch(scanner, eventId, [{ ...scans[0]!, clientScanId: 'scan-2' }]);

    expect(first.body.results[0].result).toBe('ACCEPTED');
    expect(resent.body.results).toEqual(first.body.results);
    expect(otherPhone.body.results[0].result).toBe('DUPLICATE');
    await waitForScanEvents(eventId, 2); // the re-send added no history row
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await scanEvents(eventId)).toHaveLength(2);
  });

  it('a scan whose online answer was lost is recognised when the batch sends it', async () => {
    const { eventId, scanner, tickets } = await gate();
    const qr = tickets[0]!.qr;
    const online = await request(app)
      .post(`/api/v1/events/${eventId}/checkins`)
      .set(scanner.auth)
      .send({ qr, deviceId: 'phone-1', clientScanId: 'scan-9' });
    expect(online.status).toBe(200);

    const synced = await batch(scanner, eventId, [
      { clientScanId: 'scan-9', qr, scannedAt: at(2) },
    ]);
    expect(synced.body.results[0].result).toBe('ACCEPTED');
  });

  it('validates the batch and refuses non-members', async () => {
    const { eventId, scanner, tickets } = await gate();
    const stranger = await makeUser('Eve');
    const scanOne = { clientScanId: '1', qr: tickets[0]!.qr, scannedAt: at(1) };

    expect((await batch(scanner, eventId, [])).status).toBe(400);
    expect((await batch(scanner, eventId, [{ ...scanOne, scannedAt: 'yesterday' }])).status).toBe(
      400,
    );
    expect((await batch(stranger, eventId, [scanOne])).status).toBe(404);
  });

  it('a full batch of 200 scans fits the request size limit', async () => {
    const { eventId, scanner, tickets } = await gate();
    const scans = Array.from({ length: 200 }, (_, i) => ({
      clientScanId: randomUUID(),
      qr: tickets[0]!.qr,
      scannedAt: at(200 - i),
    }));
    const res = await batch(scanner, eventId, scans);
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(200);
    await waitForScanEvents(eventId, 200);
  }, 30_000);
});

describe('GET /events/:eventId/checkins/manifest', () => {
  it('lists IDs, current versions and used flags, and nothing personal', async () => {
    const { eventId, scanner, buyer, tickets } = await gate();
    await request(app).post(`/api/v1/tickets/${tickets[0]!.id}/reissue`).set(buyer.auth);
    await scan(scanner, eventId, tickets[1]!.qr);

    const res = await request(app)
      .get(`/api/v1/events/${eventId}/checkins/manifest`)
      .set(scanner.auth);

    expect(res.status).toBe(200);
    expect(res.body.manifest.eventId).toBe(eventId);
    const byId = new Map(res.body.manifest.tickets.map((t: { id: string }) => [t.id, t] as const));
    expect(byId.get(tickets[0]!.id)).toEqual({ id: tickets[0]!.id, v: 2, used: false });
    expect(byId.get(tickets[1]!.id)).toEqual({ id: tickets[1]!.id, v: 1, used: true });
    expect(byId.get(tickets[2]!.id)).toEqual({ id: tickets[2]!.id, v: 1, used: false });
  });

  it('is only for people who can scan at this event', async () => {
    const { eventId } = await gate();
    const stranger = await makeUser('Eve');
    const res = await request(app)
      .get(`/api/v1/events/${eventId}/checkins/manifest`)
      .set(stranger.auth);
    expect(res.status).toBe(404);
  });
});
