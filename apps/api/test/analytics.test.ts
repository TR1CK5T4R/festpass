import { randomUUID } from 'node:crypto';
import { prisma } from '@festpass/db';
import { truncateAll } from '@festpass/db/testing';
import { connectMongo, disconnectMongo, ScanEvent, type ScanEventData } from '@festpass/mongo';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gateRedis } from '../src/lib/redis.js';
import { addMember, app, createSaleEvent, makeOrg, makeUser, type TestUser } from './helpers.js';

// Fixtures with numbers worked out by hand, so each pipeline must produce exactly these answers.

beforeAll(() => connectMongo(process.env.MONGODB_URI!));
beforeEach(async () => {
  await truncateAll(prisma);
  await gateRedis.flushdb();
  if (ScanEvent.db.name !== 'festpass_test') {
    throw new Error('tests must use the festpass_test mongo database');
  }
  await ScanEvent.deleteMany({});
});
afterAll(async () => {
  await prisma.$disconnect();
  await disconnectMongo();
});

async function setup() {
  const owner = await makeUser('Organizer');
  const orgId = await makeOrg(owner, `Club ${randomUUID().slice(0, 8)}`);
  const { eventId, tierIds } = await createSaleEvent(owner, orgId, [
    { name: 'Regular', capacity: 10, pricePaise: 29_900 },
    { name: 'VIP', capacity: 5, pricePaise: 99_900 },
  ]);
  const [regular, vip] = tierIds as [string, string];
  return { owner, orgId, eventId, regular, vip };
}

type Status = 'PENDING' | 'PAID' | 'TICKETED' | 'EXPIRED' | 'REFUNDED';

async function order(
  eventId: string,
  status: Status,
  createdAt: string,
  items: { tierId: string; qty: number; price: number }[],
) {
  const buyer = await makeUser('Buyer');
  await prisma.order.create({
    data: {
      userId: buyer.id,
      eventId,
      status,
      amountPaise: items.reduce((sum, i) => sum + i.qty * i.price, 0),
      expiresAt: new Date(createdAt),
      createdAt: new Date(createdAt),
      items: {
        create: items.map((i) => ({ tierId: i.tierId, qty: i.qty, unitPricePaise: i.price })),
      },
    },
  });
}

const sales = (user: TestUser, orgId: string, eventId: string) =>
  request(app).get(`/api/v1/orgs/${orgId}/events/${eventId}/analytics/sales`).set(user.auth);
const checkins = (user: TestUser, orgId: string, eventId: string, query = '') =>
  request(app)
    .get(`/api/v1/orgs/${orgId}/events/${eventId}/analytics/checkins${query}`)
    .set(user.auth);

describe('GET /analytics/sales', () => {
  it('counts paid tickets and revenue per tier and per day in India time, filling quiet days', async () => {
    const { owner, orgId, eventId, regular, vip } = await setup();
    const R = { tierId: regular, price: 29_900 };
    const V = { tierId: vip, price: 99_900 };
    await order(eventId, 'TICKETED', '2026-11-03T05:00:00Z', [{ ...R, qty: 2 }]); // 3 Nov, 10:30 IST
    await order(eventId, 'PAID', '2026-11-03T19:00:00Z', [{ ...V, qty: 1 }]); // 4 Nov, 00:30 IST
    await order(eventId, 'TICKETED', '2026-11-06T06:00:00Z', [
      { ...R, qty: 1 },
      { ...V, qty: 1 },
    ]);
    await order(eventId, 'PENDING', '2026-11-06T07:00:00Z', [{ ...R, qty: 3 }]); // held, not paid
    await order(eventId, 'EXPIRED', '2026-11-05T07:00:00Z', [{ ...V, qty: 2 }]); // never counted
    await order(eventId, 'REFUNDED', '2026-11-05T08:00:00Z', [{ ...R, qty: 1 }]); // money returned

    const res = await sales(owner, orgId, eventId);

    expect(res.status).toBe(200);
    expect(res.body.sales).toEqual({
      tiers: [
        { tierId: regular, name: 'Regular', capacity: 10, paid: 3, held: 3, revenuePaise: 89_700 },
        { tierId: vip, name: 'VIP', capacity: 5, paid: 2, held: 0, revenuePaise: 199_800 },
      ],
      days: [
        { day: '2026-11-03', tickets: 2, revenuePaise: 59_800 },
        { day: '2026-11-04', tickets: 1, revenuePaise: 99_900 },
        { day: '2026-11-05', tickets: 0, revenuePaise: 0 },
        { day: '2026-11-06', tickets: 2, revenuePaise: 129_800 },
      ],
      totals: { tickets: 5, revenuePaise: 289_500 },
    });
  });

  it('answers zeros for an event with no sales', async () => {
    const { owner, orgId, eventId } = await setup();

    const { body } = await sales(owner, orgId, eventId);

    expect(body.sales.days).toEqual([]);
    expect(body.sales.totals).toEqual({ tickets: 0, revenuePaise: 0 });
    expect(body.sales.tiers.map((t: { paid: number }) => t.paid)).toEqual([0, 0]);
  });
});

const at = (iso: string) => new Date(`2026-12-12T${iso}:00Z`);

function scan(eventId: string, time: string, extra: Partial<ScanEventData> = {}): ScanEventData {
  return {
    ts: at(time),
    meta: { eventId, type: 'GATE', gateOrBoothId: 'main' },
    ticketId: randomUUID(),
    scannerUserId: randomUUID(),
    deviceId: 'phone-1',
    result: 'ACCEPTED',
    offline: false,
    college: 'MAIT',
    branch: 'CSE',
    graduationYear: 2027,
    tierName: 'Regular',
    ...extra,
  };
}

