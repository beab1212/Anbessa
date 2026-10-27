-- Saved places: Home, Work and others per rider.
CREATE TABLE "saved_place" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "saved_place_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "saved_place_user_id_created_at_idx" ON "saved_place"("user_id", "created_at");

ALTER TABLE "saved_place" ADD CONSTRAINT ck_saved_place_label CHECK (label IN ('HOME','WORK','OTHER'));

-- one Home and one Work per person; any number of others
CREATE UNIQUE INDEX "saved_place_user_home_work_uniq" ON "saved_place"("user_id", "label") WHERE label IN ('HOME','WORK');
