import { randomUUID } from 'node:crypto';
import { prisma } from '@festpass/db';
import { truncateAll } from '@festpass/db/testing';
import { connectMongo, disconnectMongo, ScanEvent, type ScanEventData } from '@festpass/mongo';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportsQueue } from '../src/lib/queues.js';
import { gateRedis } from '../src/lib/redis.js';
import { addMember, app, makeUser, ticketedOrder, type TestUser } from './helpers.js';

beforeAll(() => connectMongo(process.env.MONGODB_URI!));
beforeEach(async () => {
  await truncateAll(prisma);
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

/** An event with 3 tickets, a scanner, and one sponsor with one booth, set up through the API. */
async function setup() {
  const order = await ticketedOrder(3);
  await prisma.user.update({
    where: { id: order.buyer.id },
    data: { college: 'MAIT', branch: 'IT', graduationYear: 2027 },
  });
  const scanner = await makeUser('Sam');
  await addMember(order.orgId, scanner.id, 'SCANNER');
  const base = `/api/v1/orgs/${order.orgId}/events/${order.eventId}/sponsors`;
  const created = await request(app)
    .post(base)
    .set(order.owner.auth)
    .send({ name: 'CodeCraft Labs', tier: 'GOLD' });
  expect(created.status).toBe(201);
  const sponsorId = created.body.sponsor.id as string;
  const booth = await request(app)
    .post(`${base}/${sponsorId}/booths`)
    .set(order.owner.auth)
    .send({ name: 'Main stall' });
  const tickets = (await request(app).get('/api/v1/me/tickets').set(order.buyer.auth)).body
    .tickets as { id: string; qr: string }[];
  return { ...order, scanner, base, sponsorId, boothId: booth.body.booth.id as string, tickets };
}

const gateScan = (user: TestUser, eventId: string, qr: string) =>
  request(app)
    .post(`/api/v1/events/${eventId}/checkins`)
    .set(user.auth)
    .send({ qr, deviceId: 'gate-phone', gateId: 'main' });
const boothScan = (user: TestUser, boothId: string, qr: string, clientScanId?: string) =>
  request(app)
    .post(`/api/v1/booths/${boothId}/scans`)
    .set(user.auth)
    .send({ qr, deviceId: 'booth-phone', clientScanId });
const boothEvents = (boothId: string) =>
  ScanEvent.find({ 'meta.type': 'BOOTH', 'meta.gateOrBoothId': boothId }).lean();

describe('organizer: sponsors, booths and sponsor users', () => {
  it('creates sponsors and booths and adds an existing account as a sponsor user', async () => {
    const { owner, base, sponsorId } = await setup();
    const rep = await makeUser('Priya');

    const added = await request(app)
      .post(`${base}/${sponsorId}/members`)
      .set(owner.auth)
      .send({ email: rep.email });
    const list = await request(app).get(base).set(owner.auth);

    expect(added.status).toBe(201);
    expect(list.body.sponsors).toEqual([
      {
        id: sponsorId,
        name: 'CodeCraft Labs',
        tier: 'GOLD',
        booths: [{ id: expect.any(String), name: 'Main stall' }],
        members: [{ userId: rep.id, name: 'Priya', email: rep.email }],
      },
    ]);
  });

  it('refuses duplicates and unknown emails, and lets the organizer remove a sponsor user', async () => {
    const { owner, base, sponsorId } = await setup();
    const rep = await makeUser();
    await request(app)
      .post(`${base}/${sponsorId}/members`)
      .set(owner.auth)
      .send({ email: rep.email });

    const again = await request(app)
      .post(`${base}/${sponsorId}/members`)
      .set(owner.auth)
      .send({ email: rep.email });
    const unknown = await request(app)
      .post(`${base}/${sponsorId}/members`)
      .set(owner.auth)
      .send({ email: 'nobody@example.com' });
    const sameName = await request(app)
      .post(base)
      .set(owner.auth)
      .send({ name: 'CodeCraft Labs', tier: 'SILVER' });
    const removed = await request(app)
      .delete(`${base}/${sponsorId}/members/${rep.id}`)
      .set(owner.auth);

    expect(again.body.error.code).toBe('ALREADY_MEMBER');
    expect(unknown.status).toBe(404);
    expect(sameName.body.error.code).toBe('SPONSOR_NAME_TAKEN');
    expect(removed.status).toBe(204);
  });

  it('is for organizers: a gate scanner gets 403, another club 404', async () => {
    const { base, scanner } = await setup();
    expect((await request(app).get(base).set(scanner.auth)).status).toBe(403);
    expect(
      (
        await request(app)
          .get(base)
          .set((await makeUser()).auth)
      ).status,
    ).toBe(404);
  });
});

describe('POST /booths/:boothId/scans', () => {
  it('records a BOOTH visit after the gate, with the attendee fields, and changes nothing in Postgres', async () => {
    const { eventId, scanner, boothId, tickets } = await setup();
    await gateScan(scanner, eventId, tickets[0]!.qr);
    const before = await prisma.ticket.findUniqueOrThrow({ where: { id: tickets[0]!.id } });

    const res = await boothScan(scanner, boothId, tickets[0]!.qr);

    expect(res.status).toBe(201);
    expect(res.body.visit).toEqual({ boothId, tierName: 'Regular', at: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toContain('Buyer'); // no attendee name at the booth
    const [visit] = await boothEvents(boothId);
    expect(visit).toMatchObject({
      meta: { eventId, type: 'BOOTH', gateOrBoothId: boothId },
      ticketId: tickets[0]!.id,
      result: 'ACCEPTED',
      college: 'MAIT',
      branch: 'IT',
      graduationYear: 2027,
      tierName: 'Regular',
    });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: tickets[0]!.id } })).toEqual(
      before,
    );
  });

  it('refuses a ticket that has not been through the gate yet', async () => {
    const { scanner, boothId, tickets } = await setup();

    const res = await boothScan(scanner, boothId, tickets[0]!.qr);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_CHECKED_IN');
    expect((await boothEvents(boothId)).map((e) => e.result)).toEqual(['INVALID']);
  });

  it('refuses a forged QR and a ticket of another event', async () => {
    const { scanner, boothId } = await setup();
    const other = await ticketedOrder(1);
    const otherTicket = (await request(app).get('/api/v1/me/tickets').set(other.buyer.auth)).body
      .tickets[0];

    expect((await boothScan(scanner, boothId, 'FP1.not.a-ticket')).body.error.code).toBe(
      'INVALID_QR',
    );
    expect((await boothScan(scanner, boothId, otherTicket.qr)).body.error.code).toBe('WRONG_EVENT');
  });

  it('counts every visit, but a re-sent scan (same clientScanId) once', async () => {
    const { eventId, scanner, boothId, tickets } = await setup();
    await gateScan(scanner, eventId, tickets[0]!.qr);
    const scanId = randomUUID();

    const first = await boothScan(scanner, boothId, tickets[0]!.qr, scanId);
    const resent = await boothScan(scanner, boothId, tickets[0]!.qr, scanId);
    await boothScan(scanner, boothId, tickets[0]!.qr); // walked past again later

    expect(resent.body).toEqual(first.body);
    expect(await boothEvents(boothId)).toHaveLength(2);
  });

  it('needs checkin:scan in the event club: strangers 404, unknown booths 404', async () => {
    const { boothId, tickets } = await setup();
    expect((await boothScan(await makeUser(), boothId, tickets[0]!.qr)).status).toBe(404);
    expect((await boothScan(await makeUser(), randomUUID(), tickets[0]!.qr)).status).toBe(404);
  });

  it('lists the booths a scanner can open', async () => {
    const { eventId, scanner, boothId } = await setup();
    const res = await request(app).get(`/api/v1/events/${eventId}/booths`).set(scanner.auth);
    expect(res.body.booths).toEqual([
      { id: boothId, name: 'Main stall', sponsorName: 'CodeCraft Labs' },
    ]);
  });
});

