-- the driver's earnings summary reads their settlements by date
CREATE INDEX "trip_settlement_driver_id_settled_at_idx" ON "trip_settlement"("driver_id", "settled_at" DESC);
