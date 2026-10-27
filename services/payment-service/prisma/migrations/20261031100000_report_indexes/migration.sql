-- The finance daily report (GET /api/payments/reports/daily): per-day sums over settlements,
-- captured payments, refunds and top-ups, everywhere or for one city.

CREATE INDEX "ix_trip_settlement_day" ON "trip_settlement"("settled_at");
CREATE INDEX "ix_trip_settlement_city_day" ON "trip_settlement"("city_id", "settled_at");
CREATE INDEX "ix_payment_completed" ON "payment"("completed_at");
CREATE INDEX "ix_refund_completed" ON "refund"("status", "completed_at");
CREATE INDEX "ix_top_up_completed" ON "top_up"("status", "completed_at");
