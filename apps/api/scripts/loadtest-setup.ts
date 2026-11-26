import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Prepares one flash sale for k6 (infra/k6/flash-sale.js): a club, a published event with one tier of
// CAPACITY tickets (default 500), and USERS buyers (default 5000) with signed access tokens, written
// to infra/k6/.data/sale.json (gitignored). Run while `pnpm loadtest:api` is up: the event is created
// through the API, so publishing loads its stock into the Redis gate exactly as in production.
// Buyers are inserted directly and their tokens signed here, because registering 5,000 accounts
// would mostly measure bcrypt.

const USERS = Number(process.env.USERS ?? 5000);
const CAPACITY = Number(process.env.CAPACITY ?? 500);
const API = process.env.API_URL ?? 'http://localhost:4000/api/v1';

// The same stores as scripts/loadtest-server.mjs. Set before @festpass/db is imported, which reads it.
const db = new URL(process.env.DATABASE_URL!);
db.pathname = '/festpass_perf';
process.env.DATABASE_URL = db.href;

const { prisma } = await import('@festpass/db');
const { default: jwt } = await import('jsonwebtoken');
const secret = process.env.JWT_ACCESS_SECRET!;
const sign = (userId: string) =>
  jwt.sign({}, secret, { subject: userId, algorithm: 'HS256', expiresIn: '2h' });

const run = randomUUID().slice(0, 8);
const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

async function api(path: string, token: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, { id: string; slug: string }>;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const organizer = await prisma.user.create({
  data: { email: `load-organizer-${run}@example.com`, name: 'Load Organizer', passwordHash: 'x' },
});
const org = await prisma.organization.create({
  data: {
    name: `Load Club ${run}`,
    slug: `load-club-${run}`,
    members: { create: { userId: organizer.id, role: 'OWNER' } },
  },
});
const organizerToken = sign(organizer.id);
const { event } = await api(`/orgs/${org.id}/events`, organizerToken, {
  title: `Flash Sale ${run}`,
  venue: 'Main Ground',
  startsAt: hours(48),
  endsAt: hours(52),
  saleStartsAt: hours(-1),
  saleEndsAt: hours(24),
});
const { tier } = await api(`/orgs/${org.id}/events/${event!.id}/tiers`, organizerToken, {
  name: 'General',
  pricePaise: 29_900,
  capacity: CAPACITY,
  perUserLimit: 1,
});
await api(`/orgs/${org.id}/events/${event!.id}/publish`, organizerToken);

const buyers = await prisma.user.createManyAndReturn({
  data: Array.from({ length: USERS }, (_, i) => ({
    email: `load-${run}-${i}@example.com`,
    name: `Load Buyer ${i}`,
    passwordHash: 'x',
  })),
  select: { id: true },
});

const dir = new URL('../../../infra/k6/.data/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(
  new URL('sale.json', dir),
  JSON.stringify({
    run,
    eventId: event!.id,
    slug: event!.slug,
    tierId: tier!.id,
    capacity: CAPACITY,
    tokens: buyers.map((b) => sign(b.id)),
  }),
);
console.log(
  `sale ready: event ${event!.slug}, tier capacity ${CAPACITY}, ${USERS} buyers -> infra/k6/.data/sale.json`,
);
await prisma.$disconnect();
