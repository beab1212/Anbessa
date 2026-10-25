

-- CreateTable
CREATE TABLE "otp_delivery" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "phone_hash" BYTEA NOT NULL,
    "purpose" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "telegram_request_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "cost_usd" DECIMAL(10,4),
    "is_refunded" BOOLEAN,
    "error" TEXT,
    "fallback_of" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_token" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "dedupe_key" TEXT NOT NULL,
    "user_id" UUID,
    "channel" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "otp_delivery_telegram_request_id_key" ON "otp_delivery"("telegram_request_id");

-- CreateIndex
CREATE INDEX "ix_otp_delivery_phone_recent" ON "otp_delivery"("phone_hash", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "device_token_token_key" ON "device_token"("token");

-- CreateIndex
CREATE INDEX "device_token_user_id_idx" ON "device_token"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_dedupe_key_key" ON "notification"("dedupe_key");

-- CreateIndex
CREATE INDEX "notification_user_id_created_at_idx" ON "notification"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "otp_delivery" ADD CONSTRAINT "otp_delivery_fallback_of_fkey" FOREIGN KEY ("fallback_of") REFERENCES "otp_delivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── constraints the Prisma schema can't express (Auth.md §9.7, Database.md §7.5) ──
ALTER TABLE "otp_delivery"
  ADD CONSTRAINT ck_otp_delivery_purpose CHECK (purpose IN ('sign_in', 'phone_change', 'claim_guest')),
  ADD CONSTRAINT ck_otp_delivery_channel CHECK (channel IN ('TELEGRAM', 'SMS')),
  ADD CONSTRAINT ck_otp_delivery_status CHECK (status IN ('REQUESTED', 'NOT_REACHABLE', 'SENT', 'DELIVERED', 'READ',
                                                          'EXPIRED', 'REVOKED', 'FAILED', 'VERIFIED')),
  ADD CONSTRAINT ck_otp_delivery_telegram_only CHECK (channel = 'TELEGRAM' OR telegram_request_id IS NULL),
  -- an HMAC-SHA256, never a phone number
  ADD CONSTRAINT ck_otp_delivery_phone_hash CHECK (octet_length(phone_hash) = 32);

ALTER TABLE "device_token"
  ADD CONSTRAINT ck_device_token_platform CHECK (platform IN ('android', 'ios', 'web'));

ALTER TABLE "notification"
  ADD CONSTRAINT ck_notification_channel CHECK (channel IN ('PUSH', 'SMS')),
  ADD CONSTRAINT ck_notification_status CHECK (status IN ('PENDING', 'SENT', 'SKIPPED', 'FAILED'));
