-- CreateTable
CREATE TABLE "campaign_audience" (
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "city_id" TEXT NOT NULL,
    "last_active_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "campaign_audience_pkey" PRIMARY KEY ("user_id","role","city_id")
);

-- CreateTable
CREATE TABLE "campaign" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "city_id" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "last_active_days" INTEGER,
    "channel" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduled_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "targeted" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_delivery" (
    "campaign_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ,

    CONSTRAINT "campaign_delivery_pkey" PRIMARY KEY ("campaign_id","user_id")
);

-- CreateTable
CREATE TABLE "marketing_opt_out" (
    "user_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_opt_out_pkey" PRIMARY KEY ("user_id","channel")
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
CREATE INDEX "campaign_audience_city_id_role_last_active_at_idx" ON "campaign_audience"("city_id", "role", "last_active_at" DESC);

-- CreateIndex
CREATE INDEX "campaign_status_scheduled_at_idx" ON "campaign"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "campaign_city_id_created_at_idx" ON "campaign"("city_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "campaign_delivery_status_campaign_id_idx" ON "campaign_delivery"("status", "campaign_id");

-- AddForeignKey
ALTER TABLE "campaign_delivery" ADD CONSTRAINT "campaign_delivery_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── constraints Prisma can't declare ──────────────────────────────────────────
ALTER TABLE "campaign_audience" ADD CONSTRAINT ck_campaign_audience_role CHECK (role IN ('RIDER', 'DRIVER'));
ALTER TABLE "campaign" ADD CONSTRAINT ck_campaign_audience CHECK (audience IN ('RIDER', 'DRIVER'));
ALTER TABLE "campaign" ADD CONSTRAINT ck_campaign_channel CHECK (channel IN ('PUSH', 'SMS'));
ALTER TABLE "campaign" ADD CONSTRAINT ck_campaign_status CHECK (status IN ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED'));
ALTER TABLE "campaign" ADD CONSTRAINT ck_campaign_window CHECK (last_active_days IS NULL OR last_active_days BETWEEN 1 AND 365);
ALTER TABLE "campaign" ADD CONSTRAINT ck_campaign_scheduled CHECK (status <> 'SCHEDULED' OR scheduled_at IS NOT NULL);
ALTER TABLE "campaign_delivery" ADD CONSTRAINT ck_campaign_delivery_status CHECK (status IN ('PENDING', 'IN_FLIGHT', 'SENT', 'SKIPPED', 'FAILED'));
ALTER TABLE "marketing_opt_out" ADD CONSTRAINT ck_marketing_opt_out_channel CHECK (channel IN ('PUSH', 'SMS'));
-- the sender only looks at work still to do
CREATE INDEX ix_campaign_delivery_todo ON "campaign_delivery" (campaign_id) WHERE status IN ('PENDING', 'IN_FLIGHT');
CREATE INDEX ix_outbox_unpublished ON "outbox" (created_at) WHERE published_at IS NULL;
