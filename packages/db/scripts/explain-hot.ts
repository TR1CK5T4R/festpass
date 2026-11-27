import { salesByDay, tierSales } from '../src/analytics.js';
import { perfClient } from './perf-db.js';

// EXPLAIN (ANALYZE, BUFFERS) for the hot queries, against festpass_perf (pnpm perf:seed first).
// Each query runs once to warm the cache, then RUNS more times; the median execution time is reported
// with the plan of the last run. Writes run in a transaction that is rolled back, so the data never
// changes between runs. Queries built by Prisma are captured from Prisma's own query log rather than
// rewritten by hand, so the plan is for exactly the SQL the app sends. Run: pnpm perf:explain

const RUNS = 7;
const db = await perfClient([{ emit: 'event', level: 'query' }]);
let captured: { query: string; params: unknown[] }[] = [];
(
  db as unknown as { $on: (e: 'query', cb: (e: { query: string; params: string }) => void) => void }
).$on('query', (e) => captured.push({ query: e.query, params: JSON.parse(e.params) as unknown[] }));

/** The SQL a Prisma call sends (it may send several statements, e.g. one per relation). */
async function sqlOf(call: () => Promise<unknown>) {
  captured = [];
  await call();
  return captured.filter((c) => !/^(BEGIN|COMMIT|ROLLBACK)/.test(c.query));
}

class Rollback extends Error {}

