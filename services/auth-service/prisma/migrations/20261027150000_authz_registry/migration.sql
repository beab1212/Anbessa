-- Permission matrix as data (Role.md §8): seeded from libs/shared-authz at start, then edited
-- only through approved authz:change requests.

CREATE TABLE "role_definition" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "audience" TEXT NOT NULL,
    "storage_type" TEXT NOT NULL,
    "org_kinds" TEXT[],
    "stored" TEXT NOT NULL,
    "built_in" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "role_definition_pkey" PRIMARY KEY ("code"),
    CONSTRAINT ck_role_audience CHECK (audience IN ('ride-app','ride-admin')),
    CONSTRAINT ck_role_storage CHECK (storage_type IN ('user','member')),
    -- custom roles are staff roles (guardrail, Role.md §8)
    CONSTRAINT ck_role_custom_staff CHECK (built_in OR (audience = 'ride-admin' AND code LIKE 'CUSTOM\_%'))
);
CREATE UNIQUE INDEX "role_definition_stored_key" ON "role_definition"("stored");

CREATE TABLE "role_permission" (
    "role_code" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_code","permission"),
    CONSTRAINT "role_permission_role_code_fkey" FOREIGN KEY ("role_code") REFERENCES "role_definition"("code") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT ck_role_permission_scope CHECK (scope IN ('S','O','C','G'))
);

CREATE TABLE "authz_version" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "authz_version_pkey" PRIMARY KEY ("id"),
    CONSTRAINT ck_authz_version_single CHECK (id = 1)
);
INSERT INTO "authz_version" (id, version) VALUES (1, 0);

-- approvals for every action: a maker may withdraw (CANCELLED); an executor may fail (FAILED)
ALTER TABLE "approval_request" DROP CONSTRAINT "ck_approval_status";
ALTER TABLE "approval_request"
  ADD CONSTRAINT "ck_approval_status" CHECK ("status" IN ('PENDING','APPROVED','REJECTED','EXECUTED','EXPIRED','CANCELLED','FAILED'));
CREATE INDEX ix_approval_action_status ON "approval_request" (action, status, created_at DESC);
