-- Write-once audit store (Role.md §12): partitioned by month, no updates or deletes.

CREATE TABLE "audit_entry" (
    "event_id" UUID NOT NULL,
    "at" TIMESTAMPTZ NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "on_behalf_of" UUID,
    "service" TEXT,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- (at, event_id): a replayed event (same id, same time) is inserted once
    CONSTRAINT "audit_entry_pkey" PRIMARY KEY ("at","event_id"),
    CONSTRAINT ck_audit_outcome CHECK (outcome IN ('ALLOWED','DENIED','PENDING_APPROVAL','EXECUTED'))
) PARTITION BY RANGE ("at");

CREATE INDEX "audit_entry_actor_id_at_idx" ON "audit_entry"("actor_id", "at" DESC);
CREATE INDEX "audit_entry_resource_type_resource_id_at_idx" ON "audit_entry"("resource_type", "resource_id", "at" DESC);
CREATE INDEX "audit_entry_action_at_idx" ON "audit_entry"("action", "at" DESC);

-- write once: even the owner can't change history through the application
CREATE OR REPLACE FUNCTION audit_entry_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit entries are write-once (%)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_entry_no_update_delete BEFORE UPDATE OR DELETE ON "audit_entry"
  FOR EACH ROW EXECUTE FUNCTION audit_entry_immutable();

-- monthly partitions, created ahead by ensure_audit_partitions() (audit-service: at start-up and daily);
-- the default partition catches anything else. Old partitions are exported to WORM storage and detached by ops.
CREATE TABLE audit_entry_default PARTITION OF "audit_entry" DEFAULT;

CREATE OR REPLACE FUNCTION ensure_audit_partitions(months_ahead int DEFAULT 2) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  m date := date_trunc('month', now())::date;
  name text;
BEGIN
  FOR i IN 0..months_ahead LOOP
    name := format('audit_entry_%s', to_char(m, 'YYYY_MM'));
    IF to_regclass(name) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF audit_entry FOR VALUES FROM (%L) TO (%L)', name, m, (m + interval '1 month')::date);
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
END $$;

SELECT ensure_audit_partitions(2);
