# Code audit from the reference-docs pass (2026-10-27)

Writing the reference docs (`*/docs/`) meant reading every service, app, library and the infra end to end. This page collects what that turned up: bugs and gaps in the code, and places where the design docs disagree with it. Each item names where to look. Items marked **fixed** were fixed right after the audit; the commit history has the details.

Severity: **P0** blocks production or loses money / signs users out; **P1** wrong behaviour users or staff will hit; **P2** robustness, hygiene, dead code.

## Production readiness

- **P0** payment-service can't start in production: `GATEWAY_MODE` is `z.enum(["simulated"])` and `simulated` is refused when `NODE_ENV=production` (`services/payment-service/src/config`). Needs a real provider integration before launch.
- **P0** `.github/` is in `.gitignore`, so the CI workflows never reach GitHub. `deploy.yml` builds 8 of 11 services (not fleet, platform, audit) and never the web app; deploy jobs have no cluster credentials and never set the image tag (manifests use `:latest`, CI pushes `:<sha>`).
- **P0** Kubernetes manifests exist for trip-service only (no other service, Kong, realtime-gateway, mapping stack). Kustomize `namePrefix` renames the Service but not the configMap/secret, and every `*_INTERNAL_URL` uses unprefixed names. The HPA's `minReplicas: 2` overrides the staging patch (1) and can scale production's 4 down to 2.
- **P0** `infra/terraform/modules/` is empty: `terraform init` / `make setup-infra` fail. State key is hard-coded to production. No S3 bucket for fleet documents, no networking or IAM.
- **P1** Probes and Docker `HEALTHCHECK` use `/health` (always 200); `/health/ready` is the real check. Readiness checks Postgres only in most services, not Redis/Kafka.
- **P1** Kafka topics are only auto-created outside production; nothing creates them up front. No dead-letter topics anywhere (Database.md §11 lists `*.dlq`); a message that always fails blocks its partition.
- **P1** Migrations can't run from most images (Prisma CLI is a devDependency; audit-service doesn't copy `prisma/`). They must run as a separate step.
- **P1** `make stack-up` is unlikely to boot: containers read only the root `.env`, which points DB/Redis/Kafka at `localhost` and lacks `INTERNAL_SERVICE_TOKEN`, `BETTER_AUTH_SECRET`, `PII_*`, webhook secrets. auth-service points at `ride_app`. No healthchecks; notification-service publishes no port.
- **P1** Nothing builds or hosts the web app (no image, manifest, Terraform or Kong route).
- **P1** trip-service needs `SHARE_BASE_URL` in production (refuses the localhost default).
- **P2** No metrics or tracing anywhere; logging is pino JSON. Root `.env.example` lists `STRIPE_*`, `FCM_SERVER_KEY`, `TILESERVER_URL`, which nothing reads. `make db-seed` is a TODO stub but `make infra-reset` calls it. Nothing provides tiles for TileServer GL.

## Sign-outs and outages

- **P0 — fixed** realtime-gateway turned a Redis error during the deny / permission-version check into `unauthorized`, and the phone app signs out after 3 refusals. Now token problems are refused as `unauthorized: <code>` and anything else as `unavailable` (logged), which the app doesn't count.
- **P0 — fixed** Phone app: an offline cold start was treated as signed out; now the splash says "You're offline" with a retry and the stored session is kept. A network failure while refreshing the token after a 401 no longer ends the session (`ApiClient._onAuthError`).
- **P1 — fixed** trip-service, fleet-service (and the others): if Redis was unreachable the `deny:`/`pv:` lookups threw and every authenticated route answered 500. The shared verifier now throws `TokenCheckUnavailable` and every service answers `503 auth_unavailable` with `retry-after`. Still fail-closed: whether to fail open (as auth-service itself does) is a security decision left open.
- **P1 — fixed** realtime-gateway's Kafka producer only retried the initial connect; it now reconnects after any disconnect. (Still `acks: 1`, not idempotent.)
- **P1** notification-service crashes at start if Kafka is unreachable (`consumer.start()` has no catch).
- **P2** Sockets outlive token expiry and role changes (only suspensions are rechecked, every 60 s). notification- and mapping-service don't check the deny list (suspended users' tokens work until expiry); audit-service only when `REDIS_URL` is set (optional in production).

## Money (payment-service)

