import { randomUUID } from 'node:crypto';
import { prisma } from '@festpass/db';
import { truncateAll } from '@festpass/db/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { gateRedis } from '../src/lib/redis.js';
import { makeUser } from './helpers.js';

beforeEach(async () => {
  await truncateAll(prisma);
  if (gateRedis.options.db !== 15) throw new Error('tests must use redis database 15');
  await gateRedis.flushdb();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => prisma.$disconnect());

// Small limits against real Redis. A burst of 3 that refills one token every 10 s: login and register
// run bcrypt (~200 ms each), so a fast refill would hand tokens back between requests.
const tiny = { capacity: 3, refillPerSec: 0.1 };
const app = createApp({ rateLimits: { login: tiny, register: tiny, orders: tiny, presign: tiny } });
// For watching the refill: one token every 200 ms, on the order endpoint, which answers in ms.
const fast = createApp({ rateLimits: { orders: { capacity: 2, refillPerSec: 5 } } });

const login = (email = 'asha@mait.ac.in') =>
  request(app).post('/api/v1/auth/login').send({ email, password: 'wrong-password' });

const rateHeaders = (res: request.Response) => ({
  limit: res.headers['ratelimit-limit'],
  remaining: res.headers['ratelimit-remaining'],
  reset: res.headers['ratelimit-reset'],
});

describe('token bucket rate limiting', () => {
  it('a burst up to the capacity passes, then requests get 429 with Retry-After', async () => {
    const responses = [];
    for (let i = 0; i < 4; i++) responses.push(await login());

    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 429]);
    const limited = responses[3]!;
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    // Seconds until the next token at 0.1 tokens/s: up to 10, the same in the header and the body.
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(9);
    expect(retryAfter).toBeLessThanOrEqual(10);
    expect(limited.body.error.details.retryAfterSeconds).toBe(retryAfter);
  });

  it('RateLimit-* headers are on allowed and limited responses', async () => {
    const responses = [];
    for (let i = 0; i < 4; i++) responses.push(await login());

    const headers = responses.map(rateHeaders);
    expect(headers.map((h) => [h.limit, h.remaining])).toEqual([
      ['3', '2'],
      ['3', '1'],
      ['3', '0'],
      ['3', '0'],
    ]);
    // Seconds until the bucket is full again: about 10 per missing token at 0.1 tokens/s.
    expect(headers.map((h) => Number(h.reset))).toEqual([
      expect.closeTo(10, 0),
      expect.closeTo(20, 0),
      expect.closeTo(30, 0),
      expect.closeTo(30, 0),
    ]);
    expect(responses[0]!.headers['retry-after']).toBeUndefined();
  });

  it('tokens flow back at the refill rate', async () => {
    const user = await makeUser();
    const order = () =>
      request(fast)
        .post(`/api/v1/events/${randomUUID()}/orders`)
        .set(user.auth)
        .set('Idempotency-Key', randomUUID())
        .send({ items: [{ tierId: randomUUID(), qty: 1 }] });

    expect([(await order()).status, (await order()).status, (await order()).status]).toEqual([
      404, 404, 429,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250)); // one token back (every 200 ms)
    expect([(await order()).status, (await order()).status]).toEqual([404, 429]);
  });

  it('20 parallel requests on a bucket of 3: exactly 3 get through', async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => login()));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(17);
  });

  it('login counts per IP and email: another account from the same IP is not blocked', async () => {
    for (let i = 0; i < 4; i++) await login('asha@mait.ac.in');
    expect((await login('ASHA@mait.ac.in ')).status).toBe(429); // same account, any spelling
    expect((await login('ravi@mait.ac.in')).status).toBe(401);
  });

  it('register counts per IP', async () => {
    const register = () =>
      request(app)
        .post('/api/v1/auth/register')
        .send({ email: `${randomUUID()}@mait.ac.in`, password: 'long-enough-1', name: 'New' });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await register()).status);
    expect(statuses).toEqual([201, 201, 201, 429]);
  });

  it('orders and presign count per user', async () => {
    const [a, b] = [await makeUser('A'), await makeUser('B')];
    const order = (user: typeof a) =>
      request(app)
        .post(`/api/v1/events/${randomUUID()}/orders`)
        .set(user.auth)
        .set('Idempotency-Key', randomUUID())
        .send({ items: [{ tierId: randomUUID(), qty: 1 }] });
    const presign = (user: typeof a) =>
      request(app)
        .post('/api/v1/uploads/presign')
        .set(user.auth)
        .send({ eventId: randomUUID(), contentType: 'image/png' });

    for (let i = 0; i < 3; i++) await order(a); // 404s: no such event, but each costs a token
    expect((await order(a)).status).toBe(429);
    expect((await order(b)).status).toBe(404); // b has its own bucket

    for (let i = 0; i < 3; i++) await presign(a);
    expect((await presign(a)).status).toBe(429);
    expect((await presign(b)).status).toBe(404);
  });

  it('fails open: with Redis down the request goes through, without rate headers', async () => {
    vi.spyOn(gateRedis, 'festpassRateLimit').mockRejectedValue(new Error('Connection is closed.'));
    const responses = [];
    for (let i = 0; i < 5; i++) responses.push(await login());

    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
    expect(responses[0]!.headers['ratelimit-limit']).toBeUndefined();
  });
});
