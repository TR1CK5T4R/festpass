import { existsSync, readFileSync } from 'node:fs';
import { findInventoryProblems } from '../src/inventory.js';
import { perfClient } from './perf-db.js';

// After a load test (pnpm loadtest:verify): fails, with exit code 1, unless every tier in festpass_perf
// has sold_count equal to the tickets held by PENDING/PAID/TICKETED orders and never more than its
// capacity, and the sale's tier sold exactly what k6 saw booked. The SQL is findInventoryProblems(),
// which packages/db/test/verify-inventory.test.ts proves fails on an oversell.

const data = new URL('../../../infra/k6/.data/', import.meta.url);
const db = await perfClient();
let failed = false;

const problems = await findInventoryProblems(db);
const tiers = await db.ticketTier.count();
if (problems.length > 0) {
  failed = true;
  console.error(`FAIL: ${problems.length} of ${tiers} tiers don't add up:`);
  console.table(problems);
} else {
  console.log(`ok: all ${tiers} tiers have sold_count = tickets held, and none above capacity`);
}

if (existsSync(new URL('sale.json', data))) {
  const sale = JSON.parse(readFileSync(new URL('sale.json', data), 'utf8')) as {
    run: string;
    eventId: string;
    tierId: string;
    capacity: number;
  };
  const tier = await db.ticketTier.findUniqueOrThrow({ where: { id: sale.tierId } });
  const orders = await db.order.count({ where: { eventId: sale.eventId } });
  console.log(
    `sale tier: capacity ${tier.capacity}, sold ${tier.soldCount}, orders ${orders} (one ticket each)`,
  );
  if (orders !== tier.soldCount) failed = true;
  // Refusals Postgres made are stored under the Idempotency-Key; the gate's refusals never reach it.
  const [stored] = await db.$queryRaw<{ refused: number }[]>`
    SELECT count(*)::int AS refused FROM idempotency_keys k JOIN users u ON u.id = k.user_id
    WHERE u.email LIKE ${`load-${sale.run}-%`} AND k.status = 409`;
  console.log(`refused inside a Postgres transaction (stored 409s): ${stored?.refused ?? 0}`);

  const summaryFile = new URL('flash-summary.json', data);
  if (existsSync(summaryFile)) {
    const summary = JSON.parse(readFileSync(summaryFile, 'utf8')) as {
      metrics: Record<string, { values: { count?: number } } | undefined>;
    };
    const booked = summary.metrics.booked?.values.count ?? 0;
    console.log(`k6 saw ${booked} answers of 201 Created`);
    if (booked !== tier.soldCount) {
      failed = true;
      console.error(`FAIL: k6 saw ${booked} bookings but Postgres sold ${tier.soldCount}`);
    }
  }
}

await db.$disconnect();
if (failed) process.exit(1);
