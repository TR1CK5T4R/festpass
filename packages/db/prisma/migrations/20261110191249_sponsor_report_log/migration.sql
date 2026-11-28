-- CreateTable
CREATE TABLE "sponsor_report_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sponsor_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "claimed_at" TIMESTAMPTZ,
    "sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sponsor_report_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sponsor_report_log_sponsor_id_user_id_key" ON "sponsor_report_log"("sponsor_id", "user_id");

-- AddForeignKey
ALTER TABLE "sponsor_report_log" ADD CONSTRAINT "sponsor_report_log_sponsor_id_fkey" FOREIGN KEY ("sponsor_id") REFERENCES "sponsors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsor_report_log" ADD CONSTRAINT "sponsor_report_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

