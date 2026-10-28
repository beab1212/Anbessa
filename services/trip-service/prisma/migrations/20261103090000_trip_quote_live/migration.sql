-- One live or finished trip per quote (security fix): booking checked first and inserted after, so
-- two parallel requests with the same quote could both create a trip, each carrying its promo
-- discount. A quote may be booked again only after its trip was cancelled (and then pricing serves
-- it without the discount). Partial, so cancelled trips and trips without a quote don't count.
-- A violation is answered 400 quote_used (trips/service.ts `uniqueViolation`).
CREATE UNIQUE INDEX ux_trip_quote_live ON "trip" (quote_id) WHERE quote_id IS NOT NULL AND status <> 'cancelled';
