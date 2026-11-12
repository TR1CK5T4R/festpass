import { prisma } from '@festpass/db';
import { truncateAll } from '@festpass/db/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMember, app, makeOrg, makeUser, type TestUser } from './helpers.js';

beforeEach(() => truncateAll(prisma));
afterAll(() => prisma.$disconnect());

const DAY = 24 * 60 * 60 * 1000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();

// Sales open in 1 day and close at day 29; the event runs on day 30.
const eventBody = (title = 'Tech Fest 2026') => ({
  title,
  description: 'Talks, hackathon and a sponsor expo.',
  venue: 'MAIT Auditorium',
  startsAt: inDays(30),
  endsAt: inDays(30.4),
  saleStartsAt: inDays(1),
  saleEndsAt: inDays(29),
});
const tierBody = { name: 'Regular', pricePaise: 29_900, capacity: 100 };

let owner: TestUser;
let orgId: string;
const orgPath = () => `/api/v1/orgs/${orgId}/events`;

beforeEach(async () => {
  owner = await makeUser('Olivia');
  orgId = await makeOrg(owner);
});

async function createEvent(body: object = eventBody()) {
  const res = await request(app).post(orgPath()).set(owner.auth).send(body);
  expect(res.status).toBe(201);
  return res.body.event as { id: string; slug: string };
}

async function createTier(eventId: string, body: object = tierBody) {
  const res = await request(app).post(`${orgPath()}/${eventId}/tiers`).set(owner.auth).send(body);
  expect(res.status).toBe(201);
  return res.body.tier as { id: string };
}

const publish = (eventId: string) =>
  request(app).post(`${orgPath()}/${eventId}/publish`).set(owner.auth);

