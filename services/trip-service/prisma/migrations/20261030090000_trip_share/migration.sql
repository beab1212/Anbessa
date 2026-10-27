-- Share-my-trip links: a random token a rider sends to someone, who sees the trip live without
-- signing in until it ends (plus 30 minutes) or the rider stops sharing.
CREATE TABLE "trip_share" (
    "token" TEXT NOT NULL,
    "trip_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "trip_share_pkey" PRIMARY KEY ("token")
);

CREATE INDEX "trip_share_trip_id_idx" ON "trip_share"("trip_id");

ALTER TABLE "trip_share" ADD CONSTRAINT "trip_share_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
