import type { SalesDay, TierSales } from '@festpass/shared';
import { prisma, type PrismaClient } from './index.js';

// Sales numbers for the organizer dashboard, computed in Postgres: only totals cross the wire, never the
// orders themselves. Revenue counts paid orders (PAID or TICKETED), at the price each ticket was sold for.
// The client can be passed in, so pnpm perf:explain can measure exactly this SQL on festpass_perf.

type Db = Pick<PrismaClient, '$queryRaw'>;

export async function tierSales(eventId: string, db: Db = prisma): Promise<TierSales[]> {
  const rows = await db.$queryRaw<
    {
      tierId: string;
      name: string;
      capacity: number;
      paid: number;
      held: number;
      revenue: bigint;
    }[]
  >`
    SELECT t.id AS "tierId", t.name, t.capacity,
           COALESCE(SUM(oi.qty) FILTER (WHERE o.status IN ('PAID', 'TICKETED')), 0)::int AS paid,
           COALESCE(SUM(oi.qty) FILTER (WHERE o.status = 'PENDING'), 0)::int AS held,
           COALESCE(SUM(oi.qty * oi.unit_price_paise) FILTER (WHERE o.status IN ('PAID', 'TICKETED')), 0)::bigint AS revenue
    FROM ticket_tiers t
    LEFT JOIN order_items oi ON oi.tier_id = t.id
    LEFT JOIN orders o ON o.id = oi.order_id
    WHERE t.event_id = ${eventId}::uuid
    GROUP BY t.id
    ORDER BY t.price_paise, t.name`;
  // bigint because SUM over many orders can pass 2^31 paise (₹2.1 crore); a JS number is exact far beyond.
  return rows.map(({ revenue, ...t }) => ({ ...t, revenuePaise: Number(revenue) }));
}

/**
 * Paid tickets and revenue per day, by the order's booking day in India time. generate_series fills
 * the days with no sales, so a chart doesn't draw a quiet day as if it never happened.
 */
export async function salesByDay(eventId: string, db: Db = prisma): Promise<SalesDay[]> {
  const rows = await db.$queryRaw<{ day: string; tickets: number; revenue: bigint }[]>`
    WITH paid AS (
      SELECT date_trunc('day', o.created_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
             SUM(oi.qty) AS tickets, SUM(oi.qty * oi.unit_price_paise) AS revenue
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.event_id = ${eventId}::uuid AND o.status IN ('PAID', 'TICKETED')
      GROUP BY 1
    )
    SELECT to_char(d, 'YYYY-MM-DD') AS day,
           COALESCE(p.tickets, 0)::int AS tickets, COALESCE(p.revenue, 0)::bigint AS revenue
    FROM (SELECT min(day) AS first, max(day) AS last FROM paid) span
    CROSS JOIN generate_series(span.first, span.last, interval '1 day') d
    LEFT JOIN paid p ON p.day = d::date
    ORDER BY d`;
  return rows.map(({ revenue, ...d }) => ({ ...d, revenuePaise: Number(revenue) }));
}
