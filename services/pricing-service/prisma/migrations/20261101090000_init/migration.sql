-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ZoneKind" AS ENUM ('SERVICE_AREA', 'NO_PICKUP', 'AIRPORT', 'SURGE');

-- CreateEnum
CREATE TYPE "FareChangeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PromoType" AS ENUM ('PERCENT_OFF', 'AMOUNT_OFF');

-- CreateEnum
CREATE TYPE "PromoStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'EXHAUSTED', 'EXPIRED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('HELD', 'BOOKED', 'REDEEMED', 'RELEASED', 'EXPIRED');

-- CreateTable
CREATE TABLE "zone" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "city_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ZoneKind" NOT NULL,
    "polygon" JSONB NOT NULL,
    "fee_minor" INTEGER NOT NULL DEFAULT 0,
    "surge_multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fare_change_request" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "city_id" TEXT NOT NULL,
    "vehicle_type" TEXT NOT NULL,
    "base_minor" INTEGER NOT NULL,
    "per_km_minor" INTEGER NOT NULL,
    "per_min_minor" INTEGER NOT NULL,
    "min_fare_minor" INTEGER NOT NULL,
    "waiting_per_min_minor" INTEGER NOT NULL,
    "valid_from" TIMESTAMPTZ,
    "emergency" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "impact" JSONB NOT NULL,
    "status" "FareChangeStatus" NOT NULL DEFAULT 'PENDING',
    "maker_id" UUID NOT NULL,
    "checker_id" UUID,
    "decision_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "fare_change_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fare_rule" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "city_id" TEXT NOT NULL,
    "vehicle_type" TEXT NOT NULL,
    "base_minor" INTEGER NOT NULL,
    "per_km_minor" INTEGER NOT NULL,
    "per_min_minor" INTEGER NOT NULL,
    "min_fare_minor" INTEGER NOT NULL,
    "waiting_per_min_minor" INTEGER NOT NULL,
    "valid_from" TIMESTAMPTZ NOT NULL,
    "change_request_id" UUID NOT NULL,
    "proposed_by" UUID NOT NULL,
    "approved_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMPTZ,

    CONSTRAINT "fare_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "PromoType" NOT NULL,
    "percent_off" INTEGER,
    "amount_off_minor" INTEGER,
    "max_discount_minor" INTEGER,
    "city_ids" TEXT[],
    "vehicle_types" TEXT[],
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ NOT NULL,
    "per_user_limit" INTEGER NOT NULL DEFAULT 1,
    "max_redemptions" INTEGER,
    "budget_minor" INTEGER NOT NULL,
    "spent_minor" INTEGER NOT NULL DEFAULT 0,
    "redemption_count" INTEGER NOT NULL DEFAULT 0,
    "funded_by" TEXT NOT NULL DEFAULT 'PLATFORM',
    "status" "PromoStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by" UUID NOT NULL,
    "activated_by" UUID,
    "activated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_reservation" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "promo_id" UUID NOT NULL,
    "quote_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "city_id" TEXT NOT NULL,
    "vehicle_type" TEXT NOT NULL,
    "fare_minor" INTEGER NOT NULL,
    "discount_minor" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'HELD',
    "trip_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "booked_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "promo_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_redemption" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "promo_id" UUID NOT NULL,
    "reservation_id" UUID,
    "trip_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "city_id" TEXT NOT NULL,
    "fare_minor" INTEGER NOT NULL,
    "discount_minor" INTEGER NOT NULL,
    "redeemed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_redemption_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "zone_city_id_idx" ON "zone"("city_id");

