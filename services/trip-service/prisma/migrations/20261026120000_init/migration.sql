CREATE EXTENSION IF NOT EXISTS postgis;


-- CreateTable
CREATE TABLE "trip" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "city_id" TEXT NOT NULL,
    "rider_user_id" UUID NOT NULL,
    "booked_by_user_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "billing_type" TEXT NOT NULL,
    "billing_org_id" UUID,
    "payment_method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "vehicle_type" TEXT NOT NULL,
    "quote_id" TEXT,
    "pickup_lat" DOUBLE PRECISION NOT NULL,
    "pickup_lng" DOUBLE PRECISION NOT NULL,
    "dropoff_lat" DOUBLE PRECISION NOT NULL,
    "dropoff_lng" DOUBLE PRECISION NOT NULL,
    "pickup" geography(Point,4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("pickup_lng", "pickup_lat"), 4326)::geography) STORED,
    "dropoff" geography(Point,4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("dropoff_lng", "dropoff_lat"), 4326)::geography) STORED,
    "pickup_address" TEXT,
    "dropoff_address" TEXT,
    "driver_user_id" UUID,
    "vehicle_id" TEXT,
    "vehicle_owner_type" TEXT,
    "beneficiary_id" UUID,
    "matched_at" TIMESTAMPTZ,
    "fare_estimate_minor" BIGINT NOT NULL,
    "waiting_per_min_minor" BIGINT NOT NULL DEFAULT 0,
    "fare_final_minor" BIGINT,
    "waiting_fee_minor" BIGINT,
    "currency" CHAR(3) NOT NULL DEFAULT 'ETB',
    "est_distance_m" INTEGER NOT NULL,
    "est_duration_s" INTEGER NOT NULL,
    "distance_m" INTEGER,
    "duration_s" INTEGER,
    "route_polyline" TEXT,
    "pin" CHAR(4) NOT NULL,
    "arrived_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "cancelled_by" TEXT,
    "cancelled_by_user_id" UUID,
    "cancel_reason" TEXT,
    "cancel_fee_minor" BIGINT,
    "driver_compensation_minor" BIGINT,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_pkey" PRIMARY KEY ("id")
) WITH (fillfactor = 85);

-- CreateTable
CREATE TABLE "driver_active_trip" (
    "driver_user_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "since" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_active_trip_pkey" PRIMARY KEY ("driver_user_id")
);

-- CreateTable
CREATE TABLE "trip_offer" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "trip_id" UUID NOT NULL,
    "driver_user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OFFERED',
    "eta_seconds" INTEGER,
    "distance_meters" INTEGER,
    "offered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "answered_at" TIMESTAMPTZ,

    CONSTRAINT "trip_offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_event" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "trip_id" UUID NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "actor_id" UUID,
    "data" JSONB,

    CONSTRAINT "trip_event_pkey" PRIMARY KEY ("at","id")
) PARTITION BY RANGE ("at");

