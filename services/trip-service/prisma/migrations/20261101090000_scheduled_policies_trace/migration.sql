-- Phase 2C: scheduled rides (workflow 12), corporate ride policies (workflow 11), the GPS trace of
-- a trip (workflows 06 / 14) and the safety incidents counted in the regulatory report.

-- the trip purpose / cost centre a company may require (workflow 11 step 8)
ALTER TABLE "trip" ADD COLUMN "purpose" TEXT;

-- ── scheduled rides ──────────────────────────────────────────────────────────
-- A booking ahead. It isn't a trip yet: at match_at the scheduler creates the real trip
-- (status requested) and links it in trip_id. Until then it can be edited or cancelled for free.
CREATE TABLE "scheduled_trip" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "city_id" TEXT NOT NULL,
    "rider_user_id" UUID NOT NULL,
    "booked_by_user_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "billing_type" TEXT NOT NULL,
    "billing_org_id" UUID,
    "payment_method" TEXT NOT NULL,
    "vehicle_type" TEXT NOT NULL,
    "purpose" TEXT,
    "quote_id" TEXT NOT NULL,
    "pickup_lat" DOUBLE PRECISION NOT NULL,
    "pickup_lng" DOUBLE PRECISION NOT NULL,
    "dropoff_lat" DOUBLE PRECISION NOT NULL,
    "dropoff_lng" DOUBLE PRECISION NOT NULL,
    "pickup_address" TEXT,
    "dropoff_address" TEXT,
    "fare_estimate_minor" BIGINT NOT NULL,
    "waiting_per_min_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'ETB',
    "est_distance_m" INTEGER NOT NULL,
    "est_duration_s" INTEGER NOT NULL,
    "route_polyline" TEXT,
    "scheduled_for" TIMESTAMPTZ NOT NULL,
    "match_at" TIMESTAMPTZ NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "trip_id" UUID,
    "claimed_at" TIMESTAMPTZ,
    "dispatched_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "cancelled_by_user_id" UUID,
    "fail_reason" TEXT,
    "escalated_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_trip_pkey" PRIMARY KEY ("id"),
    CONSTRAINT ck_scheduled_trip_status CHECK (status IN ('SCHEDULED','DISPATCHING','DISPATCHED','CANCELLED','FAILED')),
    CONSTRAINT ck_scheduled_trip_match_at CHECK (match_at <= scheduled_for)
);

CREATE UNIQUE INDEX "scheduled_trip_trip_id_key" ON "scheduled_trip"("trip_id");
-- the scheduler's queue: due bookings, and claims a crashed instance left behind
CREATE INDEX ix_scheduled_trip_due ON "scheduled_trip" (match_at) WHERE status IN ('SCHEDULED','DISPATCHING');
CREATE INDEX ix_scheduled_trip_rider ON "scheduled_trip" (rider_user_id, scheduled_for);
CREATE INDEX ix_scheduled_trip_booker ON "scheduled_trip" (booked_by_user_id, scheduled_for);
CREATE INDEX ix_scheduled_trip_org ON "scheduled_trip" (billing_org_id, scheduled_for) WHERE billing_org_id IS NOT NULL;
CREATE INDEX ix_scheduled_trip_city ON "scheduled_trip" (city_id, scheduled_for);

ALTER TABLE "scheduled_trip" ADD CONSTRAINT "scheduled_trip_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── corporate ride policies ──────────────────────────────────────────────────
-- One row per company (auth-service organisation id). Checked when a trip billed to the company
-- is requested or scheduled. Empty arrays / nulls mean "no limit".
CREATE TABLE "corporate_policy" (
    "org_id" UUID NOT NULL,
    "allowed_vehicle_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "allowed_days" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "start_minute" INTEGER,
    "end_minute" INTEGER,
    "max_fare_minor" BIGINT,
    "monthly_budget_minor" BIGINT,
    "require_purpose" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "corporate_policy_pkey" PRIMARY KEY ("org_id"),
    CONSTRAINT ck_corporate_policy_minutes CHECK (
      (start_minute IS NULL AND end_minute IS NULL)
      OR (start_minute BETWEEN 0 AND 1439 AND end_minute BETWEEN 1 AND 1440 AND start_minute <> end_minute)),
    CONSTRAINT ck_corporate_policy_days CHECK (allowed_days <@ ARRAY[0,1,2,3,4,5,6]),
    CONSTRAINT ck_corporate_policy_money CHECK ((max_fare_minor IS NULL OR max_fare_minor > 0) AND (monthly_budget_minor IS NULL OR monthly_budget_minor > 0))
);

-- the monthly budget sums the company's trips by request time
CREATE INDEX ix_trip_billing_org_recent ON "trip" (billing_org_id, created_at DESC) WHERE billing_org_id IS NOT NULL;

-- ── GPS trace ────────────────────────────────────────────────────────────────
-- Thinned driver pings for a trip (from driver.location, matched → completed), ~1 point per 5 s
-- or 20 m. Read by safety/dispatch (trip:read_gps_trace) and used for the actual distance.
CREATE TABLE "trip_trace" (
    "trip_id" UUID NOT NULL,
    "at" TIMESTAMPTZ NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "speed" REAL,
    "accuracy" REAL,
    "status" TEXT NOT NULL,

    CONSTRAINT "trip_trace_pkey" PRIMARY KEY ("trip_id", "at")
);

ALTER TABLE "trip_trace" ADD CONSTRAINT "trip_trace_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── safety incidents for the regulatory report ───────────────────────────────
-- A copy of support-service's incident.opened events (no PII: ids, city, category, severity).
CREATE TABLE "regulatory_incident" (
    "incident_id" UUID NOT NULL,
    "city_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "trip_id" UUID,
    "opened_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "regulatory_incident_pkey" PRIMARY KEY ("incident_id")
);

CREATE INDEX ix_regulatory_incident_city_opened ON "regulatory_incident" (city_id, opened_at);