async function explainOnce(sql: string, params: unknown[], write: boolean) {
  let plan: string[] = [];
  const run = async (q: typeof db | Parameters<Parameters<typeof db.$transaction>[0]>[0]) => {
    const rows = await q.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
      ...params,
    );
    plan = rows.map((r) => r['QUERY PLAN']);
  };
  if (!write) await run(db);
  else {
    await db
      .$transaction(async (tx) => {
        await run(tx);
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
  }
  return plan;
}

async function measure(
  name: string,
  statements: { query: string; params: unknown[] }[],
  write = false,
) {
  console.log(`\n=== ${name}`);
  for (const { query, params } of statements) {
    const times: number[] = [];
    let plan: string[] = [];
    await explainOnce(query, params, write);
    for (let i = 0; i < RUNS; i++) {
      plan = await explainOnce(query, params, write);
      times.push(Number(/Execution Time: ([\d.]+)/.exec(plan.join('\n'))?.[1]));
    }
    times.sort((a, b) => a - b);
    console.log(`--- ${query.replace(/\s+/g, ' ').slice(0, 220)}`);
    console.log(
      `median ${times[RUNS >> 1]!.toFixed(3)} ms (min ${times[0]!.toFixed(3)}, max ${times.at(-1)!.toFixed(3)}), ${RUNS} runs`,
    );
    console.log(plan.join('\n'));
  }
}

const raw = (query: string, ...params: unknown[]) => [{ query, params }];

// Sample rows, chosen by name so every seeded copy picks the same ones: the event with the most
// tickets, the closed event with the most (for check-ins), its first buyer, the buyer with the most tickets, and one of the event's unused tickets.
const [sample] = await db.$queryRaw<
  {
    event_id: string;
    closed_id: string;
    tier_id: string;
    buyer: string;
    heavy: string;
    ticket: string;
  }[]
>`
  WITH big AS (SELECT o.event_id FROM tickets t JOIN orders o ON o.id = t.order_id
               JOIN events e ON e.id = o.event_id
               GROUP BY o.event_id, e.slug ORDER BY count(*) DESC, e.slug LIMIT 1)
  SELECT big.event_id,
         (SELECT o.event_id FROM tickets t JOIN orders o ON o.id = t.order_id
          JOIN events e ON e.id = o.event_id WHERE e.status = 'CLOSED'
          GROUP BY o.event_id, e.slug ORDER BY count(*) DESC, e.slug LIMIT 1) AS closed_id,
         (SELECT id FROM ticket_tiers WHERE event_id = big.event_id ORDER BY name LIMIT 1) AS tier_id,
         (SELECT o.user_id FROM orders o JOIN users u ON u.id = o.user_id
          WHERE o.event_id = big.event_id ORDER BY u.email LIMIT 1) AS buyer,
         (SELECT t.owner_user_id FROM tickets t JOIN users u ON u.id = t.owner_user_id
          GROUP BY 1, u.email ORDER BY count(*) DESC, u.email LIMIT 1) AS heavy,
         (SELECT t.id FROM tickets t JOIN orders o ON o.id = t.order_id
          WHERE o.event_id = big.event_id AND t.checked_in_at IS NULL ORDER BY t.code LIMIT 1) AS ticket
  FROM big`;
if (!sample) throw new Error('no data: run pnpm perf:seed first');
const [picked] = await db.$queryRaw<{ slug: string; tickets: number; heavy_tickets: number }[]>`
  SELECT (SELECT slug FROM events WHERE id = ${sample.event_id}::uuid) AS slug,
         (SELECT count(*)::int FROM tickets t JOIN orders o ON o.id = t.order_id
          WHERE o.event_id = ${sample.event_id}::uuid) AS tickets,
         (SELECT count(*)::int FROM tickets WHERE owner_user_id = ${sample.heavy}::uuid) AS heavy_tickets`;
console.log(
  `sample: ${picked!.slug} (${picked!.tickets} tickets); heaviest owner has ${picked!.heavy_tickets} tickets`,
);

const [info] = await db.$queryRaw<{ version: string }[]>`SELECT version()`;
console.log(info!.version);
const sizes = await db.$queryRaw<{ name: string; size: string }[]>`
  SELECT c.relname AS name, pg_size_pretty(pg_relation_size(c.oid)) AS size
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('orders', 'tickets', 'order_items', 'events', 'ticket_tiers')
     OR c.relname LIKE 'orders%idx' OR c.relname LIKE 'tickets%idx'
  ORDER BY c.relname`;
console.log(sizes.map((s) => `${s.name}: ${s.size}`).join('\n'));

// packages/db/src/booking.ts: findOverdueHolds (the sweeper, every minute)
await measure(
  'expiry sweeper',
  raw(`SELECT id FROM orders WHERE status = 'PENDING' AND expires_at <= now()
       ORDER BY expires_at LIMIT 500`),
);

// packages/db/src/booking.ts: reserveInTransaction step 3 (per-user limit) and step 4 (the UPDATE)
await measure(
  'booking: tickets this user already holds',
  raw(
    `SELECT t.id, t.name, t.per_user_limit,
            COALESCE((SELECT SUM(oi.qty) FROM order_items oi
                      JOIN orders o ON o.id = oi.order_id
                      WHERE oi.tier_id = t.id AND o.user_id = $1::uuid
                        AND o.status IN ('PENDING', 'PAID', 'TICKETED')), 0)::int AS held
     FROM ticket_tiers t
     WHERE t.event_id = $2::uuid AND t.id = ANY($3::uuid[])`,
    sample.buyer,
    sample.event_id,
    [sample.tier_id],
  ),
);
await measure(
  'booking: conditional UPDATE',
  raw(
    `UPDATE ticket_tiers SET sold_count = sold_count + 1, updated_at = now()
     WHERE id = $1::uuid AND sold_count + 1 <= capacity RETURNING price_paise`,
    sample.tier_id,
  ),
  true,
);

// packages/db/src/tickets.ts: checkInTicket
await measure(
  'check-in UPDATE',
  raw(
    `UPDATE tickets SET checked_in_at = now(), checked_in_by = $1::uuid, checked_in_scan_id = 'perf'
     WHERE id = $2::uuid AND qr_version = 1 AND checked_in_at IS NULL RETURNING checked_in_at`,
    sample.buyer,
    sample.ticket,
  ),
  true,
);

// apps/api/src/modules/tickets/repository.ts: findTicketsForOwner (same arguments)
await measure(
  'my tickets (heaviest owner)',
  await sqlOf(() =>
    db.ticket.findMany({
      where: { ownerUserId: sample.heavy },
      select: {
        id: true,
        code: true,
        seq: true,
        qrVersion: true,
        checkedInAt: true,
        createdAt: true,
        orderId: true,
        ownerUserId: true,
        tier: { select: { id: true, name: true } },
        order: {
          select: {
            event: { select: { id: true, title: true, slug: true, venue: true, startsAt: true } },
          },
        },
      },
      orderBy: [{ order: { event: { startsAt: 'asc' } } }, { orderId: 'asc' }, { seq: 'asc' }],
    }),
  ),
);

// apps/api/src/modules/events/repository.ts: listEvents for GET /events (first page, limit 48)
await measure(
  'public event listing',
  await sqlOf(() =>
    db.event.findMany({
      where: { AND: [{ status: 'PUBLISHED', endsAt: { gt: new Date() } }, {}] },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: 49,
      select: {
        id: true,
        orgId: true,
        title: true,
        slug: true,
        venue: true,
        startsAt: true,
        endsAt: true,
        saleStartsAt: true,
        saleEndsAt: true,
        status: true,
        bannerKey: true,
        org: { select: { name: true, slug: true } },
        tiers: { select: { capacity: true, soldCount: true } },
      },
    }),
  ),
);

// packages/db/src/tickets.ts: listTicketsForGate and countCheckins (scanner manifest, live counter)
await measure(
  "gate: an event's tickets",
  await sqlOf(() =>
    db.ticket.findMany({
      where: { eventId: sample.event_id },
      select: { id: true, qrVersion: true, checkedInAt: true },
    }),
  ),
);
for (const [label, eventId] of [
  ['live counter: checked in (upcoming event, none yet)', sample.event_id],
  ['live counter: checked in (past event, most checked in)', sample.closed_id],
] as const) {
  await measure(
    label,
    await sqlOf(() => db.ticket.count({ where: { eventId, checkedInAt: { not: null } } })),
  );
}

// packages/db/src/analytics.ts: the organizer's sales dashboard (largest event)
await measure('analytics: sales per tier', await sqlOf(() => tierSales(sample.event_id, db)));
await measure('analytics: sales per day', await sqlOf(() => salesByDay(sample.event_id, db)));

await db.$disconnect();