-- CreateIndex
CREATE INDEX "fare_change_request_city_id_created_at_idx" ON "fare_change_request"("city_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "fare_change_request_status_expires_at_idx" ON "fare_change_request"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "fare_rule_change_request_id_key" ON "fare_rule"("change_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_fare_rule_version" ON "fare_rule"("city_id", "vehicle_type", "valid_from");

-- CreateIndex
CREATE UNIQUE INDEX "promo_code_key" ON "promo"("code");

-- CreateIndex
CREATE INDEX "promo_status_idx" ON "promo"("status");

-- CreateIndex
CREATE UNIQUE INDEX "promo_reservation_quote_id_key" ON "promo_reservation"("quote_id");

-- CreateIndex
CREATE INDEX "promo_reservation_promo_id_status_idx" ON "promo_reservation"("promo_id", "status");

-- CreateIndex
CREATE INDEX "promo_reservation_user_id_status_created_at_idx" ON "promo_reservation"("user_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "promo_redemption_reservation_id_key" ON "promo_redemption"("reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "promo_redemption_trip_id_key" ON "promo_redemption"("trip_id");

-- CreateIndex
CREATE INDEX "promo_redemption_promo_id_redeemed_at_idx" ON "promo_redemption"("promo_id", "redeemed_at" DESC);

-- AddForeignKey
ALTER TABLE "fare_rule" ADD CONSTRAINT "fare_rule_change_request_id_fkey" FOREIGN KEY ("change_request_id") REFERENCES "fare_change_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_reservation" ADD CONSTRAINT "promo_reservation_promo_id_fkey" FOREIGN KEY ("promo_id") REFERENCES "promo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_redemption" ADD CONSTRAINT "promo_redemption_promo_id_fkey" FOREIGN KEY ("promo_id") REFERENCES "promo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── constraints Prisma can't declare ──────────────────────────────────────────

ALTER TABLE "zone" ADD CONSTRAINT ck_zone_fee CHECK (fee_minor >= 0 AND fee_minor <= 1000000);
ALTER TABLE "zone" ADD CONSTRAINT ck_zone_surge CHECK (surge_multiplier >= 1 AND surge_multiplier <= 3);
ALTER TABLE "zone" ADD CONSTRAINT ck_zone_polygon CHECK (jsonb_typeof(polygon) = 'array' AND jsonb_array_length(polygon) BETWEEN 4 AND 500);
CREATE INDEX ix_zone_live ON "zone" (city_id) WHERE archived_at IS NULL;

ALTER TABLE "fare_change_request" ADD CONSTRAINT ck_fare_change_card CHECK (
  base_minor >= 0 AND per_km_minor >= 0 AND per_min_minor >= 0 AND min_fare_minor >= 0 AND waiting_per_min_minor >= 0
  AND base_minor <= 1000000 AND per_km_minor <= 1000000 AND per_min_minor <= 1000000 AND min_fare_minor <= 1000000 AND waiting_per_min_minor <= 1000000);
ALTER TABLE "fare_change_request" ADD CONSTRAINT ck_fare_change_valid_from CHECK (emergency OR valid_from IS NOT NULL);
ALTER TABLE "fare_change_request" ADD CONSTRAINT ck_fare_change_decided CHECK ((status = 'PENDING') = (decided_at IS NULL));
-- one open proposal per city and vehicle type
CREATE UNIQUE INDEX ux_fare_change_pending ON "fare_change_request" (city_id, vehicle_type) WHERE status = 'PENDING';

ALTER TABLE "fare_rule" ADD CONSTRAINT ck_fare_rule_card CHECK (
  base_minor >= 0 AND per_km_minor >= 0 AND per_min_minor >= 0 AND min_fare_minor >= 0 AND waiting_per_min_minor >= 0);
CREATE INDEX ix_fare_rule_pending_activation ON "fare_rule" (valid_from) WHERE activated_at IS NULL;

ALTER TABLE "promo" ADD CONSTRAINT ck_promo_code CHECK (code ~ '^[A-Z0-9_-]{3,32}$');
ALTER TABLE "promo" ADD CONSTRAINT ck_promo_value CHECK (
  (type = 'PERCENT_OFF' AND percent_off BETWEEN 1 AND 100 AND amount_off_minor IS NULL)
  OR (type = 'AMOUNT_OFF' AND amount_off_minor > 0 AND percent_off IS NULL));
ALTER TABLE "promo" ADD CONSTRAINT ck_promo_window CHECK (ends_at > starts_at);
ALTER TABLE "promo" ADD CONSTRAINT ck_promo_limits CHECK (
  per_user_limit >= 1 AND (max_redemptions IS NULL OR max_redemptions >= 1) AND budget_minor > 0
  AND spent_minor >= 0 AND redemption_count >= 0 AND (max_discount_minor IS NULL OR max_discount_minor > 0));

ALTER TABLE "promo_reservation" ADD CONSTRAINT ck_reservation_amounts CHECK (discount_minor > 0 AND discount_minor <= fare_minor);
CREATE INDEX ix_reservation_open ON "promo_reservation" (expires_at) WHERE status IN ('HELD', 'BOOKED');

ALTER TABLE "promo_redemption" ADD CONSTRAINT ck_redemption_amounts CHECK (discount_minor >= 0 AND discount_minor <= fare_minor);

CREATE INDEX ix_outbox_unpublished ON "outbox" (created_at) WHERE published_at IS NULL;