- **P1 — fixed** A corporate trip event with no `billingOrgId` settled as cash (charging the driver commission on money they never collected). Such an event is now invalid: logged and skipped. trip-service never produces one.
- **P1** Cash cancellation fees become a rider receivable with no payment row; nothing can collect them.
- **P1 — fixed** `GET /api/payments/balances/me?open=false` created the account (`z.coerce.boolean()` reads `"false"` as true); same in platform-service `?refresh=false`. Both now use a strict flag.
- **P1** Charge retries against an unreachable provider never count an attempt and repeat every 30 s forever. A simulated refund whose call failed stays `PROCESSING` forever.
- **P1** The weekly payout batch is created on the first 10-minute tick of an Addis Monday; if the service is down all Monday, that week is skipped.
- **P2** Permission oddities: "check with provider" needs `commission:collect`; `GET /top-ups` isn't city-filtered; `payment:read @ ORG` can never match. Office-cash duplicate receipts are checked in code only (no unique index). Kong caps the whole service at 120/min while webhooks allow 600/min. Outbox, inbox and webhook-event rows are never purged. `seed:dev` points at a missing file.

## Trips (trip-service)

- **P1** A trip stays `requested` forever if Redis loses `match:due` or the process dies between commit and `matching.start()`; nothing re-enqueues it.
- **P1 — fixed** A quote could book several trips until it expired. Now a quote backing a trip that wasn't cancelled answers `400 quote_used`.
- **P1** Without the Kafka relay, location-service never marks matched drivers busy; they keep getting offers and accepting fails with `driver_busy`.
- **P1** Dispatcher assignment leaves the open offer's driver un-notified. Coordinator cancellations are charged as rider cancellations; any caller may send `STAFF_DECISION`. Bookers can't cancel (without an ORG/CITY grant), rate, or see `/active`.
- **P2** Saved-places cap isn't applied to Home/Work; concurrent `PUT .../home` likely 500s. On-behalf `riderUserId` isn't checked against auth. The idempotency purge first runs 24 h after start. `match:{trip}:declined` has no TTL. `/stats` "today" hard-codes UTC+3 and `active` isn't limited to today.

## Drivers, vehicles, documents (fleet-service)

- **P1** With `STORAGE=s3` the upload's SHA-256 is never verified on confirm (only the size). Upload ticket lives 15 min, the URL 5 min.
- **P1 — fixed** Suspending a driver didn't remove the DRIVER role and reinstating never called auth. Both now call auth-service inside the transaction, and a 404 from auth is an error (`409 user_not_found`) instead of being swallowed.
- **P1** Replacement documents of an ACTIVE driver / VERIFIED vehicle supersede the approved one without re-review; a pending replacement isn't seen by the expiry job.
- **P2** Expiry job and reminders run in every replica with no lock; the "last reminder day" is in memory. Staff get 403 on `GET /documents` for a subject without documents (city scope from the newest document). Cities and vehicle types come from hard-coded lists. Authorisation `validUntil` only checked at go-online. No manual vehicle suspend route.

## Location and realtime

- **P1** Nearby search judges freshness by the phone's timestamp: a phone clock > 20 s slow silently drops the driver from matching.
- **P1** If `trip.matched` is processed after the same trip's `trip.completed` (separate topics, no ordering), the driver stays `on_trip`.
- **P2** Bad-format `cityId`/`vehicleType` give 500, not 400. `trip:unsubscribe` never acks. The ping throttle counts only accepted pings. `busy` geo sets are written but never read. `driver.location` has no event envelope.

## Platform, pricing, mapping

- **P1** Cities live in two places: pricing (`cityAt`) and mapping search use `CITIES` from shared-location, not the admin city table. A city added in the dashboard gets `outside_service_area` / `unknown city`.
- **P1** A new vehicle type without fares makes `POST /api/pricing/estimates` (no `vehicleTypes`) fail with `unknown_vehicle_type`.
- **P1 — fixed** Announcement changes don't bump the client-config version, so the phone app didn't see them until restart. The app now also compares the announcement list (announcements start and end on a schedule, so a version bump alone wouldn't cover it).
- **P2** `platform.settings_changed` has no consumer and isn't in shared-types. Duplicate pending change requests can race (no unique index). A city save writes to auth first with no compensation. OSRM "no route" on `/internal/table` and other 4xx answer 503; pricing turns mapping's 404 into 503. Quotes are written one by one (partial writes on error).

## Notifications and audit

- **P1 — fixed** `smsFallbackRate` was always null (`channel === "telegram"` vs stored `"TELEGRAM"`).
- **P1** Telegram-only channel config: resending while the previous code is undelivered returns `400 no delivery channel available`.
- **P2** A crash after provider acceptance re-sends on redelivery. Partial push delivery is marked `SENT`. `notification` and `device_token` never purged. `TELEGRAM_GATEWAY_URL` missing from `.env.example`.
- **P2** Audit: partition maintenance needs DDL rights the recommended production role lacks; early rows in the default partition block that month's partition (trip-service's `trip_event` too). The write-once trigger doesn't block `TRUNCATE`/`DETACH`; no hash chain. CSV export has no formula-injection guard. Invalid audit events are dropped with a log line.

