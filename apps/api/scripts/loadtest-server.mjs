// Starts the API's production build (run `pnpm loadtest:api` from the repo root, which builds it first)
// pointed at the load-test stores, so a load test never touches dev data:
//   Postgres: festpass_perf (pnpm perf:seed creates it), Redis: database 3.
// Plain JavaScript on purpose: it runs with node, like production, not through tsx.

process.env.NODE_ENV = 'production';
const db = new URL(process.env.DATABASE_URL);
db.pathname = '/festpass_perf';
process.env.DATABASE_URL = db.href;
const redis = new URL(process.env.REDIS_URL);
redis.pathname = '/3';
process.env.REDIS_URL = redis.href;
// Nothing listens on port 9: publishing the test event must not call a web app (or anything else on 3000).
process.env.WEB_REVALIDATE_URL = 'http://127.0.0.1:9/api/revalidate';

console.log(
  `load-test API: database festpass_perf, redis db 3, booking gate ${process.env.BOOKING_GATE ?? 'on'}`,
);
await import('../dist/server.js');
