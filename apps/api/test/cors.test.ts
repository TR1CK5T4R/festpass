import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp({ readinessChecks: {} });

describe('CORS', () => {
  it('answers a preflight from the web app with credentials allowed', async () => {
    const res = await request(app)
      .options('/api/v1/auth/refresh')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
  });

  it('lets the web app send Idempotency-Key and read the booking and rate-limit headers', async () => {
    const preflight = await request(app)
      .options('/api/v1/events/x/orders')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type, authorization, idempotency-key');
    const response = await request(app)
      .get('/api/v1/health/live')
      .set('Origin', 'http://localhost:3000');

    expect(preflight.headers['access-control-allow-headers']).toContain('Idempotency-Key');
    for (const header of ['Idempotent-Replayed', 'Retry-After', 'RateLimit-Remaining']) {
      expect(response.headers['access-control-expose-headers']).toContain(header);
    }
  });

  it('gives no CORS headers to any other origin', async () => {
    const res = await request(app).get('/api/v1/health/live').set('Origin', 'https://evil.example');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers.vary).toContain('Origin');
  });
});
