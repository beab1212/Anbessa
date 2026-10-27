-- Phase 2D: vehicle ownership transfer (rule V9, maker–checker) and the TRANSFERRED vehicle state reason.

CREATE TABLE "vehicle_transfer" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "vehicle_id" UUID NOT NULL,
    "city_id" TEXT NOT NULL,
    "from_owner_type" TEXT NOT NULL,
    "from_owner_id" UUID NOT NULL,
    "to_owner_type" TEXT NOT NULL,
    "to_owner_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requested_by" UUID,
    "maker_id" UUID,
    "checker_id" UUID,
    "decision_note" TEXT,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_transfer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vehicle_transfer_city_id_status_idx" ON "vehicle_transfer"("city_id", "status");
CREATE INDEX "vehicle_transfer_vehicle_id_created_at_idx" ON "vehicle_transfer"("vehicle_id", "created_at" DESC);

ALTER TABLE "vehicle_transfer" ADD CONSTRAINT "vehicle_transfer_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- hand-written
ALTER TABLE "vehicle_transfer"
  ADD CONSTRAINT ck_transfer_status CHECK (status IN ('REQUESTED','PENDING','EXECUTED','REJECTED','CANCELLED','EXPIRED')),
  ADD CONSTRAINT ck_transfer_owner_types CHECK (from_owner_type IN ('INDIVIDUAL','ORGANIZATION') AND to_owner_type IN ('INDIVIDUAL','ORGANIZATION')),
  ADD CONSTRAINT ck_transfer_new_owner CHECK (NOT (from_owner_type = to_owner_type AND from_owner_id = to_owner_id)),
  ADD CONSTRAINT ck_transfer_maker_checker CHECK (checker_id IS NULL OR maker_id IS NULL OR checker_id <> maker_id);
-- one open transfer per vehicle
CREATE UNIQUE INDEX ux_transfer_vehicle_open ON "vehicle_transfer" (vehicle_id) WHERE status IN ('REQUESTED','PENDING');
