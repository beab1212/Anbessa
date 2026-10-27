-- Money controls (Payment.md §15–§16, workflows 09, 11, 13, 15): balance adjustments, write-offs,
-- per-beneficiary policy overrides, driver incentives and corporate invoices.

-- CreateTable
CREATE TABLE "balance_adjustment" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "beneficiary_account_id" UUID NOT NULL,
    "city_id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "category" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ticket_id" TEXT,
    "trip_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requested_by" UUID NOT NULL,
    "decided_by" UUID,
    "decision_reason" TEXT,
    "journal_entry_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "balance_adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "write_off" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "beneficiary_account_id" UUID NOT NULL,
    "city_id" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requested_by" UUID NOT NULL,
    "decided_by" UUID,
    "decision_reason" TEXT,
    "journal_entry_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "write_off_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_override" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "beneficiary_account_id" UUID NOT NULL,
    "city_id" TEXT NOT NULL,
    "mode" TEXT,
    "warning_minor" BIGINT,
    "cash_limit_minor" BIGINT,
    "hard_limit_minor" BIGINT,
    "prepaid_minimum_minor" BIGINT,
    "valid_from" TIMESTAMPTZ NOT NULL,
    "valid_until" TIMESTAMPTZ NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requested_by" UUID NOT NULL,
    "decided_by" UUID,
    "decision_reason" TEXT,
    "revoked_by" UUID,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "policy_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incentive_program" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "city_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vehicle_type" TEXT,
    "target_trips" INTEGER NOT NULL,
    "reward_minor" BIGINT NOT NULL,
    "budget_minor" BIGINT NOT NULL,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "proposed_by" UUID NOT NULL,
    "decided_by" UUID,
    "decision_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "closed_at" TIMESTAMPTZ,
    "qualified_count" INTEGER NOT NULL DEFAULT 0,
    "awards_count" INTEGER NOT NULL DEFAULT 0,
    "spent_minor" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "incentive_program_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incentive_award" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "program_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "beneficiary_account_id" UUID NOT NULL,
    "trips" INTEGER NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "journal_entry_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incentive_award_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "period_start" TIMESTAMPTZ NOT NULL,
    "period_end" TIMESTAMPTZ NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'ETB',
    "total_minor" BIGINT NOT NULL,
    "line_count" INTEGER NOT NULL,
    "paid_minor" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "issued_by" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMPTZ NOT NULL,
    "paid_at" TIMESTAMPTZ,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "invoice_id" UUID NOT NULL,
    "posting_id" UUID NOT NULL,
    "journal_entry_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "trip_id" UUID,
    "purpose" TEXT,
    "rider_id" UUID,
    "city_id" TEXT,
    "vehicle_type" TEXT,
    "at" TIMESTAMPTZ NOT NULL,
    "amount_minor" BIGINT NOT NULL,

    CONSTRAINT "invoice_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_payment" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "invoice_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "bank_reference" TEXT NOT NULL,
    "recorded_by" UUID NOT NULL,
    "journal_entry_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_counter" (
    "period" TEXT NOT NULL,
    "last" INTEGER NOT NULL,

    CONSTRAINT "invoice_counter_pkey" PRIMARY KEY ("period")
);

-- CreateIndex
CREATE INDEX "balance_adjustment_status_created_at_idx" ON "balance_adjustment"("status", "created_at");