-- CreateTable
CREATE TABLE "trip_rating" (
    "trip_id" UUID NOT NULL,
    "by_role" TEXT NOT NULL,
    "by_user_id" UUID NOT NULL,
    "stars" INTEGER NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_rating_pkey" PRIMARY KEY ("trip_id","by_role")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "user_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" BYTEA NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "status_code" INTEGER,
    "response" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("user_id","key")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "topic" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_trip_rider_recent" ON "trip"("rider_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_trip_booked_by_recent" ON "trip"("booked_by_user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "driver_active_trip_trip_id_key" ON "driver_active_trip"("trip_id");

-- CreateIndex
CREATE INDEX "trip_offer_trip_id_offered_at_idx" ON "trip_offer"("trip_id", "offered_at");

-- CreateIndex
CREATE INDEX "ix_trip_offer_driver_recent" ON "trip_offer"("driver_user_id", "offered_at" DESC);

-- CreateIndex
CREATE INDEX "ix_trip_event_trip" ON "trip_event"("trip_id", "at");

-- AddForeignKey
ALTER TABLE "driver_active_trip" ADD CONSTRAINT "driver_active_trip_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_offer" ADD CONSTRAINT "trip_offer_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_rating" ADD CONSTRAINT "trip_rating_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── constraints and indexes the Prisma schema can't express (Database.md §7.3, §9) ──

ALTER TABLE "trip"
  ADD CONSTRAINT ck_trip_status CHECK (status IN ('requested','matched','en_route','in_progress','completed','cancelled')),
  ADD CONSTRAINT ck_trip_channel CHECK (channel IN ('APP','PHONE','CORPORATE_PORTAL')),
  ADD CONSTRAINT ck_trip_billing_type CHECK (billing_type IN ('PERSONAL','CORPORATE')),
  ADD CONSTRAINT ck_corporate_billing CHECK ((billing_type = 'CORPORATE') = (billing_org_id IS NOT NULL)),
  ADD CONSTRAINT ck_trip_payment_method CHECK (payment_method IN ('CASH','MOBILE_MONEY','CARD','CORPORATE')),
  ADD CONSTRAINT ck_trip_corporate_payment CHECK ((payment_method = 'CORPORATE') = (billing_type = 'CORPORATE')),
  ADD CONSTRAINT ck_trip_vehicle_owner_type CHECK (vehicle_owner_type IS NULL OR vehicle_owner_type IN ('INDIVIDUAL','ORGANIZATION')),
  ADD CONSTRAINT ck_trip_cancelled_by CHECK (cancelled_by IS NULL OR cancelled_by IN ('RIDER','DRIVER','SYSTEM','STAFF')),
  ADD CONSTRAINT ck_trip_cancelled_consistent CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  ADD CONSTRAINT ck_trip_driver_when_matched CHECK (status IN ('requested','cancelled') OR driver_user_id IS NOT NULL),
  ADD CONSTRAINT ck_trip_money CHECK (fare_estimate_minor >= 0 AND coalesce(fare_final_minor, 0) >= 0 AND coalesce(cancel_fee_minor, 0) >= 0
                                      AND coalesce(driver_compensation_minor, 0) <= coalesce(cancel_fee_minor, 0)),
  ADD CONSTRAINT ck_trip_pin CHECK (pin ~ '^[0-9]{4}$'),
  ADD CONSTRAINT ck_trip_coordinates CHECK (abs(pickup_lat) <= 90 AND abs(dropoff_lat) <= 90 AND abs(pickup_lng) <= 180 AND abs(dropoff_lng) <= 180);

-- one active trip per rider (workflow 05, preconditions), enforced by the database
CREATE UNIQUE INDEX ux_trip_rider_active ON "trip" (rider_user_id)
  WHERE status IN ('requested','matched','en_route','in_progress');
CREATE INDEX ix_trip_driver_recent ON "trip" (driver_user_id, created_at DESC) WHERE driver_user_id IS NOT NULL;
-- dispatcher live board
CREATE INDEX ix_trip_city_active ON "trip" (city_id, status, created_at)
  WHERE status IN ('requested','matched','en_route','in_progress');
CREATE INDEX ix_trip_billing_org ON "trip" (billing_org_id, created_at) WHERE billing_org_id IS NOT NULL;
CREATE INDEX ix_trip_pickup_gix ON "trip" USING gist (pickup);

ALTER TABLE "trip_offer"
  ADD CONSTRAINT ck_trip_offer_status CHECK (status IN ('OFFERED','ACCEPTED','DECLINED','EXPIRED'));
-- at most one open offer per trip
CREATE UNIQUE INDEX ux_trip_offer_open ON "trip_offer" (trip_id) WHERE status = 'OFFERED';

ALTER TABLE "trip_rating"
  ADD CONSTRAINT ck_trip_rating_stars CHECK (stars BETWEEN 1 AND 5),
  ADD CONSTRAINT ck_trip_rating_role CHECK (by_role IN ('RIDER','DRIVER'));

ALTER TABLE "idempotency_key"
  ADD CONSTRAINT ck_idempotency_status CHECK (status IN ('IN_PROGRESS','DONE'));

CREATE INDEX ix_outbox_unpublished ON "outbox" (created_at) WHERE published_at IS NULL;

-- trip_event partitions: one per month, created ahead by ensure_trip_event_partitions()
-- (trip-service calls it at start-up and daily). The default partition catches anything else.
CREATE TABLE trip_event_default PARTITION OF "trip_event" DEFAULT;

CREATE OR REPLACE FUNCTION ensure_trip_event_partitions(months_ahead int DEFAULT 2) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  m date := date_trunc('month', now())::date;
  name text;
BEGIN
  FOR i IN 0..months_ahead LOOP
    name := format('trip_event_%s', to_char(m, 'YYYY_MM'));
    IF to_regclass(name) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF trip_event FOR VALUES FROM (%L) TO (%L)', name, m, (m + interval '1 month')::date);
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
END $$;

SELECT ensure_trip_event_partitions(2);