## Auth

- **P1** Several staff routes (`/users`, `/users/:id`, `/stats`, the approvals inbox) check permissions without a city, so city-scoped holders get 403.
- **P1** Nothing lifts a timed suspension when `ban_expires` passes; token minting stays refused until reinstate.
- **P2** The general rate limit (300/min per IP) is in-memory per replica and covers `/internal/*` (fleet too). `role:grant` duplicate-pending check races. Permission-matrix seeding at start isn't locked. `outbox.attempts` is never written; the relay has no back-off or DLQ and no shutdown flush. `AUTH_INTERNAL_URL` is parsed but unused. `/internal/organizations/:id/members/:userId` returns the unmasked phone.

## Apps

- **P1** Phone: riders call `GET /api/fleet/drivers/me` on every start. `anbessa://trip/<id>` probably doesn't route (`trip` is the URI host). The billing-organisation setting is ignored by booking (first org in the JWT is used). Notification toggles (`notif_trip/promo/sound`) are stored and never read. The emergency contact isn't used by SOS. Release builds are signed with debug keys; iOS and Android bundle ids differ; no Google Maps / Waze query schemes declared; the offer notification asks for a full-screen intent the manifest doesn't declare.
- **P2** Phone: the rider's own dot never moves after the first fix; the rider cancel fee shown is hard-coded (30 ETB); mode isn't cleared on sign-out; unused providers and API wrappers (see `apps/phone-app/docs`).
- **P1** Web: `/partner/org/:orgId/book` has no guard; `/staff/phone` opens even with `phoneBooking` off. The public `/t/:token` page asked for staff and partner tokens on load (**fixed**). `GATEWAY_URL` is overridden by the per-service URLs in the standard `.env`.

## Events (from `libs/shared-types/docs/event-catalog.md`)

About 25 of 47 topics are produced and never consumed, including: `driver.location`, the `driver.*` lifecycle topics, all `vehicle.*` topics, `document.expiring` (fleet's README says notification sends the reminder; it doesn't), `trip.requested`, `trip.driver_en_route`, `trip.driver_arrived`, `trip.started`, `payment.captured`, `refund.failed`, `user.*`, `role.revoked`, `org.*`. No topic is consumed without a producer.

## Design docs that disagree with the code

- `docs/architecture/overview.md`: says payment isn't built and fleet doesn't exist (known-gaps); lists consumers that don't exist (notification for `trip.matched`, `payment.captured`, `refund.failed`; audit for `role.*`; trip-service for `user.created`); says auth has no outbox; shows a `jwt` plugin on `/api/trips` and 30/min on `/api/auth` (kong.yml: no jwt, 60/min); PostGIS fallback distance (code: haversine); mTLS for OTP (code: bearer token).
- `Auth.md`: suspension sets `accountStatus = SUSPENDED` (code: `banned`); `__Host-` cookies (code: `anb-admin` prefix); `authz.require` (code: `authorize`); OTP channels env-only (code: live settings); status table says services don't verify tokens yet.
- `Role.md`: approvals go through APPROVED/FAILED (code: PENDING → EXECUTED); `SUPER_ADMIN` lacks `report:read` (code grants it); `vehicle:transfer` needs approval (not in `APPROVAL_PERMISSIONS`); a `SERVICE` role (doesn't exist); `user.suspended` drives denial (code: Redis keys); status line says no audit service.
- `Database.md`: `driver.location` consumers, `driver.state` and `*.dlq` topics, `acks=all`, pg_partman, a `template` table, `seen` scores in seconds — none match.
- Workflows 01, 02, 03, 04, 05, 06, 08, 09: event names, endpoints, limits and timings differ in many places; each service's `docs/` lists them.
- `docs/testing/README.md`: says the web app has no tests (it has 18) and names phone-app files that don't exist.
- `docs/development/README.md`: ports 3000–3007 (now 3000–3011); Kong "only in stack-up" (also `dev-gateway`); `GATEWAY_URL` instructions don't work with the standard `.env`.
- Four links in `docs/design` point to a `learned/` folder that isn't in the repo.
