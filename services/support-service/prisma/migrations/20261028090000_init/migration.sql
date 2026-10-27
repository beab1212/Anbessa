-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TicketCategory" AS ENUM ('SAFETY', 'PAYMENT', 'TRIP', 'LOST_ITEM', 'ACCOUNT', 'FEEDBACK');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('P1', 'P2', 'P3', 'P4');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_REQUESTER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketSource" AS ENUM ('APP', 'PHONE', 'STAFF', 'SYSTEM');

-- CreateEnum
CREATE TYPE "RequesterKind" AS ENUM ('RIDER', 'DRIVER', 'FLEET', 'CORPORATE');

-- CreateEnum
CREATE TYPE "Resolution" AS ENUM ('NO_ACTION', 'EXPLAINED', 'REFUND', 'ADJUSTMENT', 'DRIVER_WARNING', 'ESCALATE_SAFETY');

-- CreateEnum
CREATE TYPE "MessageAuthor" AS ENUM ('REQUESTER', 'STAFF', 'SYSTEM');

-- CreateEnum
CREATE TYPE "RefundLinkStatus" AS ENUM ('REQUESTED', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "LostItemStatus" AS ENUM ('REPORTED', 'FOUND', 'NOT_FOUND', 'RETURNED', 'CLOSED');

-- CreateEnum
CREATE TYPE "LostItemAuthor" AS ENUM ('RIDER', 'DRIVER', 'FLEET', 'STAFF');

-- CreateEnum
CREATE TYPE "SosStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "SosOutcome" AS ENUM ('FALSE_ALARM', 'ASSISTED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "SosRole" AS ENUM ('RIDER', 'DRIVER');

-- CreateEnum
CREATE TYPE "SosSource" AS ENUM ('APP', 'SYSTEM');

-- CreateEnum
CREATE TYPE "IncidentCategory" AS ENUM ('HARASSMENT', 'ASSAULT', 'ACCIDENT', 'DANGEROUS_DRIVING', 'THEFT', 'OTHER');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "IncidentSource" AS ENUM ('SOS', 'TICKET', 'MANUAL');

-- CreateEnum
CREATE TYPE "IncidentOutcome" AS ENUM ('CLEARED', 'WARNING', 'SUSPENDED_TEMPORARY', 'REMOVED_PERMANENTLY');

-- CreateEnum
CREATE TYPE "IncidentActionKind" AS ENUM ('WARNING', 'SUSPENDED', 'BANNED', 'REINSTATED', 'PAIR_BLOCK');

-- CreateTable
CREATE TABLE "ticket" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "ref" SERIAL NOT NULL,
    "city_id" TEXT NOT NULL,
    "category" "TicketCategory" NOT NULL,
    "priority" "Priority" NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "source" "TicketSource" NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "requester_user_id" UUID NOT NULL,
    "requester_kind" "RequesterKind" NOT NULL,
    "requester_org_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "trip_id" UUID,
    "assignee_user_id" UUID,
    "first_response_due_at" TIMESTAMPTZ NOT NULL,
    "first_responded_at" TIMESTAMPTZ,
    "waiting_since" TIMESTAMPTZ,
    "resolution" "Resolution",
    "resolution_note" TEXT,
    "resolved_at" TIMESTAMPTZ,
    "resolved_by" UUID,
    "closed_at" TIMESTAMPTZ,
    "reopen_count" INTEGER NOT NULL DEFAULT 0,
    "incident_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_message" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "ticket_id" UUID NOT NULL,
    "author_user_id" UUID,
    "author_kind" "MessageAuthor" NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_refund" (
    "ticket_id" UUID NOT NULL,
    "refund_id" UUID NOT NULL,
    "amount_minor" BIGINT,
    "status" "RefundLinkStatus" NOT NULL DEFAULT 'REQUESTED',
    "note" TEXT,
    "linked_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_refund_pkey" PRIMARY KEY ("ticket_id","refund_id")
);

-- CreateTable
CREATE TABLE "lost_item" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "ticket_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "city_id" TEXT NOT NULL,
    "rider_user_id" UUID NOT NULL,
    "driver_user_id" UUID,
    "fleet_org_id" UUID,
    "description" TEXT NOT NULL,
    "status" "LostItemStatus" NOT NULL DEFAULT 'REPORTED',
    "found" BOOLEAN,
    "driver_note" TEXT,
    "responded_at" TIMESTAMPTZ,
    "returned_at" TIMESTAMPTZ,
    "closed_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lost_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lost_item_message" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "lost_item_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "author_kind" "LostItemAuthor" NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lost_item_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sos_alert" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "city_id" TEXT NOT NULL,
    "trip_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "SosRole" NOT NULL,
    "source" "SosSource" NOT NULL DEFAULT 'APP',
    "status" "SosStatus" NOT NULL DEFAULT 'OPEN',
    "outcome" "SosOutcome",
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "location_at" TIMESTAMPTZ NOT NULL,
    "trip_verified" BOOLEAN NOT NULL DEFAULT true,
    "rider_user_id" UUID,
    "driver_user_id" UUID,
    "triggered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMPTZ,
    "acknowledged_by" UUID,
    "resolved_at" TIMESTAMPTZ,
    "resolved_by" UUID,
    "resolution_note" TEXT,
    "emergency_reference" TEXT,
    "incident_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sos_alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sos_note" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "alert_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sos_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "ref" SERIAL NOT NULL,
    "city_id" TEXT NOT NULL,
    "category" "IncidentCategory" NOT NULL,
    "severity" "IncidentSeverity" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "summary" TEXT NOT NULL,
    "trip_id" UUID,
    "subject_user_ids" UUID[],
    "source" "IncidentSource" NOT NULL,
    "owner_user_id" UUID,
    "opened_by" UUID,
    "outcome" "IncidentOutcome",
    "outcome_note" TEXT,
    "resolved_at" TIMESTAMPTZ,
    "resolved_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_note" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "incident_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_action" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "incident_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "IncidentActionKind" NOT NULL,
    "until" TIMESTAMPTZ,
    "reference" TEXT,
    "note" TEXT,
    "recorded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_action_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "ticket_ref_key" ON "ticket"("ref");

