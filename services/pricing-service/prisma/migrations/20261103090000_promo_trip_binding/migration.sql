-- A promo reservation is bound to exactly one trip (security fix): trip-service books a quote's
-- discount for the trip id it is about to create; redemption and release act only for that trip.
-- Reservations are looked up by trip id, so it gets an index.
CREATE INDEX "ix_reservation_trip" ON "promo_reservation"("trip_id");
-- at most one live (booked) reservation per trip
CREATE UNIQUE INDEX "ux_reservation_trip_booked" ON "promo_reservation"("trip_id") WHERE status = 'BOOKED';

-- Promo anomalies: a discount the books can't explain, recorded for finance instead of skipped.
CREATE TABLE "promo_anomaly" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "kind" TEXT NOT NULL,
    "trip_id" UUID NOT NULL,
    "promo_id" UUID,
    "quote_id" TEXT,
    "rider_id" UUID,
    "discount_minor" INTEGER NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_anomaly_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "promo_anomaly_trip_id_kind_key" ON "promo_anomaly"("trip_id", "kind");
CREATE INDEX "promo_anomaly_created_at_idx" ON "promo_anomaly"("created_at" DESC);
ALTER TABLE "promo_anomaly" ADD CONSTRAINT ck_promo_anomaly_kind CHECK (kind IN ('DISCOUNT_WITHOUT_RESERVATION', 'DISCOUNT_ABOVE_RESERVATION', 'OVER_BUDGET'));

-- spending never passes the budget (the consumer caps it and records OVER_BUDGET); NOT VALID so an
-- older row that already overspent doesn't block the migration, every new write is checked
ALTER TABLE "promo" ADD CONSTRAINT ck_promo_spent_within_budget CHECK (spent_minor <= budget_minor) NOT VALID;
