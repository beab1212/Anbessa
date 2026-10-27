-- Rider promo codes (workflow 15, Payment.md §6.4): a trip's promo discount is paid by the platform
-- (PROMO_EXPENSE:<city>); the rider pays fare − discount and the beneficiary still earns on the full
-- fare. The settlement keeps the discount so earnings and reports can tell what the rider paid.
ALTER TABLE "trip_settlement" ADD COLUMN "promo_discount_minor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "trip_settlement" ADD CONSTRAINT ck_trip_settlement_promo CHECK (promo_discount_minor >= 0 AND promo_discount_minor <= fare_minor);
