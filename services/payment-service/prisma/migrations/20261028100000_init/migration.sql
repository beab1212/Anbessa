-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "ledger_account" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT,
    "city_id" TEXT,
    "currency" CHAR(3) NOT NULL DEFAULT 'ETB',
    "balance_minor" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entry" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "kind" TEXT NOT NULL,
    "reference_type" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "memo" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posting" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "journal_entry_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "posting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beneficiary" (
    "account_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "city_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OK',
    "overdue_since" TIMESTAMPTZ,
    "state_changed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference_code" TEXT NOT NULL,
    "payout_provider" TEXT,
    "payout_destination" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "beneficiary_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "commission_rule" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "city_id" TEXT NOT NULL,
    "vehicle_type" TEXT,
    "beneficiary_id" UUID,
    "model" TEXT NOT NULL,
    "rate_bp" INTEGER,
    "fixed_minor" BIGINT,
    "min_minor" BIGINT,
    "max_minor" BIGINT,
    "valid_from" TIMESTAMPTZ NOT NULL,
    "valid_to" TIMESTAMPTZ,
    "proposed_by" UUID NOT NULL,
    "approved_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balance_policy" (
    "city_id" TEXT NOT NULL,
    "valid_from" TIMESTAMPTZ NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'POSTPAID',
    "warning_minor" BIGINT NOT NULL,
    "cash_limit_minor" BIGINT NOT NULL,
    "hard_limit_minor" BIGINT NOT NULL,
    "prepaid_minimum_minor" BIGINT NOT NULL DEFAULT 0,
    "due_days" INTEGER NOT NULL DEFAULT 3,
    "min_payment_bp" INTEGER NOT NULL DEFAULT 5000,
    "min_payout_minor" BIGINT NOT NULL DEFAULT 10000,
    "tax_basis" TEXT NOT NULL DEFAULT 'COMMISSION',
    "vat_rate_bp" INTEGER NOT NULL DEFAULT 1500,
    "proposed_by" UUID NOT NULL,
    "approved_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_policy_pkey" PRIMARY KEY ("city_id","valid_from")
);

-- CreateTable
CREATE TABLE "rule_change" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "kind" TEXT NOT NULL,
    "city_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "maker_id" UUID NOT NULL,
    "checker_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decision_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rule_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "purpose" TEXT NOT NULL,
    "trip_id" UUID NOT NULL,
    "rider_id" UUID NOT NULL,
    "city_id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'ETB',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "provider_ref" TEXT,
    "provider_txn_id" TEXT,
    "checkout_url" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "refunded_minor" BIGINT NOT NULL DEFAULT 0,
    "settlement" JSONB NOT NULL,
    "settled_as_receivable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_settlement" (
    "trip_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "payment_method" TEXT NOT NULL,
    "city_id" TEXT NOT NULL,
    "vehicle_type" TEXT,
    "driver_id" UUID,
    "rider_id" UUID NOT NULL,
    "beneficiary_account_id" UUID,
    "fare_minor" BIGINT NOT NULL,
    "commission_minor" BIGINT NOT NULL,
    "vat_minor" BIGINT NOT NULL,
    "commission_rule_id" UUID,
    "earnings_minor" BIGINT NOT NULL,
    "journal_entry_id" UUID NOT NULL,
    "settled_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_settlement_pkey" PRIMARY KEY ("trip_id","purpose")
);

-- CreateTable
CREATE TABLE "payer_preference" (
    "user_id" UUID NOT NULL,
    "mobile_money_provider" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payer_preference_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "refund" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "payment_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "driver_at_fault" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requested_by" UUID NOT NULL,
    "approved_by" UUID,
    "decision_reason" TEXT,
    "provider_ref" TEXT,
    "failure" TEXT,
    "journal_entry_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "top_up" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "beneficiary_account_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "provider" TEXT,
    "amount_minor" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "provider_ref" TEXT,
    "provider_txn_id" TEXT,
    "checkout_url" TEXT,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "receipt_no" TEXT,
    "note" TEXT,
    "failure" TEXT,
    "journal_entry_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "top_up_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_due" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "beneficiary_account_id" UUID NOT NULL,
    "cycle_end" DATE NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "minimum_minor" BIGINT NOT NULL,
    "paid_minor" BIGINT NOT NULL DEFAULT 0,
    "due_at" TIMESTAMPTZ NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_due_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_batch" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "cycle_end" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "prepared_by" UUID,
    "approved_by" UUID,
    "reject_reason" TEXT,
    "total_minor" BIGINT NOT NULL DEFAULT 0,
    "line_count" INTEGER NOT NULL DEFAULT 0,
    "dues_created" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,

    CONSTRAINT "payout_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_line" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "batch_id" UUID NOT NULL,
    "beneficiary_account_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "provider" TEXT,
    "destination" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "provider_ref" TEXT,
    "provider_txn_id" TEXT,
    "failure" TEXT,
    "journal_entry_id" UUID,
    "reversal_entry_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_event" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "signature_ok" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "outcome" TEXT,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox" (
    "event_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id")
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
CREATE UNIQUE INDEX "ledger_account_code_key" ON "ledger_account"("code");

-- CreateIndex
CREATE INDEX "ledger_account_kind_idx" ON "ledger_account"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entry_idempotency_key_key" ON "journal_entry"("idempotency_key");

-- CreateIndex
CREATE INDEX "journal_entry_reference_type_reference_id_idx" ON "journal_entry"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "ix_posting_account" ON "posting"("account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_posting_entry" ON "posting"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "beneficiary_reference_code_key" ON "beneficiary"("reference_code");

-- CreateIndex
CREATE INDEX "beneficiary_state_idx" ON "beneficiary"("state");

-- CreateIndex
CREATE UNIQUE INDEX "beneficiary_type_owner_id_key" ON "beneficiary"("type", "owner_id");

-- CreateIndex
CREATE INDEX "commission_rule_city_id_valid_from_idx" ON "commission_rule"("city_id", "valid_from");

-- CreateIndex
CREATE INDEX "rule_change_status_created_at_idx" ON "rule_change"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_ref_key" ON "payment"("provider_ref");

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_txn_id_key" ON "payment"("provider_txn_id");

-- CreateIndex
CREATE INDEX "payment_status_updated_at_idx" ON "payment"("status", "updated_at");

-- CreateIndex
CREATE INDEX "payment_rider_id_created_at_idx" ON "payment"("rider_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "payment_trip_id_purpose_key" ON "payment"("trip_id", "purpose");

-- CreateIndex
CREATE INDEX "trip_settlement_beneficiary_account_id_settled_at_idx" ON "trip_settlement"("beneficiary_account_id", "settled_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "refund_provider_ref_key" ON "refund"("provider_ref");

-- CreateIndex
CREATE INDEX "refund_status_created_at_idx" ON "refund"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "top_up_provider_ref_key" ON "top_up"("provider_ref");

-- CreateIndex
CREATE UNIQUE INDEX "top_up_provider_txn_id_key" ON "top_up"("provider_txn_id");

-- CreateIndex
CREATE INDEX "top_up_beneficiary_account_id_created_at_idx" ON "top_up"("beneficiary_account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "top_up_status_updated_at_idx" ON "top_up"("status", "updated_at");

-- CreateIndex
CREATE INDEX "payment_due_status_due_at_idx" ON "payment_due"("status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_due_beneficiary_account_id_cycle_end_key" ON "payment_due"("beneficiary_account_id", "cycle_end");

-- CreateIndex
CREATE UNIQUE INDEX "payout_batch_cycle_end_key" ON "payout_batch"("cycle_end");

-- CreateIndex
CREATE UNIQUE INDEX "payout_line_provider_ref_key" ON "payout_line"("provider_ref");

-- CreateIndex
CREATE UNIQUE INDEX "payout_line_provider_txn_id_key" ON "payout_line"("provider_txn_id");

-- CreateIndex
CREATE INDEX "payout_line_status_updated_at_idx" ON "payout_line"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "payout_line_batch_id_beneficiary_account_id_key" ON "payout_line"("batch_id", "beneficiary_account_id");

-- CreateIndex
CREATE INDEX "webhook_event_received_at_idx" ON "webhook_event"("received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_event_provider_event_key_key" ON "webhook_event"("provider", "event_key");

-- CreateIndex
CREATE INDEX "ix_outbox_unpublished" ON "outbox"("created_at");

-- AddForeignKey
ALTER TABLE "posting" ADD CONSTRAINT "posting_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posting" ADD CONSTRAINT "posting_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beneficiary" ADD CONSTRAINT "beneficiary_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_line" ADD CONSTRAINT "payout_line_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "payout_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ────────────────────────────────────────────────────────────────────────────
-- Hand-written: what Prisma can't express (Payment.md §13, Database.md §7.4)
-- ────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "ledger_account"
  ADD CONSTRAINT ck_ledger_account_kind CHECK (kind IN ('BENEFICIARY_BALANCE','COMMISSION_REVENUE','PROVIDER_CLEARING','CORPORATE_RECEIVABLE',
    'RIDER_RECEIVABLE','PROMO_EXPENSE','VAT_PAYABLE','CASH_RECEIPTS','BAD_DEBT_EXPENSE','GOODWILL_EXPENSE')),
  ADD CONSTRAINT ck_ledger_account_owner CHECK (owner_type IN ('USER','ORGANIZATION','PLATFORM','PROVIDER'));

ALTER TABLE "posting" ADD CONSTRAINT ck_posting_nonzero CHECK (amount_minor <> 0);

-- Every journal entry balances. Checked at COMMIT, after all its postings are inserted.
CREATE FUNCTION assert_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT coalesce(sum(amount_minor), 0) FROM posting WHERE journal_entry_id = NEW.journal_entry_id) <> 0 THEN
    RAISE EXCEPTION 'journal entry % does not balance', NEW.journal_entry_id;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_posting_balanced AFTER INSERT ON "posting"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- History never changes: corrections are new entries (in production the app role also lacks the grants).
CREATE FUNCTION refuse_ledger_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER trg_posting_append_only BEFORE UPDATE OR DELETE ON "posting" FOR EACH ROW EXECUTE FUNCTION refuse_ledger_change();
CREATE TRIGGER trg_journal_entry_append_only BEFORE UPDATE OR DELETE ON "journal_entry" FOR EACH ROW EXECUTE FUNCTION refuse_ledger_change();

ALTER TABLE "beneficiary"
  ADD CONSTRAINT ck_beneficiary_type CHECK (type IN ('INDIVIDUAL','ORGANIZATION')),
  ADD CONSTRAINT ck_beneficiary_state CHECK (state IN ('OK','WARNING','CASH_BLOCKED','BLOCKED'));

ALTER TABLE "commission_rule"
  ADD CONSTRAINT ck_commission_rule_model CHECK (model IN ('PERCENT','FIXED_PER_TRIP','ZERO')),
  ADD CONSTRAINT ck_commission_rule_rate CHECK ((model = 'PERCENT') = (rate_bp IS NOT NULL) AND (rate_bp IS NULL OR rate_bp BETWEEN 0 AND 10000)),
  ADD CONSTRAINT ck_commission_rule_fixed CHECK ((model = 'FIXED_PER_TRIP') = (fixed_minor IS NOT NULL) AND (fixed_minor IS NULL OR fixed_minor >= 0)),
  ADD CONSTRAINT ck_commission_rule_bounds CHECK ((min_minor IS NULL OR min_minor >= 0) AND (max_minor IS NULL OR max_minor >= coalesce(min_minor, 0))),
  ADD CONSTRAINT ck_commission_rule_validity CHECK (valid_to IS NULL OR valid_to > valid_from),
  ADD CONSTRAINT ex_commission_rule_no_overlap EXCLUDE USING gist (
    city_id WITH =,
    (coalesce(vehicle_type, '*')) WITH =,
    (coalesce(beneficiary_id::text, '*')) WITH =,
    tstzrange(valid_from, valid_to) WITH &&);

ALTER TABLE "balance_policy"
  ADD CONSTRAINT ck_balance_policy_mode CHECK (mode IN ('POSTPAID','PREPAID')),
  ADD CONSTRAINT ck_balance_policy_limits CHECK (hard_limit_minor <= cash_limit_minor AND cash_limit_minor <= warning_minor AND warning_minor <= 0),
  ADD CONSTRAINT ck_balance_policy_due CHECK (due_days BETWEEN 1 AND 30 AND min_payment_bp BETWEEN 0 AND 10000 AND min_payout_minor >= 0 AND prepaid_minimum_minor >= 0),
  ADD CONSTRAINT ck_balance_policy_tax CHECK (tax_basis IN ('COMMISSION','FULL_FARE') AND vat_rate_bp BETWEEN 0 AND 10000);

ALTER TABLE "rule_change"
  ADD CONSTRAINT ck_rule_change_kind CHECK (kind IN ('COMMISSION_RULE','BALANCE_POLICY')),
  ADD CONSTRAINT ck_rule_change_status CHECK (status IN ('PENDING','EXECUTED','REJECTED','CANCELLED','EXPIRED')),
  ADD CONSTRAINT ck_rule_change_checker CHECK (checker_id IS NULL OR checker_id <> maker_id);

ALTER TABLE "payment"
  ADD CONSTRAINT ck_payment_purpose CHECK (purpose IN ('TRIP_FARE','CANCELLATION_FEE')),
  ADD CONSTRAINT ck_payment_method CHECK (method IN ('MOBILE_MONEY','CARD')),
  ADD CONSTRAINT ck_payment_amount CHECK (amount_minor > 0 AND refunded_minor >= 0 AND refunded_minor <= amount_minor),
  ADD CONSTRAINT ck_payment_status CHECK (status IN ('PENDING','ACTION_REQUIRED','RETRY_SCHEDULED','SUCCEEDED','FAILED','REFUNDED','PARTIALLY_REFUNDED'));

ALTER TABLE "refund"
  ADD CONSTRAINT ck_refund_amount CHECK (amount_minor > 0),
  ADD CONSTRAINT ck_refund_status CHECK (status IN ('PENDING_APPROVAL','PROCESSING','SUCCEEDED','FAILED','REJECTED')),
  ADD CONSTRAINT ck_refund_checker CHECK (approved_by IS NULL OR approved_by <> requested_by);

ALTER TABLE "top_up"
  ADD CONSTRAINT ck_top_up_channel CHECK (channel IN ('MOBILE_MONEY','BANK_TRANSFER','OFFICE_CASH')),
  ADD CONSTRAINT ck_top_up_amount CHECK (amount_minor > 0),
  ADD CONSTRAINT ck_top_up_status CHECK (status IN ('PENDING','ACTION_REQUIRED','SUCCEEDED','FAILED','PENDING_APPROVAL','REJECTED')),
  ADD CONSTRAINT ck_top_up_checker CHECK (approved_by IS NULL OR channel = 'MOBILE_MONEY' OR approved_by <> created_by);

ALTER TABLE "payment_due"
  ADD CONSTRAINT ck_payment_due_amounts CHECK (amount_minor > 0 AND minimum_minor > 0 AND minimum_minor <= amount_minor AND paid_minor >= 0),
  ADD CONSTRAINT ck_payment_due_status CHECK (status IN ('OPEN','MIN_PAID','PAID','OVERDUE','WRITTEN_OFF'));

ALTER TABLE "payout_batch"
  ADD CONSTRAINT ck_payout_batch_status CHECK (status IN ('PENDING_APPROVAL','SENDING','COMPLETED','REJECTED')),
  ADD CONSTRAINT ck_payout_batch_checker CHECK (approved_by IS NULL OR prepared_by IS NULL OR approved_by <> prepared_by);

ALTER TABLE "payout_line"
  ADD CONSTRAINT ck_payout_line_amount CHECK (amount_minor > 0),
  ADD CONSTRAINT ck_payout_line_status CHECK (status IN ('PENDING','SENT','SUCCEEDED','FAILED','SKIPPED'));
