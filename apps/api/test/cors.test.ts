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

  it('gives no CORS headers to any other origin', async () => {
    const res = await request(app).get('/api/v1/health/live').set('Origin', 'https://evil.example');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers.vary).toContain('Origin');
  });
});
