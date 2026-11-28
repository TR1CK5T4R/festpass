import { prisma } from '@festpass/db';
import { connectMongo, disconnectMongo } from '@festpass/mongo';
import { JOBS, QUEUES } from '@festpass/shared';
import { createQueue, createTicketSigner } from '@festpass/shared/server';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { consoleProvider } from './email/console.js';
import { sendGridProvider } from './email/sendgrid.js';
import { loadEnv } from './env.js';
import { processJob, type WorkerDeps } from './processors.js';
import { razorpayRefunds } from './refunds.js';
import { s3TicketStorage } from './storage.js';

// Background jobs, in their own process so a slow job can never slow down the API: hold expiry (each
// order's own delayed job plus a sweeper), refunds, ticket issuing, ticket emails and inventory
// reconciliation, and admitting people from waiting rooms.

const env = loadEnv();
const logger = pino({ level: env.LOG_LEVEL, base: { process: 'worker' } });

// BullMQ needs maxRetriesPerRequest: null: its blocking commands must wait for Redis to come back
// instead of failing after a few retries.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
connection.on('error', (err) => logger.warn({ err: err.message }, 'redis connection error'));

// Only the scan event retries need MongoDB, so an outage must not stop hold expiry or tickets: keep
// trying in the background instead of exiting. Scan jobs fail and back off until it is back.
function connectMongoInBackground() {
  connectMongo(env.MONGODB_URI).catch((err: Error) => {
    logger.warn({ err: err.message }, 'mongo unavailable, retrying in 30 s');
    setTimeout(connectMongoInBackground, 30_000).unref();
  });
}
connectMongoInBackground();

const queues = Object.fromEntries(
  Object.values(QUEUES).map((name) => [name, createQueue(name, connection)]),
) as Record<(typeof QUEUES)[keyof typeof QUEUES], ReturnType<typeof createQueue>>;

const deps: WorkerDeps = {
  redis: connection,
  log: logger,
  refunds: razorpayRefunds(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET),
  email:
    env.EMAIL_PROVIDER === 'sendgrid'
      ? sendGridProvider({
          apiKey: env.SENDGRID_API_KEY!,
          from: env.EMAIL_FROM,
          templateIds: {
            'ticket-confirmation': env.SENDGRID_TEMPLATE_TICKET_CONFIRMATION!,
            'order-expired': env.SENDGRID_TEMPLATE_ORDER_EXPIRED!,
            'refund-issued': env.SENDGRID_TEMPLATE_REFUND_ISSUED!,
            'sponsor-report': env.SENDGRID_TEMPLATE_SPONSOR_REPORT!,
          },
        })
      : consoleProvider(env.EMAIL_PREVIEW_DIR, logger),
  storage: s3TicketStorage(env),
  signTicket: createTicketSigner(env.TICKET_SIGNING_PRIVATE_KEY),
  emailsQueue: queues.emails,
  webUrl: env.PUBLIC_WEB_URL,
  admissionSecret: env.ADMISSION_TOKEN_SECRET,
};

// Repeating jobs. upsertJobScheduler is idempotent: restarting the worker (or running two) keeps one
// schedule per ID. Every minute: reset inv:* from Postgres, and expire holds whose own job never ran.
await queues.inventory.upsertJobScheduler(
  JOBS.reconcileInventory,
  { every: 60_000 },
  { name: JOBS.reconcileInventory },
);
await queues.orders.upsertJobScheduler(
  JOBS.sweepExpiredOrders,
  { every: 60_000 },
  { name: JOBS.sweepExpiredOrders },
);

// One schedule serving every active waiting room each second, rather than one per event: with nothing
// to start or stop per event, a failed start can never leave a line that nobody is serving. The next tick
// is the retry, and a job per second would flood the history, so ticks aren't retried or kept.
await queues[QUEUES.waitingRoom].upsertJobScheduler(
  JOBS.admitWaitingRooms,
  { every: 1000 },
  {
    name: JOBS.admitWaitingRooms,
    opts: { attempts: 1, removeOnComplete: true, removeOnFail: { count: 100 } },
  },
);

// Each queue gets its own worker so a backlog of one (say, slow emails) can't delay the others.
const workers = Object.keys(queues).map((name) => {
  const worker = new Worker(name, (job) => processJob(job, deps), { connection });
  // Failed jobs are retried with backoff (createQueue) and kept in Bull Board once attempts run out.
  worker.on('failed', (job, err) =>
    logger.error({ job: job?.id, name: job?.name, attempt: job?.attemptsMade, err }, 'job failed'),
  );
  return worker;
});

logger.info({ queues: Object.keys(queues), email: env.EMAIL_PROVIDER }, 'worker started');

async function shutdown(signal: NodeJS.Signals) {
  logger.info({ signal }, 'worker shutting down');
  // close() waits for the job in progress to finish, so nothing is cut in half.
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(Object.values(queues).map((q) => q.close()));
  await Promise.allSettled([prisma.$disconnect(), connection.quit(), disconnectMongo()]);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
