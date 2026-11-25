import { randomUUID } from 'node:crypto';
import { prisma } from '@festpass/db';
import { truncateAll } from '@festpass/db/testing';
import { redisKeys } from '@festpass/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cached, invalidatePublicEvents } from '../src/lib/cache.js';
import { gateRedis } from '../src/lib/redis.js';
import { app, createSaleEvent, makeOrg, makeUser, type TestUser } from './helpers.js';

beforeEach(async () => {
  await truncateAll(prisma);
  await gateRedis.flushdb();
});

async function publishedEvent() {
  const owner = await makeUser('Organizer');
  const orgId = await makeOrg(owner, `Club ${randomUUID().slice(0, 8)}`);
  const { eventId, tierIds } = await createSaleEvent(owner, orgId, [
    { name: 'Regular', capacity: 100 },
  ]);
  const { slug } = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
  return { owner, orgId, eventId, slug, tierId: tierIds[0]! };
}

const getEvent = (slug: string) => request(app).get(`/api/v1/events/${slug}`);
const patch = (owner: TestUser, orgId: string, eventId: string, body: object) =>
  request(app).patch(`/api/v1/orgs/${orgId}/events/${eventId}`).set(owner.auth).send(body);

describe('GET /events/:slug cache', () => {
  it('serves a second read from the cache, not Postgres', async () => {
    const { slug, eventId } = await publishedEvent();
    expect((await getEvent(slug)).body.event.title).not.toBe('Changed behind the API');

    // A change made straight in the database, bypassing the API, is not seen while cached.
    await prisma.event.update({
      where: { id: eventId },
      data: { title: 'Changed behind the API' },
    });

    expect((await getEvent(slug)).body.event.title).not.toBe('Changed behind the API');
  });

  it('returns fresh data on the next read after an update through the API', async () => {
    const { owner, orgId, eventId, slug } = await publishedEvent();
    await getEvent(slug);

    expect((await patch(owner, orgId, eventId, { title: 'Hack Night v2' })).status).toBe(200);

    expect((await getEvent(slug)).body.event.title).toBe('Hack Night v2');
  });

  it('returns fresh tiers after a tier is changed, added or removed', async () => {
    const { owner, orgId, eventId, slug, tierId } = await publishedEvent();
    await getEvent(slug);
    const tiers = `/api/v1/orgs/${orgId}/events/${eventId}/tiers`;

    await request(app).patch(`${tiers}/${tierId}`).set(owner.auth).send({ pricePaise: 49_900 });
    expect((await getEvent(slug)).body.event.tiers[0].pricePaise).toBe(49_900);

    const added = await request(app)
      .post(tiers)
      .set(owner.auth)
      .send({ name: 'VIP', pricePaise: 99_900, capacity: 10 });
    expect((await getEvent(slug)).body.event.tiers).toHaveLength(2);

    await request(app).delete(`${tiers}/${added.body.tier.id}`).set(owner.auth);
    expect((await getEvent(slug)).body.event.tiers).toHaveLength(1);
  });

  it('shows a closed event as closed at once', async () => {
    const { owner, orgId, eventId, slug } = await publishedEvent();
    await getEvent(slug);

    await request(app).post(`/api/v1/orgs/${orgId}/events/${eventId}/close`).set(owner.auth);

    expect((await getEvent(slug)).body.event.status).toBe('CLOSED');
  });

  it('takes tickets left from the booking gate, and Postgres when Redis has no number', async () => {
    const { slug, tierId } = await publishedEvent();
    await getEvent(slug);

    await gateRedis.set(redisKeys.inventory(tierId), '37');
    expect((await getEvent(slug)).body.event.tiers[0]).toMatchObject({
      available: 37,
      soldCount: 63,
    });

    await gateRedis.del(redisKeys.inventory(tierId));
    expect((await getEvent(slug)).body.event.tiers[0].available).toBe(100);
  });

  it('still answers from Postgres when Redis fails', async () => {
    const { slug } = await publishedEvent();
    const spies = [
      vi.spyOn(gateRedis, 'festpassCacheGet').mockRejectedValue(new Error('down')),
      vi.spyOn(gateRedis, 'mget').mockRejectedValue(new Error('down')),
    ];

    const res = await getEvent(slug);

    for (const spy of spies) spy.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.event.tiers[0].available).toBe(100);
  });

  it('does not cache a missing event, so a draft shows up once published', async () => {
    const owner = await makeUser();
    const orgId = await makeOrg(owner);
    const created = await request(app)
      .post(`/api/v1/orgs/${orgId}/events`)
      .set(owner.auth)
      .send({
        title: 'Late Starter',
        venue: 'Hall',
        startsAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
        endsAt: new Date(Date.now() + 50 * 3600_000).toISOString(),
        saleStartsAt: new Date(Date.now() - 3600_000).toISOString(),
        saleEndsAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      });
    const { id, slug } = created.body.event;
    await request(app)
      .post(`/api/v1/orgs/${orgId}/events/${id}/tiers`)
      .set(owner.auth)
      .send({ name: 'Regular', pricePaise: 100, capacity: 5 });
    expect((await getEvent(slug)).status).toBe(404);

    await request(app).post(`/api/v1/orgs/${orgId}/events/${id}/publish`).set(owner.auth);

    expect((await getEvent(slug)).status).toBe(200);
  });
});

