-- CreateIndex
CREATE INDEX "events_status_starts_at_id_idx" ON "events"("status", "starts_at", "id");