-- CreateIndex
CREATE INDEX "ticket_city_id_status_created_at_idx" ON "ticket"("city_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ticket_requester_user_id_created_at_idx" ON "ticket"("requester_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ticket_trip_id_idx" ON "ticket"("trip_id");

-- CreateIndex
CREATE INDEX "ticket_assignee_user_id_status_idx" ON "ticket"("assignee_user_id", "status");

-- CreateIndex
CREATE INDEX "ticket_message_ticket_id_created_at_idx" ON "ticket_message"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "ticket_refund_refund_id_idx" ON "ticket_refund"("refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "lost_item_ticket_id_key" ON "lost_item"("ticket_id");

-- CreateIndex
CREATE INDEX "lost_item_city_id_status_created_at_idx" ON "lost_item"("city_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "lost_item_driver_user_id_status_idx" ON "lost_item"("driver_user_id", "status");

-- CreateIndex
CREATE INDEX "lost_item_fleet_org_id_status_idx" ON "lost_item"("fleet_org_id", "status");

-- CreateIndex
CREATE INDEX "lost_item_rider_user_id_idx" ON "lost_item"("rider_user_id");

-- CreateIndex
CREATE INDEX "lost_item_message_lost_item_id_created_at_idx" ON "lost_item_message"("lost_item_id", "created_at");

-- CreateIndex
CREATE INDEX "sos_alert_city_id_status_triggered_at_idx" ON "sos_alert"("city_id", "status", "triggered_at");

-- CreateIndex
CREATE INDEX "sos_alert_user_id_trip_id_triggered_at_idx" ON "sos_alert"("user_id", "trip_id", "triggered_at" DESC);

-- CreateIndex
CREATE INDEX "sos_note_alert_id_created_at_idx" ON "sos_note"("alert_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "incident_ref_key" ON "incident"("ref");

-- CreateIndex
CREATE INDEX "incident_city_id_status_created_at_idx" ON "incident"("city_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "incident_trip_id_idx" ON "incident"("trip_id");

-- CreateIndex
CREATE INDEX "incident_note_incident_id_created_at_idx" ON "incident_note"("incident_id", "created_at");

-- CreateIndex
CREATE INDEX "incident_action_incident_id_created_at_idx" ON "incident_action"("incident_id", "created_at");

-- CreateIndex
CREATE INDEX "incident_action_user_id_idx" ON "incident_action"("user_id");

-- AddForeignKey
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_message" ADD CONSTRAINT "ticket_message_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_refund" ADD CONSTRAINT "ticket_refund_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_item" ADD CONSTRAINT "lost_item_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_item_message" ADD CONSTRAINT "lost_item_message_lost_item_id_fkey" FOREIGN KEY ("lost_item_id") REFERENCES "lost_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sos_alert" ADD CONSTRAINT "sos_alert_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sos_note" ADD CONSTRAINT "sos_note_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "sos_alert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_note" ADD CONSTRAINT "incident_note_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_action" ADD CONSTRAINT "incident_action_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Constraints Prisma can't express ──────────────────────────────────────────
-- one live SOS per user and trip: a second press returns the same alert (src/support/sos.ts)
CREATE UNIQUE INDEX ux_sos_alert_live ON "sos_alert" (user_id, trip_id) WHERE status IN ('OPEN', 'ACKNOWLEDGED');
-- one live lost-item report per trip
CREATE UNIQUE INDEX ux_lost_item_live ON "lost_item" (trip_id) WHERE status IN ('REPORTED', 'FOUND', 'NOT_FOUND');

ALTER TABLE "ticket"
  ADD CONSTRAINT ck_ticket_resolution CHECK (status <> 'RESOLVED' OR resolution IS NOT NULL),
  ADD CONSTRAINT ck_ticket_city CHECK (city_id ~ '^[a-z0-9-]{1,40}$');
ALTER TABLE "sos_alert"
  ADD CONSTRAINT ck_sos_outcome CHECK (status <> 'RESOLVED' OR outcome IS NOT NULL),
  ADD CONSTRAINT ck_sos_position CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180);
ALTER TABLE "incident"
  ADD CONSTRAINT ck_incident_outcome CHECK (status <> 'RESOLVED' OR outcome IS NOT NULL);

-- legal hold (workflow 14 §6): SOS and incident records are never deleted
CREATE FUNCTION refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted (legal hold)', TG_TABLE_NAME;
END $$;
CREATE TRIGGER tr_sos_alert_no_delete BEFORE DELETE ON "sos_alert" FOR EACH ROW EXECUTE FUNCTION refuse_delete();
CREATE TRIGGER tr_sos_note_no_delete BEFORE DELETE ON "sos_note" FOR EACH ROW EXECUTE FUNCTION refuse_delete();
CREATE TRIGGER tr_incident_no_delete BEFORE DELETE ON "incident" FOR EACH ROW EXECUTE FUNCTION refuse_delete();
CREATE TRIGGER tr_incident_note_no_delete BEFORE DELETE ON "incident_note" FOR EACH ROW EXECUTE FUNCTION refuse_delete();
CREATE TRIGGER tr_incident_action_no_delete BEFORE DELETE ON "incident_action" FOR EACH ROW EXECUTE FUNCTION refuse_delete();

CREATE INDEX ix_outbox_unpublished ON "outbox" (created_at) WHERE published_at IS NULL;
