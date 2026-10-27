-- Promo codes (workflow 15): the discount on the booked quote is copied onto the trip. The rider
-- pays fare − discount (never below 0); the driver's earning is still computed on the full fare and
-- payment-service books the discount to PROMO_EXPENSE.
ALTER TABLE "trip" ADD COLUMN "promo_discount_minor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "trip" ADD COLUMN "promo_code" TEXT;
ALTER TABLE "trip" ADD CONSTRAINT "ck_trip_promo_discount" CHECK ("promo_discount_minor" >= 0 AND "promo_discount_minor" <= "fare_estimate_minor");