/** Visits written straight into MongoDB, with numbers worked out by hand. */
function visit(
  eventId: string,
  boothId: string,
  ticketId: string,
  at: string,
  extra: Partial<ScanEventData> = {},
): ScanEventData {
  return {
    ts: new Date(at),
    meta: { eventId, type: 'BOOTH', gateOrBoothId: boothId },
    ticketId,
    scannerUserId: randomUUID(),
    deviceId: 'booth-phone',
    result: 'ACCEPTED',
    offline: false,
    college: 'MAIT',
    branch: 'CSE',
    graduationYear: 2027,
    tierName: 'Regular',
    ...extra,
  };
}

describe('sponsor portal', () => {
  async function portal() {
    const s = await setup();
    const rep = await makeUser('Priya');
    await prisma.sponsorMember.create({ data: { sponsorId: s.sponsorId, userId: rep.id } });
    const second = await prisma.booth.create({
      data: { sponsorId: s.sponsorId, name: 'Demo corner' },
    });
    // A rival sponsor at the same event, with its own booth and user.
    const rival = await prisma.sponsor.create({
      data: {
        eventId: s.eventId,
        name: 'Rival Inc',
        tier: 'SILVER',
        booths: { create: { name: 'Rival stall' } },
      },
      include: { booths: true },
    });
    const rivalRep = await makeUser('Rohan');
    await prisma.sponsorMember.create({ data: { sponsorId: rival.id, userId: rivalRep.id } });
    return { ...s, rep, secondBoothId: second.id, rival, rivalRep };
  }

  it('lists only my own sponsorships', async () => {
    const { rep, sponsorId, boothId, secondBoothId } = await portal();

    const { body } = await request(app).get('/api/v1/sponsors/mine').set(rep.auth);

    expect(body.sponsorships).toHaveLength(1);
    expect(body.sponsorships[0]).toMatchObject({
      sponsorId,
      name: 'CodeCraft Labs',
      booths: expect.arrayContaining([
        { id: boothId, name: 'Main stall' },
        { id: secondBoothId, name: 'Demo corner' },
      ]),
    });
  });

  it("can't read another sponsor's booths: 404, as if it didn't exist", async () => {
    const { rep, rival, rivalRep, sponsorId } = await portal();

    expect(
      (await request(app).get(`/api/v1/sponsors/${rival.id}/analytics`).set(rep.auth)).status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/v1/sponsors/${sponsorId}/analytics`).set(rivalRep.auth)).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .get(`/api/v1/sponsors/${sponsorId}/analytics`)
          .set((await makeUser()).auth)
      ).status,
    ).toBe(404);
  });

  it('counts unique and repeat visitors, booths, hours and attendance exactly, with small groups folded', async () => {
    const { rep, sponsorId, eventId, boothId, secondBoothId, rival } = await portal();
    const [a, b, c, d, e, f, g] = Array.from({ length: 7 }, () => randomUUID() as string) as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const gate = (ticketId: string) => ({
      ...visit(eventId, 'main', ticketId, '2026-12-12T04:00:00Z'),
      meta: { eventId, type: 'GATE' as const, gateOrBoothId: 'main' },
    });
    await ScanEvent.insertMany([
      // 8 people came in through the gate (one of them twice: a refused duplicate, not counted).
      ...[a, b, c, d, e, f, g, randomUUID()].map(gate),
      { ...gate(a), result: 'DUPLICATE' },
      // Booth visits. 10:00 IST = 04:30 UTC, so 04:40 and 05:20 UTC are both in the 10:00 IST hour.
      visit(eventId, boothId, a, '2026-12-12T04:40:00Z'),
      visit(eventId, boothId, a, '2026-12-12T05:20:00Z'), // a again, same hour
      visit(eventId, secondBoothId, a, '2026-12-12T06:00:00Z'), // a at the other booth, 11:00 IST hour
      visit(eventId, boothId, b, '2026-12-12T04:45:00Z', { branch: 'IT' }),
      visit(eventId, boothId, c, '2026-12-12T04:50:00Z', { graduationYear: 2026 }),
      visit(eventId, secondBoothId, d, '2026-12-12T06:10:00Z', {
        branch: 'ECE',
        graduationYear: 2026,
      }),
      visit(eventId, boothId, f, '2026-12-12T04:35:00Z'),
      visit(eventId, boothId, g, '2026-12-12T04:36:00Z'),
      // Not this sponsor's: a refused scan, a rival's booth, another event.
      visit(eventId, boothId, e, '2026-12-12T04:55:00Z', { result: 'INVALID' }),
      visit(eventId, rival.booths[0]!.id, e, '2026-12-12T05:00:00Z'),
      visit(randomUUID(), boothId, e, '2026-12-12T05:00:00Z'),
    ]);

    const res = await request(app).get(`/api/v1/sponsors/${sponsorId}/analytics`).set(rep.auth);

    expect(res.status).toBe(200);
    const analytics = res.body.analytics;
    expect(analytics.totals).toEqual({
      uniqueVisitors: 6,
      repeatVisitors: 1,
      visits: 8,
      attendance: 8,
      shareOfAttendance: 0.75,
    });
    expect(analytics.booths).toEqual(
      expect.arrayContaining([
        { id: boothId, name: 'Main stall', visits: 6, uniqueVisitors: 5 },
        { id: secondBoothId, name: 'Demo corner', visits: 2, uniqueVisitors: 2 },
      ]),
    );
    expect(analytics.heatmap).toEqual(
      expect.arrayContaining([
        { boothId, hour: '2026-12-12T04:30:00.000Z', visits: 6 },
        { boothId: secondBoothId, hour: '2026-12-12T05:30:00.000Z', visits: 2 },
      ]),
    );
    expect(analytics.heatmap).toHaveLength(2);
    // Branch, per person: CSE a, c, f, g (4); IT b and ECE d are under 3 people each, so "Other" (2).
    expect(analytics.breakdown.branch).toEqual([
      { value: 'CSE', count: 4 },
      { value: 'Other', count: 2 },
    ]);
    // Year: 2027 a, b, f, g (4); 2026 c, d (2) is under 3, so "Other".
    expect(analytics.breakdown.graduationYear).toEqual([
      { value: 2027, count: 4 },
      { value: 'Other', count: 2 },
    ]);
    expect(analytics.minGroupSize).toBe(3);
  });

  it('never returns names, emails or ticket IDs', async () => {
    const { rep, sponsorId, eventId, scanner, boothId, tickets, buyer } = await portal();
    await gateScan(scanner, eventId, tickets[0]!.qr);
    await boothScan(scanner, boothId, tickets[0]!.qr);

    const res = await request(app).get(`/api/v1/sponsors/${sponsorId}/analytics`).set(rep.auth);

    expect(res.body.analytics.totals.uniqueVisitors).toBe(1);
    const text = JSON.stringify(res.body);
    for (const secret of [tickets[0]!.id, buyer.email, 'Buyer', buyer.id]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('closing an event', () => {
  it('queues one report job per sponsor, keyed by the sponsor', async () => {
    const { owner, orgId, eventId, sponsorId } = await setup();
    const add = vi.spyOn(reportsQueue, 'add').mockResolvedValue({} as never);

    const res = await request(app)
      .post(`/api/v1/orgs/${orgId}/events/${eventId}/close`)
      .set(owner.auth);

    expect(res.status).toBe(200);
    expect(add).toHaveBeenCalledWith(
      'send-sponsor-report',
      { sponsorId, requestId: undefined },
      { jobId: `sponsor-report-${sponsorId}` },
    );
  });
});