async function seedScans(eventId: string) {
  await ScanEvent.insertMany([
    // Accepted entries: two in the 04:30 bucket, three in 04:45, one in 05:15 (UTC).
    scan(eventId, '04:31'),
    scan(eventId, '04:40', { college: 'DTU', branch: 'IT', graduationYear: 2026 }),
    scan(eventId, '04:45'),
    scan(eventId, '04:50', { college: 'DTU', tierName: 'VIP', graduationYear: 2026 }),
    scan(eventId, '04:59', { tierName: 'VIP' }),
    scan(eventId, '05:20', { college: null, branch: 'IT', graduationYear: null }),
    // Refused at the gate: counted in results, never as an entry.
    scan(eventId, '04:52', { result: 'DUPLICATE' }),
    scan(eventId, '04:53', { result: 'INVALID', ticketId: null, college: null, tierName: null }),
    // Not gate entries of this event: a sponsor booth scan, and another event's gate.
    scan(eventId, '05:00', { meta: { eventId, type: 'BOOTH', gateOrBoothId: 'stall-1' } }),
    scan(randomUUID(), '04:46'),
  ]);
}

describe('GET /analytics/checkins', () => {
  it('builds the timeline, peak, results and attendee breakdown in one aggregation', async () => {
    const { owner, orgId, eventId } = await setup();
    await seedScans(eventId);

    const res = await checkins(owner, orgId, eventId);

    expect(res.status).toBe(200);
    expect(res.body.checkins).toEqual({
      bucketMinutes: 15,
      timeline: [
        { at: '2026-12-12T04:30:00.000Z', count: 2 },
        { at: '2026-12-12T04:45:00.000Z', count: 3 },
        { at: '2026-12-12T05:15:00.000Z', count: 1 },
      ],
      peak: { at: '2026-12-12T04:45:00.000Z', count: 3, perMinute: 0.2 },
      results: [
        { value: 'ACCEPTED', count: 6 },
        { value: 'DUPLICATE', count: 1 },
        { value: 'INVALID', count: 1 },
      ],
      breakdown: {
        college: [
          { value: 'MAIT', count: 3 },
          { value: 'DTU', count: 2 },
          { value: null, count: 1 },
        ],
        branch: [
          { value: 'CSE', count: 4 },
          { value: 'IT', count: 2 },
        ],
        graduationYear: [
          { value: 2027, count: 3 },
          { value: 2026, count: 2 },
          { value: null, count: 1 },
        ],
        tier: [
          { value: 'Regular', count: 4 },
          { value: 'VIP', count: 2 },
        ],
      },
      totals: { entered: 6 },
    });
  });

  it('uses 5-minute buckets on request, and takes the earliest bucket on a tie for the peak', async () => {
    const { owner, orgId, eventId } = await setup();
    await seedScans(eventId);

    const { body } = await checkins(owner, orgId, eventId, '?bucket=5');

    expect(body.checkins.timeline.map((b: { at: string }) => b.at.slice(11, 16))).toEqual([
      '04:30',
      '04:40',
      '04:45',
      '04:50',
      '04:55',
      '05:20',
    ]);
    expect(body.checkins.peak).toEqual({
      at: '2026-12-12T04:30:00.000Z',
      count: 1,
      perMinute: 0.2,
    });
  });

  it('has no peak and no entries before the gates open', async () => {
    const { owner, orgId, eventId } = await setup();

    const { body } = await checkins(owner, orgId, eventId);

    expect(body.checkins).toMatchObject({ timeline: [], peak: null, totals: { entered: 0 } });
  });

  it('refuses a bucket size other than 5 or 15', async () => {
    const { owner, orgId, eventId } = await setup();
    expect((await checkins(owner, orgId, eventId, '?bucket=7')).status).toBe(400);
  });

  it('is cached for 30 s: a scan right after a read shows up on a later read, not this one', async () => {
    const { owner, orgId, eventId } = await setup();
    await seedScans(eventId);
    await checkins(owner, orgId, eventId);

    await ScanEvent.create(scan(eventId, '06:00'));

    expect((await checkins(owner, orgId, eventId)).body.checkins.totals.entered).toBe(6);
  });
});

describe('who may see analytics', () => {
  it('owners and managers yes, gate scanners no (403), other clubs see nothing (404)', async () => {
    const { owner, orgId, eventId } = await setup();
    const [manager, scanner, stranger] = [await makeUser(), await makeUser(), await makeUser()];
    await addMember(orgId, manager.id, 'MANAGER');
    await addMember(orgId, scanner.id, 'SCANNER');

    expect((await sales(owner, orgId, eventId)).status).toBe(200);
    expect((await sales(manager, orgId, eventId)).status).toBe(200);
    expect((await checkins(manager, orgId, eventId)).status).toBe(200);
    expect((await sales(scanner, orgId, eventId)).status).toBe(403);
    expect((await checkins(scanner, orgId, eventId)).status).toBe(403);
    expect((await sales(stranger, orgId, eventId)).status).toBe(404);
    expect(
      (await request(app).get(`/api/v1/orgs/${orgId}/events/${eventId}/analytics/sales`)).status,
    ).toBe(401);
  });

  it("doesn't show another club's event through your own club's URL", async () => {
    const { eventId: theirs } = await setup();
    const me = await makeUser();
    const myOrg = await makeOrg(me, `Mine ${randomUUID().slice(0, 8)}`);

    expect((await sales(me, myOrg, theirs)).status).toBe(404);
    expect((await checkins(me, myOrg, theirs)).status).toBe(404);
  });
});
