import { preparePerfDatabase, perfClient } from './perf-db.js';

// A realistic amount of data for query plans: with a few demo rows Postgres reads whole tables because
// that's cheapest, so plans only show which index matters once the tables are big.
//
//   10 clubs, 50 events (40 published, 5 closed in the past, 5 drafts), 3 tiers each,
//   30,000 users, ~40,000 ticketed orders (1–4 tickets) = ~100,000 tickets,
//   15,000 expired, 3,000 cancelled and 300 pending orders (100 of them overdue for the sweeper).
//
// Everything is generated in SQL with generate_series, so it takes seconds. setseed() and ordering by
// names (never by the random UUIDs) make every run produce the same data, apart from IDs and dates. Run: pnpm perf:seed

const STEPS = [
  `TRUNCATE organizations, users, events, ticket_tiers, orders, order_items, tickets, payments,
     idempotency_keys, email_log, org_members, refresh_tokens RESTART IDENTITY CASCADE`,
  `SELECT setseed(0.23)`,
  `INSERT INTO organizations (name, slug)
   SELECT 'Club ' || g, 'perf-club-' || g FROM generate_series(1, 10) g`,
  `INSERT INTO users (email, password_hash, name, college)
   SELECT 'perf-user-' || g || '@example.com', 'x', 'Perf User ' || g, 'MAIT'
   FROM generate_series(1, 30000) g`,
  // Events 1–40 published and upcoming, 41–45 closed and in the past, 46–50 drafts.
  `INSERT INTO events (org_id, title, slug, description, venue, starts_at, ends_at,
                       sale_starts_at, sale_ends_at, status)
   SELECT o.id, 'Perf Fest ' || g, 'perf-fest-' || g, '', 'Auditorium',
          s, s + interval '6 hours', s - interval '30 days', s - interval '1 hour',
          (CASE WHEN g <= 40 THEN 'PUBLISHED' WHEN g <= 45 THEN 'CLOSED' ELSE 'DRAFT' END)::event_status
   FROM generate_series(1, 50) g
   CROSS JOIN LATERAL (SELECT now() + (CASE WHEN g BETWEEN 41 AND 45 THEN -g ELSE g END) * interval '1 day' AS s) t
   JOIN LATERAL (SELECT id FROM organizations ORDER BY slug OFFSET (g % 10) LIMIT 1) o ON true`,
  `INSERT INTO ticket_tiers (event_id, name, price_paise, capacity)
   SELECT e.id, t.name, t.price, 1000
   FROM events e
   CROSS JOIN (VALUES ('Early bird', 19900), ('Regular', 29900), ('VIP', 99900)) t(name, price)`,
  // One row per order to create, with its tier, buyer, size and status picked at random.
  `CREATE TEMP TABLE gen AS
   SELECT gen_random_uuid() AS id, tier.id AS tier_id, tier.event_id, tier.price_paise,
          u.id AS user_id, 1 + floor(random() * 4)::int AS qty, s.status, s.expires_at
   FROM (
     SELECT g, CASE WHEN g <= 40000 THEN 'TICKETED' WHEN g <= 55000 THEN 'EXPIRED'
                    WHEN g <= 58000 THEN 'CANCELLED' ELSE 'PENDING' END AS status,
            CASE WHEN g <= 58100 THEN now() - random() * interval '20 days'
                 ELSE now() + random() * interval '10 minutes' END AS expires_at,
            1 + floor(random() * 120)::int AS tier_n, 1 + floor(random() * 30000)::int AS user_n
     FROM generate_series(1, 58300) g
   ) s
   JOIN (SELECT t.*, row_number() OVER (ORDER BY e.slug, t.name) AS n FROM ticket_tiers t
         JOIN events e ON e.id = t.event_id WHERE e.status <> 'DRAFT') tier ON tier.n = s.tier_n
   JOIN (SELECT id, row_number() OVER (ORDER BY email) AS n FROM users) u ON u.n = s.user_n`,
  `INSERT INTO orders (id, user_id, event_id, status, amount_paise, expires_at, created_at)
   SELECT id, user_id, event_id, status::order_status, qty * price_paise, expires_at,
          expires_at - interval '10 minutes'
   FROM gen`,
  `INSERT INTO order_items (order_id, tier_id, qty, unit_price_paise)
   SELECT id, tier_id, qty, price_paise FROM gen`,
  // Codes are numbered rather than random, so 100k of them can never collide.
  `INSERT INTO tickets (order_id, event_id, tier_id, owner_user_id, seq, code, checked_in_at)
   SELECT g.id, g.event_id, g.tier_id, g.user_id, s, 'PERF-' || lpad((row_number() OVER ())::text, 7, '0'),
          CASE WHEN e.status = 'CLOSED' AND random() < 0.8 THEN e.starts_at END
   FROM gen g JOIN events e ON e.id = g.event_id
   CROSS JOIN generate_series(1, g.qty) s
   WHERE g.status = 'TICKETED'`,
  // What the booking engine would have counted: held and sold tickets.
  `UPDATE ticket_tiers t SET sold_count = c.sold
   FROM (SELECT tier_id, sum(qty) AS sold FROM gen WHERE status IN ('TICKETED', 'PENDING')
         GROUP BY tier_id) c
   WHERE c.tier_id = t.id`,
  // Fresh statistics, so the planner sees the new sizes (autovacuum would get there later).
  `ANALYZE`,
];

await preparePerfDatabase();
const db = await perfClient();
const started = Date.now();
await db.$transaction(
  async (tx) => {
    for (const step of STEPS) await tx.$executeRawUnsafe(step);
  },
  { timeout: 300_000 },
);
const counts = await db.$queryRaw<Record<string, bigint>[]>`
  SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM users) AS users,
         (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM tickets) AS tickets`;
console.log(
  `festpass_perf seeded in ${((Date.now() - started) / 1000).toFixed(1)} s:`,
  Object.fromEntries(Object.entries(counts[0]!).map(([k, v]) => [k, Number(v)])),
);
await db.$disconnect();
