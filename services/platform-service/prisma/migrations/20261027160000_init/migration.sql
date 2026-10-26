-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "setting_value" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "key" TEXT NOT NULL,
    "city_id" TEXT,
    "value" JSONB NOT NULL,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "setting_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setting_history" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "key" TEXT NOT NULL,
    "city_id" TEXT,
    "old_value" JSONB,
    "new_value" JSONB,
    "changed_by" UUID NOT NULL,
    "approved_by" UUID,
    "reason" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "setting_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setting_change" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "key" TEXT NOT NULL,
    "city_id" TEXT,
    "value" JSONB,
    "reason" TEXT NOT NULL,
    "maker_id" UUID NOT NULL,
    "checker_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decision_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "setting_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings_version" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "settings_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "city" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Addis_Ababa',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "min_lat" DOUBLE PRECISION NOT NULL,
    "min_lng" DOUBLE PRECISION NOT NULL,
    "max_lat" DOUBLE PRECISION NOT NULL,
    "max_lng" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "city_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_type" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "seats_min" INTEGER NOT NULL,
    "seats_max" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cities" TEXT[],
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_type_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "announcement" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "audiences" TEXT[],
    "cities" TEXT[],
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "setting_history_key_at_idx" ON "setting_history"("key", "at" DESC);

-- CreateIndex
CREATE INDEX "setting_change_status_created_at_idx" ON "setting_change"("status", "created_at");

-- CreateIndex
CREATE INDEX "announcement_archived_starts_at_idx" ON "announcement"("archived", "starts_at");


-- ── Constraints Prisma can't express ──────────────────────────────────────────
-- one value per setting globally and per city (NULLS NOT DISTINCT: one global row)
CREATE UNIQUE INDEX ux_setting_value_key_city ON "setting_value" (key, city_id) NULLS NOT DISTINCT;

ALTER TABLE "setting_change"
  ADD CONSTRAINT ck_setting_change_status CHECK (status IN ('PENDING','EXECUTED','REJECTED','EXPIRED','CANCELLED')),
  ADD CONSTRAINT ck_setting_change_maker_checker CHECK (checker_id IS NULL OR checker_id <> maker_id);

ALTER TABLE "settings_version" ADD CONSTRAINT ck_settings_version_single CHECK (id = 1);
INSERT INTO "settings_version" (id, version) VALUES (1, 0);

ALTER TABLE "city"
  ADD CONSTRAINT ck_city_id CHECK (id ~ '^[a-z0-9-]{1,40}$'),
  ADD CONSTRAINT ck_city_bbox CHECK (min_lat < max_lat AND min_lng < max_lng);

ALTER TABLE "vehicle_type"
  ADD CONSTRAINT ck_vehicle_type_code CHECK (code ~ '^[a-z0-9_]{1,30}$'),
  ADD CONSTRAINT ck_vehicle_type_seats CHECK (seats_min >= 1 AND seats_max >= seats_min AND seats_max <= 20);

ALTER TABLE "announcement"
  ADD CONSTRAINT ck_announcement_severity CHECK (severity IN ('info','warning')),
  ADD CONSTRAINT ck_announcement_window CHECK (ends_at IS NULL OR ends_at > starts_at);

CREATE INDEX ix_outbox_unpublished ON "outbox" (created_at) WHERE published_at IS NULL;
