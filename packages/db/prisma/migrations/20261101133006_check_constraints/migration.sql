-- CHECK constraints are the last line of defence: even if application code has a bug,
-- Postgres refuses to store an oversold tier, a negative price or an event that ends before it starts.
-- Prisma's schema language can't express these, so they live in this hand-written migration.

ALTER TABLE "ticket_tiers"
  ADD CONSTRAINT "ticket_tiers_sold_count_within_capacity" CHECK ("sold_count" >= 0 AND "sold_count" <= "capacity"),
  ADD CONSTRAINT "ticket_tiers_capacity_positive" CHECK ("capacity" > 0),
  ADD CONSTRAINT "ticket_tiers_price_paise_non_negative" CHECK ("price_paise" >= 0),
  ADD CONSTRAINT "ticket_tiers_per_user_limit_range" CHECK ("per_user_limit" BETWEEN 1 AND 10);

ALTER TABLE "events"
  ADD CONSTRAINT "events_ends_after_starts" CHECK ("ends_at" > "starts_at");

-- Same idea for the other money and quantity columns.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_amount_paise_non_negative" CHECK ("amount_paise" >= 0);

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_qty_positive" CHECK ("qty" > 0),
  ADD CONSTRAINT "order_items_unit_price_paise_non_negative" CHECK ("unit_price_paise" >= 0);
