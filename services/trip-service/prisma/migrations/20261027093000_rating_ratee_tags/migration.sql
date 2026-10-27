-- Ratings: who was rated (for averages) and the tags ticked.
ALTER TABLE "trip_rating" ADD COLUMN "ratee_user_id" UUID;
ALTER TABLE "trip_rating" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- backfill from the trip: a rider's rating is of the driver, a driver's of the rider
UPDATE "trip_rating" r SET "ratee_user_id" = CASE WHEN r.by_role = 'RIDER' THEN t.driver_user_id ELSE t.rider_user_id END
  FROM "trip" t WHERE t.id = r.trip_id;

CREATE INDEX "trip_rating_ratee_user_id_idx" ON "trip_rating"("ratee_user_id");
