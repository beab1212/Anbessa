# pricing-service data model

## Database

None. pricing-service has no Prisma schema and no migrations. It is not in the Makefile's `PRISMA_SERVICES`. (`docker-compose.dev.yml` defines a Postgres container under the `db` profile, so it is not started by default.)

## Redis keys

| Key | Type | TTL | Written by | Read by | Purpose |
|---|---|---|---|---|---|
| `quote:<id>` (id = `q_<uuid>`) | string (JSON `Quote`) | `quote.ttlSeconds` at estimate time (default 600 s, 60–3600) | pricing-service `SET … EX` | pricing-service `GET` (for `/internal/quotes/:id`) | the quote trip-service books with |
| `deny:<userId>` | string | set by auth-service | auth-service | pricing-service `EXISTS` | refuse tokens of suspended users |
| `pv:<userId>` | string (integer) | set by auth-service | auth-service | pricing-service `GET` | refuse tokens issued before a role change |
| `settings:changed` | channel | — | platform-service | pricing-service (SUBSCRIBE) | reload settings |
| `authz:changed` | channel | — | auth-service | pricing-service (SUBSCRIBE) | reload the permission matrix |

`quote:<id>` is the only data the service owns. Losing Redis loses every open quote; riders then have to ask for a new estimate (trip-service gets 404 → no quote).

trip-service's development stand-in (`PRICING=builtin`) uses its own key `devquote:<id>` in `services/trip-service/src/quotes.ts`; pricing-service does not read it.

## In-memory state

| What | Source | Lifetime |
|---|---|---|
| Settings snapshot (fares, `quote.ttlSeconds`, vehicle types) | `createSettingsClient` | replaced when the version changes |
| Permission matrix | `createAuthzSync` | replaced on change |

## Postgres (workflow 15, added)

This supersedes "Database: None" above. `prisma/schema.prisma`, migration `20261101090000_init`. Database `pricing_service` (tests: `pricing_service_test`). In the Makefile's `PRISMA_SERVICES`.

| Table | Purpose | Key constraints |
|---|---|---|
| `zone` | polygon per city: `kind` (`SERVICE_AREA`, `NO_PICKUP`, `AIRPORT`, `SURGE`), `polygon` JSONB ring of `[lng, lat]`, `fee_minor`, `surge_multiplier`, `version`, `archived_at` | CHECK fee 0–1 000 000, surge 1–3, polygon array of 4–500 points; partial index on live zones per city |
| `fare_change_request` | proposed card (5 amounts), `valid_from` (null = emergency, on approval), `emergency`, `reason`, `impact` JSONB, `status` (`PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`, `EXPIRED`), `maker_id`, `checker_id`, `decision_reason`, `expires_at` (+7 days) | CHECK amounts 0–1 000 000; `emergency OR valid_from IS NOT NULL`; `decided_at` set exactly when not PENDING; **unique partial index: one PENDING per (city, vehicle type)** |
| `fare_rule` | approved card version: city, vehicle type, 5 amounts, `valid_from`, `change_request_id` (unique), `proposed_by`, `approved_by`, `activated_at` (set by the sweep / emergency approval) | unique `(city_id, vehicle_type, valid_from)`; never updated except `activated_at`, never deleted |
| `promo` | code (unique, `^[A-Z0-9_-]{3,32}$`), type and value, `max_discount_minor`, `city_ids[]`, `vehicle_types[]` (empty = all), window, `per_user_limit`, `max_redemptions`, `budget_minor`, `spent_minor`, `redemption_count`, `funded_by`, `status`, creator / activator | CHECK value matches type, `ends_at > starts_at`, limits positive |
| `promo_reservation` | discount promised on one quote: `quote_id` (unique), user, city, vehicle type, fare, discount, `status` (`HELD`, `BOOKED`, `REDEEMED`, `RELEASED`, `EXPIRED`), `trip_id`, `booked_at`, `expires_at` | CHECK `0 < discount ≤ fare`; partial index on open ones |
| `promo_redemption` | one redeemed discount: promo, reservation (unique), `trip_id` (unique), user, city, fare, discount, `redeemed_at` | CHECK `0 ≤ discount ≤ fare` |
| `idempotency_key` | Idempotency-Key results, purged after 24 h | PK `(user_id, key)` |
| `outbox` | events waiting for the relay | partial index on unpublished |

Money is integer santim (`INTEGER`; budgets up to 100 M birr). The quote itself stays in Redis (`quote:<id>`) and now carries `fareRuleId`, `zoneIds`, `discountMinor`, `payableMinor` and `promo`.

New Redis channel: `pricing:catalog_changed` (published by pricing-service after an approval, an activation or a zone change; every replica invalidates its catalog).
