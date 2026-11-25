-- Indexes chosen from EXPLAIN (ANALYZE, BUFFERS) on the festpass_perf dataset (pnpm perf:seed, pnpm perf:explain).

-- The sweeper only ever looks for PENDING orders, so only those are indexed: a few hundred rows at any
-- moment instead of every order ever placed. Nothing else used the old (status, expires_at) index.
DROP INDEX "orders_status_expires_at_idx";
CREATE INDEX "orders_pending_expires_at_idx" ON "orders"("expires_at") WHERE (status = 'PENDING');

-- tickets.event_id, copied from the order, so "this event's tickets" (scanner list, live counter) is
-- one index range instead of a join through orders that read every ticket. Added nullable, filled from
-- each ticket's order, then made NOT NULL, so existing tickets keep working.
ALTER TABLE "tickets" ADD COLUMN "event_id" UUID;
UPDATE "tickets" t SET "event_id" = o."event_id" FROM "orders" o WHERE o."id" = t."order_id";
ALTER TABLE "tickets" ALTER COLUMN "event_id" SET NOT NULL;
CREATE INDEX "tickets_event_id_checked_in_at_idx" ON "tickets"("event_id", "checked_in_at");

-- The foreign key covers (order_id, event_id), so a ticket's event can never differ from its order's:
-- a ticket for the wrong event would open the wrong gate. It needs a unique key on the same pair.
CREATE UNIQUE INDEX "orders_id_event_id_key" ON "orders"("id", "event_id");
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_order_id_fkey";
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_order_id_event_id_fkey" FOREIGN KEY ("order_id", "event_id") REFERENCES "orders"("id", "event_id") ON DELETE RESTRICT ON UPDATE CASCADE;
