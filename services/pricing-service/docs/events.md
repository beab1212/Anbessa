# pricing-service events

## Kafka

None. pricing-service has no Kafka client (no `kafkajs` in `package.json`), no outbox, and produces and consumes no topics. Its `docker-compose.dev.yml` starts Redpanda anyway; the service does not use it.

Quote creation and lookup are not published as events. No audit events are written.

## Redis pub/sub (subscribed)

| Channel | Publisher | Effect | Source |
|---|---|---|---|
| `settings:changed` | platform-service | reload `GET /internal/settings/snapshot` (new fares, `quote.ttlSeconds`, vehicle types) | `createSettingsClient` in `src/container.ts` |
| `authz:changed` | auth-service | reload `GET /internal/authz/snapshot` | `createAuthzSync` in `src/server.ts` |

Both also poll every 30 s, so a lost message delays a change by at most about 30 s. The subscriptions use a duplicate of the main Redis connection.

## Kafka (workflow 15, added)

This supersedes "Kafka: None" above. pricing-service now has a transactional outbox (relay with `FOR UPDATE SKIP LOCKED`, idempotent producer) and a consumer group `pricing-service`. Envelope `{ eventId (UUID v7), version: 1, at, …payload }`; payload types in `libs/shared-types/src/events.ts` (`PRICING_TOPICS`).

### Published

| Topic | Key | When | Payload |
|---|---|---|---|
| `pricing.rule_scheduled` | cityId | a fare change is approved | `FareRuleScheduledEvent`: `ruleId, changeRequestId, cityId, vehicleType, validFrom, baseMinor, perKmMinor, perMinMinor, minFareMinor, waitingPerMinMinor, proposedBy, approvedBy, emergency` |
| `pricing.rule_activated` | cityId | the rule's `validFrom` passed (sweep), or at approval for an emergency change | `ruleId, cityId, vehicleType, validFrom` |
| `pricing.zone_changed` | cityId | zone created, edited or archived | `zoneId, cityId, kind, change: CREATED \| UPDATED \| ARCHIVED, zoneVersion, byUserId` |
| `promo.activated` | promoId | DRAFT → ACTIVE | `promoId, code, cityIds, budgetMinor, startsAt, endsAt, fundedBy, byUserId` |
| `promo.redeemed` | tripId | `trip.completed` closed a booked reservation | `promoId, code, redemptionId, tripId, riderId, cityId, quoteId, fareMinor, discountMinor, currency, fundedBy` |
| `promo.exhausted` | promoId | budget or total redemptions reached | `promoId, code, spentMinor, budgetMinor, redemptionCount` |
| `audit.recorded` | actorId or `system` | every staff action (zones, fare propose/approve/reject/withdraw, promo create/edit/activate/pause/resume/archive) and automatic expiries | `{ actorId, action, resource: { type, id }, outcome: EXECUTED \| PENDING_APPROVAL \| REJECTED, reason, service: "pricing-service" }` |

No consumer reads `pricing.*` or `promo.*` yet. payment-service books the promo expense from `trip.completed`'s `promoDiscountMinor` instead of `promo.redeemed` (Payment.md §6.4); notification-service could tell drivers about `pricing.rule_scheduled` (design step 6, not built).

### Consumed

| Topic | Producer | Effect |
|---|---|---|
| `trip.completed` | trip-service | redeem the rider's booked promo reservation (idempotent per trip). trip-service sends `quoteId` and `promoDiscountMinor` (the discount it applied; payment-service charges the rider `fareMinor −` it and books it to `PROMO_EXPENSE`); an event without `quoteId` falls back to the rider's latest BOOKED reservation in the city and vehicle type |
| `trip.cancelled` | trip-service | release the booked reservation (by `quoteId`, which trip-service sends; else the rider's latest BOOKED in the city) |

Invalid JSON or payloads are logged and skipped; database errors are rethrown (kafkajs retries). In non-production the consumer creates missing topics.
