-- Staff trip search, fleet trip lists and the daily trip report (GET /api/trips/search,
-- /api/trips/org/:orgId?role=fleet, /api/trips/reports/daily). All keyed on created_at, newest first.

-- a city's trips by request time: search by city and the per-day report
CREATE INDEX "ix_trip_city_recent" ON "trip"("city_id", "created_at" DESC);

-- trips driven in a fleet's vehicles (beneficiary = the fleet organisation)
CREATE INDEX ix_trip_fleet_recent ON "trip" (beneficiary_id, created_at DESC) WHERE vehicle_owner_type = 'ORGANIZATION';

-- trips of one vehicle (staff search by vehicle)
CREATE INDEX ix_trip_vehicle_recent ON "trip" (vehicle_id, created_at DESC) WHERE vehicle_id IS NOT NULL;