describe('GET /events cache', () => {
  it('lists a newly published event on the next read', async () => {
    await publishedEvent();
    expect((await request(app).get('/api/v1/events')).body.items).toHaveLength(1);

    await publishedEvent();

    expect((await request(app).get('/api/v1/events')).body.items).toHaveLength(2);
  });
});

describe('cached()', () => {
  it('runs one load for a crowd missing the same key at once', async () => {
    const load = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { n: 1 };
    });

    const answers = await Promise.all(Array.from({ length: 50 }, () => cached('k:crowd', load)));

    expect(load).toHaveBeenCalledTimes(1);
    expect(answers.every((a) => JSON.stringify(a) === '{"n":1}')).toBe(true);
  });

  it('never stores a value loaded before an invalidation', async () => {
    let release!: () => void;
    const slowOld = cached(
      'k:race',
      () => new Promise((resolve) => (release = () => resolve('old'))),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The edit commits and invalidates while the old value is still being loaded.
    await invalidatePublicEvents();
    release();
    expect(await slowOld).toBe('old');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await cached('k:race', async () => 'new')).toBe('new');
  });

  it('answers a hit and a miss with the same shape (dates as strings)', async () => {
    const at = new Date('2026-11-21T10:00:00.000Z');
    const miss = await cached<{ at: string }>('k:dates', async () => ({ at }));
    const hit = await cached<{ at: string }>('k:dates', async () => ({ at: 'unused' }));

    expect(miss).toEqual({ at: '2026-11-21T10:00:00.000Z' });
    expect(hit).toEqual(miss);
  });
});

describe('headers', () => {
  it('lets clients cache public reads briefly, and not 404s or private reads', async () => {
    const { owner, orgId, eventId, slug } = await publishedEvent();

    const list = await request(app).get('/api/v1/events');
    const one = await getEvent(slug);
    const missing = await getEvent('no-such-event');
    const own = await request(app).get(`/api/v1/orgs/${orgId}/events/${eventId}`).set(owner.auth);

    expect(list.headers['cache-control']).toBe('public, max-age=5, stale-while-revalidate=25');
    expect(one.headers['cache-control']).toBe('public, max-age=5, stale-while-revalidate=25');
    expect(missing.headers['cache-control']).toBeUndefined();
    expect(own.headers['cache-control']).toBeUndefined();
  });

  it('answers 304 to a repeat request with the same ETag', async () => {
    const { slug } = await publishedEvent();
    const first = await getEvent(slug);

    const again = await getEvent(slug).set('If-None-Match', first.headers.etag!);

    expect(again.status).toBe(304);
  });

  it('compresses larger responses for clients that accept gzip', async () => {
    for (let i = 0; i < 6; i++) await publishedEvent();

    const res = await request(app).get('/api/v1/events').set('Accept-Encoding', 'gzip');

    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.items).toHaveLength(6);
  });
});
