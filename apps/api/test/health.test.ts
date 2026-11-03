import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { ReadinessChecks } from '../src/modules/health/service.js';

const up = async () => {};
const allUp: ReadinessChecks = { postgres: up, redis: up, mongo: up };

describe('GET /api/v1/health/live', () => {
  it('returns ok without touching any dependency', async () => {
    const res = await request(createApp({ readinessChecks: {} })).get('/api/v1/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('GET /api/v1/health/ready', () => {
  it('returns 200 when every dependency is up', async () => {
    const res = await request(createApp({ readinessChecks: allUp })).get('/api/v1/health/ready');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      checks: { postgres: 'up', redis: 'up', mongo: 'up' },
    });
  });

  it('returns 503 and names the dependency that is down', async () => {
    const checks = { ...allUp, redis: () => Promise.reject(new Error('ECONNREFUSED')) };

    const res = await request(createApp({ readinessChecks: checks })).get('/api/v1/health/ready');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: 'unavailable',
      checks: { postgres: 'up', redis: 'down', mongo: 'up' },
    });
    // The reason stays in the logs; clients only learn which dependency is down.
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });

  it('treats a check that hangs as down', async () => {
    const checks = { ...allUp, mongo: () => new Promise<void>(() => {}) };

    const res = await request(createApp({ readinessChecks: checks })).get('/api/v1/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.checks.mongo).toBe('down');
  });
});
