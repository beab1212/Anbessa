-- Phase 2D: organisation reinstatement (what a suspension changed, and who lifted it) and
-- city-aware approvals (the request's city decides who sees and decides it).

ALTER TABLE "approval_request" ADD COLUMN "city_id" TEXT;
CREATE INDEX ix_approval_city ON "approval_request" (city_id, status) WHERE city_id IS NOT NULL;
-- role grants of city-scoped roles already carry their city in the payload
UPDATE "approval_request" SET city_id = payload->>'cityId' WHERE action = 'role:grant' AND payload->>'cityId' IS NOT NULL;

CREATE TABLE "organization_suspension" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "previous_status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "suspended_by" UUID NOT NULL,
    "suspended_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reinstated_by" UUID,
    "reinstated_at" TIMESTAMPTZ,
    "reinstate_reason" TEXT,
    CONSTRAINT "organization_suspension_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organization_suspension_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT ck_org_suspension_previous CHECK (previous_status IN ('PENDING','VERIFIED'))
);
CREATE INDEX "organization_suspension_organization_id_suspended_at_idx" ON "organization_suspension"("organization_id", "suspended_at" DESC);
-- at most one open suspension per organisation
CREATE UNIQUE INDEX ux_org_suspension_open ON "organization_suspension" (organization_id) WHERE reinstated_at IS NULL;
