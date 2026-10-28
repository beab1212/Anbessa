-- Security fixes.
-- 1. Payout method changes: when it last changed. Payout batches hold a balance whose method changed
--    less than PAYOUT_METHOD_COOLOFF_HOURS ago (line status HELD, paid by a later run), and the owner
--    is told (payout_method.changed).
ALTER TABLE "beneficiary" ADD COLUMN "payout_method_changed_at" TIMESTAMPTZ;
ALTER TABLE "payout_line" DROP CONSTRAINT ck_payout_line_status;
ALTER TABLE "payout_line" ADD CONSTRAINT ck_payout_line_status CHECK (status IN ('PENDING','SENT','SUCCEEDED','FAILED','SKIPPED','HELD'));

-- 2. Trip events cross-checked against trip-service: an event that disagrees with trip-service's
--    record is not posted; it is kept here for finance.
CREATE TABLE "trip_event_anomaly" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "event_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "trip_id" UUID NOT NULL,
    "mismatches" JSONB NOT NULL,
    "event" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_event_anomaly_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "trip_event_anomaly_event_id_key" ON "trip_event_anomaly"("event_id");
CREATE INDEX "trip_event_anomaly_created_at_idx" ON "trip_event_anomaly"("created_at" DESC);
CREATE INDEX "trip_event_anomaly_trip_id_idx" ON "trip_event_anomaly"("trip_id");

-- 3. Refunds never exceed the payment (requests and approvals lock the payment row; this is the
--    last line). NOT VALID: an older row doesn't block the migration, every new write is checked.
ALTER TABLE "payment" ADD CONSTRAINT ck_payment_refunded_within_amount CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor) NOT VALID;
