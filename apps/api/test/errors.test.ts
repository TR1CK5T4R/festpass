import { paginationQuerySchema } from '@festpass/shared';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { ConflictError } from '../src/lib/errors.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { requestLogger } from '../src/middleware/request-logger.js';
import { validate } from '../src/middleware/validate.js';

// No feature routes exist yet, so these tests mount a few on the same middleware stack the app uses.
function testApp() {
  const app = express();
  app.use(requestLogger);
  app.use(express.json());
  app.post(
    '/things',
    validate({
      body: z.object({ name: z.string().min(1), qty: z.number().int().positive() }),
      query: paginationQuerySchema,
    }),
    (req, res) => {
      res.json({ body: req.body, query: req.query });
    },
  );
  app.get('/sold-out', () => {
    throw new ConflictError('SOLD_OUT', 'This tier is sold out');
  });
  app.get('/boom', async () => {
    throw new Error('connection to db-internal-3 refused');
  });
  app.use(errorHandler);
  return app;
}

describe('request IDs', () => {
  it('reuses a safe incoming X-Request-Id', async () => {
    const res = await request(createApp()).get('/api/v1/nope').set('X-Request-Id', 'abc-123');

    expect(res.headers['x-request-id']).toBe('abc-123');
    expect(res.body.error.requestId).toBe('abc-123');
  });

  it('replaces an unsafe incoming X-Request-Id with a fresh UUID', async () => {
    const res = await request(createApp()).get('/api/v1/nope').set('X-Request-Id', 'a b\tc');

    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('unknown routes', () => {
  it('return 404 in the standard error shape', async () => {
    const res = await request(createApp()).get('/api/v1/nope');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'No route for GET /api/v1/nope',
        details: {},
        requestId: res.headers['x-request-id'],
      },
    });
  });
});

describe('validate middleware', () => {
  it('returns 400 with every invalid field and a requestId', async () => {
    const res = await request(testApp()).post('/things?limit=500').send({ name: '', qty: 'two' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    expect(res.body.error.details.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ location: 'query', path: 'limit' }),
        expect.objectContaining({ location: 'body', path: 'name' }),
        expect.objectContaining({ location: 'body', path: 'qty' }),
      ]),
    );
  });

  it('passes parsed values (coerced, with defaults) to the handler', async () => {
    const res = await request(testApp()).post('/things?limit=5').send({ name: 'VIP', qty: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ body: { name: 'VIP', qty: 2 }, query: { limit: 5 } });
  });

  it('rejects a body that is not valid JSON', async () => {
    const res = await request(testApp())
      .post('/things')
      .set('Content-Type', 'application/json')
      .send('{"name":');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});

describe('error handler', () => {
  it('renders an AppError with its own status and code', async () => {
    const res = await request(testApp()).get('/sold-out');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'SOLD_OUT', message: 'This tier is sold out' });
  });

  it('hides the message and stack of unexpected errors outside development', async () => {
    const res = await request(testApp()).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong',
      details: {},
    });
    expect(JSON.stringify(res.body)).not.toContain('db-internal-3');
  });
});