-- CreateIndex
CREATE INDEX "balance_adjustment_beneficiary_account_id_created_at_idx" ON "balance_adjustment"("beneficiary_account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "write_off_status_created_at_idx" ON "write_off"("status", "created_at");

-- CreateIndex
CREATE INDEX "write_off_beneficiary_account_id_created_at_idx" ON "write_off"("beneficiary_account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "policy_override_status_created_at_idx" ON "policy_override"("status", "created_at");

-- CreateIndex
CREATE INDEX "policy_override_beneficiary_account_id_valid_from_idx" ON "policy_override"("beneficiary_account_id", "valid_from");

-- CreateIndex
CREATE INDEX "incentive_program_status_ends_at_idx" ON "incentive_program"("status", "ends_at");

-- CreateIndex
CREATE INDEX "incentive_program_city_id_starts_at_idx" ON "incentive_program"("city_id", "starts_at");

-- CreateIndex
CREATE INDEX "incentive_award_beneficiary_account_id_created_at_idx" ON "incentive_award"("beneficiary_account_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "incentive_award_program_id_driver_id_beneficiary_account_id_key" ON "incentive_award"("program_id", "driver_id", "beneficiary_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_number_key" ON "invoice"("number");

-- CreateIndex
CREATE INDEX "invoice_status_due_at_idx" ON "invoice"("status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_org_id_period_key" ON "invoice"("org_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_line_posting_id_key" ON "invoice_line"("posting_id");

-- CreateIndex
CREATE INDEX "invoice_line_invoice_id_at_idx" ON "invoice_line"("invoice_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_payment_bank_reference_key" ON "invoice_payment"("bank_reference");

-- CreateIndex
CREATE INDEX "invoice_payment_invoice_id_idx" ON "invoice_payment"("invoice_id");

-- AddForeignKey
ALTER TABLE "incentive_award" ADD CONSTRAINT "incentive_award_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "incentive_program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payment" ADD CONSTRAINT "invoice_payment_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ────────────────────────────────────────────────────────────────────────────
-- Hand-written: what Prisma can't express
-- ────────────────────────────────────────────────────────────────────────────

-- maker ≠ checker on every decision (cancel is the maker's own withdrawal)
ALTER TABLE "balance_adjustment"
  ADD CONSTRAINT ck_balance_adjustment_direction CHECK (direction IN ('CREDIT','DEBIT')),
  ADD CONSTRAINT ck_balance_adjustment_amount CHECK (amount_minor > 0),
  ADD CONSTRAINT ck_balance_adjustment_category CHECK (category IN ('GOODWILL','FEE_REVERSAL','CORRECTION','LOST_ITEM_RETURN','OTHER')),
  ADD CONSTRAINT ck_balance_adjustment_status CHECK (status IN ('PENDING_APPROVAL','EXECUTED','REJECTED','CANCELLED','EXPIRED')),
  ADD CONSTRAINT ck_balance_adjustment_checker CHECK (status NOT IN ('EXECUTED','REJECTED') OR (decided_by IS NOT NULL AND decided_by <> requested_by)),
  ADD CONSTRAINT ck_balance_adjustment_executed CHECK ((status = 'EXECUTED') = (journal_entry_id IS NOT NULL));

ALTER TABLE "write_off"
  ADD CONSTRAINT ck_write_off_amount CHECK (amount_minor > 0),
  ADD CONSTRAINT ck_write_off_status CHECK (status IN ('PENDING_APPROVAL','EXECUTED','REJECTED','CANCELLED','EXPIRED')),
  ADD CONSTRAINT ck_write_off_checker CHECK (status NOT IN ('EXECUTED','REJECTED') OR (decided_by IS NOT NULL AND decided_by <> requested_by)),
  ADD CONSTRAINT ck_write_off_executed CHECK ((status = 'EXECUTED') = (journal_entry_id IS NOT NULL));
-- one open write-off request per balance
CREATE UNIQUE INDEX ux_write_off_pending ON "write_off"(beneficiary_account_id) WHERE status = 'PENDING_APPROVAL';

ALTER TABLE "policy_override"
  ADD CONSTRAINT ck_policy_override_mode CHECK (mode IS NULL OR mode IN ('POSTPAID','PREPAID')),
  ADD CONSTRAINT ck_policy_override_something CHECK (mode IS NOT NULL OR warning_minor IS NOT NULL OR cash_limit_minor IS NOT NULL
    OR hard_limit_minor IS NOT NULL OR prepaid_minimum_minor IS NOT NULL),
  ADD CONSTRAINT ck_policy_override_limits CHECK ((warning_minor IS NULL OR warning_minor <= 0) AND (cash_limit_minor IS NULL OR cash_limit_minor <= 0)
    AND (hard_limit_minor IS NULL OR hard_limit_minor <= 0) AND (prepaid_minimum_minor IS NULL OR prepaid_minimum_minor >= 0)),
  ADD CONSTRAINT ck_policy_override_window CHECK (valid_until > valid_from),
  ADD CONSTRAINT ck_policy_override_status CHECK (status IN ('PENDING_APPROVAL','APPROVED','REVOKED','REJECTED','CANCELLED','EXPIRED')),
  ADD CONSTRAINT ck_policy_override_checker CHECK (status NOT IN ('APPROVED','REVOKED','REJECTED') OR (decided_by IS NOT NULL AND decided_by <> requested_by)),
  -- two approved overrides of one balance never overlap in time (btree_gist from the init migration)
  ADD CONSTRAINT ex_policy_override_no_overlap EXCLUDE USING gist (
    beneficiary_account_id WITH =, tstzrange(valid_from, valid_until) WITH &&) WHERE (status = 'APPROVED');

ALTER TABLE "incentive_program"
  ADD CONSTRAINT ck_incentive_program_amounts CHECK (target_trips >= 1 AND reward_minor > 0 AND budget_minor >= reward_minor),
  ADD CONSTRAINT ck_incentive_program_window CHECK (ends_at > starts_at),
  ADD CONSTRAINT ck_incentive_program_status CHECK (status IN ('PENDING_APPROVAL','APPROVED','CLOSED','REJECTED','CANCELLED','EXPIRED')),
  ADD CONSTRAINT ck_incentive_program_checker CHECK (status NOT IN ('APPROVED','CLOSED','REJECTED') OR (decided_by IS NOT NULL AND decided_by <> proposed_by)),
  ADD CONSTRAINT ck_incentive_program_budget CHECK (spent_minor >= 0 AND spent_minor <= budget_minor);

ALTER TABLE "incentive_award" ADD CONSTRAINT ck_incentive_award_amount CHECK (amount_minor > 0 AND trips >= 1);

ALTER TABLE "invoice"
  ADD CONSTRAINT ck_invoice_period CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ADD CONSTRAINT ck_invoice_amounts CHECK (total_minor > 0 AND line_count > 0 AND paid_minor >= 0 AND paid_minor <= total_minor),
  ADD CONSTRAINT ck_invoice_status CHECK (status IN ('ISSUED','PAID') AND ((status = 'PAID') = (paid_minor = total_minor))),
  ADD CONSTRAINT ck_invoice_window CHECK (period_end > period_start);
ALTER TABLE "invoice_payment" ADD CONSTRAINT ck_invoice_payment_amount CHECK (amount_minor > 0);

-- An issued invoice never changes, except how much of it is paid.
CREATE FUNCTION refuse_invoice_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoices are never deleted';
  END IF;
  IF (NEW.org_id, NEW.period, NEW.number, NEW.period_start, NEW.period_end, NEW.currency, NEW.total_minor, NEW.line_count, NEW.issued_by, NEW.issued_at, NEW.due_at)
     IS DISTINCT FROM
     (OLD.org_id, OLD.period, OLD.number, OLD.period_start, OLD.period_end, OLD.currency, OLD.total_minor, OLD.line_count, OLD.issued_by, OLD.issued_at, OLD.due_at) THEN
    RAISE EXCEPTION 'invoice % is issued and can''t change', OLD.number;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_invoice_immutable BEFORE UPDATE OR DELETE ON "invoice" FOR EACH ROW EXECUTE FUNCTION refuse_invoice_change();
-- lines, payments and awards are history (refuse_ledger_change() from the init migration)
CREATE TRIGGER trg_invoice_line_append_only BEFORE UPDATE OR DELETE ON "invoice_line" FOR EACH ROW EXECUTE FUNCTION refuse_ledger_change();
CREATE TRIGGER trg_invoice_payment_append_only BEFORE UPDATE OR DELETE ON "invoice_payment" FOR EACH ROW EXECUTE FUNCTION refuse_ledger_change();
CREATE TRIGGER trg_incentive_award_append_only BEFORE UPDATE OR DELETE ON "incentive_award" FOR EACH ROW EXECUTE FUNCTION refuse_ledger_change();