describe('organizer flow', () => {
  it('creates, configures and publishes an event that then appears publicly', async () => {
    const event = await createEvent();
    expect(event.slug).toBe('tech-fest-2026');
    await createTier(event.id, { ...tierBody, name: 'Early bird', pricePaise: 19_900 });
    await createTier(event.id);

    const published = await publish(event.id);
    expect(published.status).toBe(200);
    expect(published.body.event.status).toBe('PUBLISHED');

    const list = await request(app).get('/api/v1/events');
    expect(list.body.items.map((e: { slug: string }) => e.slug)).toEqual(['tech-fest-2026']);

    const page = await request(app).get('/api/v1/events/tech-fest-2026');
    expect(page.status).toBe(200);
    expect(page.body.event.tiers).toEqual([
      expect.objectContaining({ name: 'Early bird', capacity: 100, soldCount: 0, available: 100 }),
      expect.objectContaining({ name: 'Regular', available: 100 }),
    ]);
  });

  it('adds a short suffix when the slug is taken', async () => {
    await createEvent();
    const second = await createEvent();

    expect(second.slug).toMatch(/^tech-fest-2026-[0-9a-f]{4}$/);
  });

  it('rejects an event that ends before it starts', async () => {
    const res = await request(app)
      .post(orgPath())
      .set(owner.auth)
      .send({ ...eventBody(), endsAt: inDays(29) });

    expect(res.status).toBe(400);
    expect(res.body.error.details.fields).toContainEqual(
      expect.objectContaining({ path: 'endsAt' }),
    );
  });

  it('a scanner cannot create events, and another org cannot see them', async () => {
    const scanner = await makeUser();
    await addMember(orgId, scanner.id, 'SCANNER');
    const event = await createEvent();
    const outsider = await makeUser();

    const byScanner = await request(app).post(orgPath()).set(scanner.auth).send(eventBody());
    const byOutsider = await request(app).get(`${orgPath()}/${event.id}`).set(outsider.auth);

    expect(byScanner.status).toBe(403);
    expect(byOutsider.status).toBe(404);
  });

  it('queue settings default to off at 50/s, and an unrelated edit leaves them alone', async () => {
    const event = await createEvent();
    const turnOn = await request(app)
      .patch(`${orgPath()}/${event.id}`)
      .set(owner.auth)
      .send({ queueMode: true, admitRatePerSec: 5 });
    const rename = await request(app)
      .patch(`${orgPath()}/${event.id}`)
      .set(owner.auth)
      .send({ title: 'Tech Fest Finale' });

    expect(event).toMatchObject({ queueMode: false, admitRatePerSec: 50 });
    expect(turnOn.body.event).toMatchObject({ queueMode: true, admitRatePerSec: 5 });
    expect(rename.body.event).toMatchObject({ queueMode: true, admitRatePerSec: 5 });
  });

  it('rejects an admit rate outside 1–1000 per second', async () => {
    const res = await request(app)
      .post(orgPath())
      .set(owner.auth)
      .send({ ...eventBody(), admitRatePerSec: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error.details.fields).toContainEqual(
      expect.objectContaining({ path: 'admitRatePerSec' }),
    );
  });

  it('the org event list sums sold and capacity over the tiers', async () => {
    const event = await createEvent();
    const vip = await createTier(event.id, { ...tierBody, name: 'VIP', capacity: 20 });
    await createTier(event.id);
    await prisma.ticketTier.update({ where: { id: vip.id }, data: { soldCount: 7 } });
    await createEvent(eventBody('Empty Fest'));

    const res = await request(app).get(orgPath()).set(owner.auth);

    expect(res.body.items).toEqual([
      expect.objectContaining({ id: event.id, status: 'DRAFT', capacity: 120, soldCount: 7 }),
      expect.objectContaining({ title: 'Empty Fest', capacity: 0, soldCount: 0 }),
    ]);
    expect(res.body.items[0]).not.toHaveProperty('tiers');
  });
});

describe('tier rules', () => {
  it.each([
    ['capacity must be > 0', { capacity: 0 }, 'capacity'],
    ['price must be >= 0', { pricePaise: -1 }, 'pricePaise'],
    ['price must be whole paise', { pricePaise: 99.5 }, 'pricePaise'],
    ['per-user limit at least 1', { perUserLimit: 0 }, 'perUserLimit'],
    ['per-user limit at most 10', { perUserLimit: 11 }, 'perUserLimit'],
    ['sale cannot start before the event sale', { saleStartsAt: inDays(0.5) }, 'saleStartsAt'],
    ['sale cannot end after the event sale', { saleEndsAt: inDays(29.5) }, 'saleEndsAt'],
  ])('%s', async (_name, override, path) => {
    const event = await createEvent();
    const res = await request(app)
      .post(`${orgPath()}/${event.id}/tiers`)
      .set(owner.auth)
      .send({ ...tierBody, ...override });

    expect(res.status).toBe(400);
    expect(res.body.error.details.fields).toContainEqual(expect.objectContaining({ path }));
  });

  it('accepts a shorter sale window inside the event sale window (early bird)', async () => {
    const event = await createEvent();
    await createTier(event.id, { ...tierBody, saleStartsAt: inDays(1), saleEndsAt: inDays(10) });
  });

  it('rejects a duplicate tier name', async () => {
    const event = await createEvent();
    await createTier(event.id);
    const res = await request(app)
      .post(`${orgPath()}/${event.id}/tiers`)
      .set(owner.auth)
      .send(tierBody);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TIER_NAME_TAKEN');
  });

  describe('after a sale', () => {
    let tierPath: string;
    beforeEach(async () => {
      const event = await createEvent();
      const tier = await createTier(event.id);
      tierPath = `${orgPath()}/${event.id}/tiers/${tier.id}`;
      // Simulates the booking engine having sold 5 tickets.
      await prisma.ticketTier.update({ where: { id: tier.id }, data: { soldCount: 5 } });
    });
    const patch = (body: object) => request(app).patch(tierPath).set(owner.auth).send(body);

    it('locks the price', async () => {
      const res = await patch({ pricePaise: 34_900 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRICE_LOCKED');
    });

    it('only lets capacity grow', async () => {
      const shrink = await patch({ capacity: 3 });
      const grow = await patch({ capacity: 150 });

      expect(shrink.status).toBe(409);
      expect(shrink.body.error.code).toBe('CAPACITY_LOCKED');
      expect(grow.status).toBe(200);
      expect(grow.body.tier).toMatchObject({ capacity: 150, soldCount: 5, available: 145 });
    });

    it('still allows other edits, and sending the same price', async () => {
      const res = await patch({ name: 'General', pricePaise: 29_900 });

      expect(res.status).toBe(200);
      expect(res.body.tier.name).toBe('General');
    });

    it('cannot be deleted', async () => {
      const res = await request(app).delete(tierPath).set(owner.auth);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TIER_HAS_SALES');
    });
  });

  it('price and capacity are free to change before any sale, and an unsold tier can be deleted', async () => {
    const event = await createEvent();
    const tier = await createTier(event.id);
    const tierPath = `${orgPath()}/${event.id}/tiers/${tier.id}`;

    const edit = await request(app)
      .patch(tierPath)
      .set(owner.auth)
      .send({ pricePaise: 0, capacity: 1 });
    expect(edit.status).toBe(200);
    expect((await request(app).delete(tierPath).set(owner.auth)).status).toBe(204);
  });
});

describe('publishing', () => {
  it('needs at least one tier', async () => {
    const event = await createEvent();
    const res = await publish(event.id);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_TIERS');
  });

  it('needs a start time in the future', async () => {
    const event = await createEvent({
      ...eventBody(),
      startsAt: inDays(-1),
      endsAt: inDays(1),
      saleStartsAt: inDays(-5),
      saleEndsAt: inDays(-1),
    });
    await createTier(event.id);

    const res = await publish(event.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_IN_PAST');
  });

  it('only moves DRAFT -> PUBLISHED -> CLOSED', async () => {
    const event = await createEvent();
    await createTier(event.id);
    expect((await publish(event.id)).status).toBe(200);

    const again = await publish(event.id);
    const close = await request(app).post(`${orgPath()}/${event.id}/close`).set(owner.auth);
    const reopen = await publish(event.id);
    const editClosed = await request(app)
      .patch(`${orgPath()}/${event.id}`)
      .set(owner.auth)
      .send({ venue: 'Somewhere else' });

    expect(again.body.error.code).toBe('INVALID_TRANSITION');
    expect(close.body.event.status).toBe('CLOSED');
    expect(reopen.body.error.code).toBe('INVALID_TRANSITION');
    expect(editClosed.body.error.code).toBe('EVENT_CLOSED');
  });
});

describe('public endpoints', () => {
  it('never show drafts', async () => {
    const draft = await createEvent();
    await createTier(draft.id);

    expect((await request(app).get('/api/v1/events')).body.items).toEqual([]);
    expect((await request(app).get(`/api/v1/events/${draft.slug}`)).status).toBe(404);
  });

  it('filters by org', async () => {
    const other = await makeOrg(await makeUser(), 'Robotics Club');
    await prisma.event.createMany({
      data: [orgId, other].map((id, i) => ({
        orgId: id,
        ...eventBody(),
        slug: `event-${i}`,
        status: 'PUBLISHED' as const,
      })),
    });

    const res = await request(app).get(`/api/v1/events?orgId=${other}`);
    expect(res.body.items.map((e: { slug: string }) => e.slug)).toEqual(['event-1']);
  });

  it('cursor pagination returns every event exactly once, in order, even if one is added mid-way', async () => {
    // 7 published events; three start at the same moment, so the id tie-breaker matters.
    const starts = [5, 5, 5, 6, 7, 8, 9];
    await prisma.event.createMany({
      data: starts.map((d, i) => ({
        orgId,
        ...eventBody(),
        slug: `fest-${i}`,
        startsAt: inDays(d),
        endsAt: inDays(d + 0.5),
        saleEndsAt: inDays(d - 1),
        status: 'PUBLISHED' as const,
      })),
    });
    const expected = (
      await prisma.event.findMany({ orderBy: [{ startsAt: 'asc' }, { id: 'asc' }] })
    ).map((e) => e.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await request(app)
        .get('/api/v1/events')
        .query({ limit: 3, ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((e: { id: string }) => e.id));
      cursor = res.body.nextCursor;
      pages += 1;
      // A new event that starts before the current page must not shift or repeat later pages.
      if (pages === 1) {
        await prisma.event.create({
          data: {
            orgId,
            ...eventBody(),
            slug: 'late-addition',
            status: 'PUBLISHED',
            startsAt: inDays(2),
            endsAt: inDays(3),
            saleEndsAt: inDays(1.5),
          },
        });
      }
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toEqual(expected);
  });

  it('rejects a malformed cursor', async () => {
    const res = await request(app).get('/api/v1/events?cursor=not-a-cursor');

    expect(res.status).toBe(400);
    expect(res.body.error.details.fields).toContainEqual(
      expect.objectContaining({ location: 'query', path: 'cursor' }),
    );
  });
});

describe('public page revalidation', () => {
  afterEach(() => vi.restoreAllMocks());

  const webCalls = (spy: { mock: { calls: Parameters<typeof fetch>[] } }) =>
    spy.mock.calls.map(([url, init]) => ({
      url: String(url),
      auth: new Headers((init as RequestInit).headers).get('authorization'),
      body: JSON.parse(String((init as RequestInit).body)),
    }));

  it('tells the web app after publishing and after editing a published event', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    const event = await createEvent();
    await createTier(event.id);
    await request(app).patch(`${orgPath()}/${event.id}`).set(owner.auth).send({ venue: 'Hall B' });
    expect(fetchSpy).not.toHaveBeenCalled(); // drafts have no public page

    await publish(event.id);
    await request(app).patch(`${orgPath()}/${event.id}`).set(owner.auth).send({ venue: 'Hall C' });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(webCalls(fetchSpy)).toEqual([
      {
        url: process.env.WEB_REVALIDATE_URL,
        auth: `Bearer ${process.env.REVALIDATE_SECRET}`,
        body: { slug: event.slug },
      },
      expect.objectContaining({ body: { slug: event.slug } }),
    ]);
  });

  it('a failing web app never fails the organizer request', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const event = await createEvent();
    await createTier(event.id);

    expect((await publish(event.id)).status).toBe(200);
  });
});
