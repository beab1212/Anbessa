-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "driver_profile" (
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "status_reason" TEXT,
    "review_note" TEXT,
    "full_name" TEXT NOT NULL,
    "license_number" BYTEA NOT NULL,
    "license_hash" BYTEA NOT NULL,
    "license_last4" TEXT NOT NULL,
    "city_id" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ,
    "activated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "driver_profile_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "vehicle" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "plate_number" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_user_id" UUID,
    "owner_org_id" UUID,
    "vehicle_type" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "color" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "status_reason" TEXT,
    "review_note" TEXT,
    "city_id" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ,
    "verified_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_authorization" (
    "vehicle_id" UUID NOT NULL,
    "driver_user_id" UUID NOT NULL,
    "granted_by" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "valid_until" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "vehicle_authorization_pkey" PRIMARY KEY ("vehicle_id","driver_user_id")
);

-- CreateTable
CREATE TABLE "driving_session" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "driver_user_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,
    "end_reason" TEXT,

    CONSTRAINT "driving_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" BYTEA NOT NULL,
    "expires_at" DATE,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reject_reason" TEXT,
    "city_id" TEXT NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "driver_profile_license_hash_key" ON "driver_profile"("license_hash");

-- CreateIndex
CREATE INDEX "driver_profile_city_id_status_idx" ON "driver_profile"("city_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_plate_number_key" ON "vehicle"("plate_number");

-- CreateIndex
CREATE INDEX "vehicle_city_id_status_idx" ON "vehicle"("city_id", "status");

-- CreateIndex
CREATE INDEX "vehicle_authorization_driver_user_id_idx" ON "vehicle_authorization"("driver_user_id");

-- CreateIndex
CREATE INDEX "driving_session_driver_user_id_started_at_idx" ON "driving_session"("driver_user_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "document_subject_type_subject_id_idx" ON "document"("subject_type", "subject_id");

-- AddForeignKey
ALTER TABLE "vehicle_authorization" ADD CONSTRAINT "vehicle_authorization_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driving_session" ADD CONSTRAINT "driving_session_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Constraints Prisma can't express (Role.md §14, Database.md §7.2) ──────────

ALTER TABLE "driver_profile"
  ADD CONSTRAINT ck_driver_status CHECK (status IN ('APPLIED','PENDING_REVIEW','ACTIVE','SUSPENDED'));

ALTER TABLE "vehicle"
  ADD CONSTRAINT ck_vehicle_status CHECK (status IN ('DRAFT','PENDING_REVIEW','VERIFIED','REJECTED','SUSPENDED','RETIRED')),
  ADD CONSTRAINT ck_vehicle_seats CHECK (seats BETWEEN 1 AND 20),
  -- rule V1: exactly one owner
  ADD CONSTRAINT ck_vehicle_single_owner CHECK (
       (owner_type = 'INDIVIDUAL'   AND owner_user_id IS NOT NULL AND owner_org_id IS NULL)
    OR (owner_type = 'ORGANIZATION' AND owner_org_id  IS NOT NULL AND owner_user_id IS NULL));
CREATE INDEX ix_vehicle_owner_user ON "vehicle" (owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX ix_vehicle_owner_org  ON "vehicle" (owner_org_id)  WHERE owner_org_id  IS NOT NULL;

ALTER TABLE "vehicle_authorization"
  ADD CONSTRAINT ck_authorization_status CHECK (status IN ('ACTIVE','REVOKED'));

-- rules V4 and V5: one open session per vehicle and per driver
CREATE UNIQUE INDEX ux_session_vehicle_active ON "driving_session" (vehicle_id)     WHERE ended_at IS NULL;
CREATE UNIQUE INDEX ux_session_driver_active  ON "driving_session" (driver_user_id) WHERE ended_at IS NULL;

ALTER TABLE "document"
  ADD CONSTRAINT ck_document_subject CHECK (subject_type IN ('DRIVER','VEHICLE','ORGANIZATION')),
  ADD CONSTRAINT ck_document_status CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','SUPERSEDED'));
CREATE INDEX ix_document_review   ON "document" (city_id, created_at) WHERE status = 'PENDING';   -- onboarding queue
CREATE INDEX ix_document_expiring ON "document" (expires_at) WHERE status = 'APPROVED';         -- expiry job

ALTER TABLE "idempotency_key"
  ADD CONSTRAINT ck_idempotency_status CHECK (status IN ('IN_PROGRESS','DONE'));

CREATE INDEX ix_outbox_unpublished ON "outbox" (created_at) WHERE published_at IS NULL;
