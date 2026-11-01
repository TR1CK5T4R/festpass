import express from 'express';

// Building the app separately from listening lets tests call it with Supertest
// without opening a real port.
export function createApp() {
  const app = express();

  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}
