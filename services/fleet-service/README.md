# fleet-service

Owns **drivers, vehicles, ownership, fleet authorisations, driving sessions and onboarding documents** ([Role.md §6](../../docs/design/Role.md#6-vehicle-ownership), [§13.1–13.2](../../docs/design/Role.md#131-owner-driver-onboarding-vehicle-owned-by-the-driver); workflows [02](../../docs/design/workflows/02-driver-onboarding.md) · [03](../../docs/design/workflows/03-fleet-onboarding.md) · [04](../../docs/design/workflows/04-driver-shift.md)). Database `fleet_service` ([Database.md §7.2](../../docs/design/Database.md#72-fleet-fleet-service)). Port 3008.

```
driver:   APPLIED → PENDING_REVIEW → ACTIVE ⇄ SUSPENDED          (changes requested: back to APPLIED)
vehicle:  DRAFT → PENDING_REVIEW → VERIFIED → SUSPENDED / RETIRED  (rejected: REJECTED → resubmit)
document: PENDING → APPROVED → EXPIRED                            (or REJECTED; a new upload SUPERSEDES)
```

## Quick start

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres, Redpanda
pnpm install
make -C ../.. secrets                             # .env, the PII/upload keys, the shared INTERNAL_SERVICE_TOKEN
pnpm prisma migrate dev                           # creates fleet_service
pnpm dev                                          # http://localhost:3008
pnpm seed:dev                                     # dev data (needs auth-service with DEV_LOGIN=on and its seed:dev)
```

It works with **auth-service** (tokens; `/internal/organizations/*` to check a fleet and its members; `/internal/drivers/:id/role` to add the DRIVER role on approval) and, through Kafka, **location-service** (`driver.online` / `driver.offline` put drivers on the map; `driver.connection_lost` ends their session).

## API

Everything is under `/api/fleet` (one Kong route). App (`aud=ride-app`) and staff (`aud=ride-admin`) tokens are both accepted; every action is checked with `libs/shared-authz`.

| Route | Who (permission @ scope) | What |
|---|---|---|
| `POST /drivers/apply` | `driver:apply @ SELF` | `{ fullName, licenseNumber, cityId }`. The licence is encrypted; a duplicate (or a banned driver's) licence is refused |
| `GET /drivers/me` · `POST /drivers/me/submit` | the applicant | Application, document checklist, own cars, fleet cars, session · send to review (all documents uploaded) |
| `GET /drivers/me/vehicles` | the driver | Cars they could go online with, each with `canDrive` and the reason if not |
| `GET /review/queue?cityId=` | `document:review` / `driver:read` / `vehicle:read @ CITY` | Drivers and vehicles waiting (oldest first), companies with documents to check, documents expiring in 30 days |
| `GET /drivers?cityId=&status=&q=` · `GET /drivers/:userId` | `driver:read @ CITY` (fleet owner: `@ ORG` with `?orgId=`) | Directory and one record. Licence masked unless `user:read_pii` (audited) or it's you |
| `POST /drivers/:userId/approve` | `driver:verify` + `driver:activate @ CITY` | All documents approved → `ACTIVE`, and auth-service adds `DRIVER` (in the same transaction: if auth is down, nothing changes) |
| `POST /drivers/:userId/request-changes` · `/suspend` · `/reinstate` | `driver:verify` · `driver:suspend` · `driver:reinstate @ CITY` | With a reason. Suspending ends the driving session |
| `POST /vehicles` | owner-driver: `vehicle:register @ SELF` (an applicant may too) · fleet: `vehicle:register @ ORG`, fleet verified | `{ ownerType, ownerOrgId?, plateNumber, vehicleType, make, model, year, color, seats }`. Plates are unique |
| `GET /vehicles?ownerOrgId=` / `?cityId=` / (mine) · `GET /vehicles/:id` | owner · `vehicle:read @ ORG` · `vehicle:read @ CITY` | List and one vehicle (documents, authorisations, session) |
| `POST /vehicles/:id/submit` · `/retire` | the owner | To review (documents uploaded) · retire (revokes drivers, ends the session) |
| `POST /vehicles/:id/approve` · `/reject` | `vehicle:verify @ CITY` | Documents approved (and, for a fleet car, the fleet verified) · rejected with a reason |
| `POST /vehicles/:id/authorizations` · `DELETE …/:driverUserId` | `vehicle:authorize_driver @ ORG` | Give a fleet car to a member with `fleet_driver` (optional `validUntil`) · take it away (ends their session in it) |
| `GET /organizations/:id/overview?members=` | `vehicle:read @ ORG` | Fleet portal: cars with documents, drivers and sessions; the listed members' onboarding status |
| `POST /documents/upload-url` → PUT the file → `POST /documents` | the subject's owner (`document:upload`) | Pre-signed upload (5 min, JPEG/PNG/PDF ≤ 10 MB, SHA-256 announced), then confirm with `{ ticket, expiresAt? }`. Licence, insurance and inspection need their expiry date. A new upload replaces the previous one of the same kind |
| `GET /documents?subjectType=&subjectId=` · `GET /documents/:id/url` | owner · `document:read @ CITY` | Checklist and history · a 5-minute view URL. **Every staff view is audited** |
| `POST /documents/:id/review` | `document:review @ CITY` | `{ decision: APPROVE \| REJECT, reason?, expiresAt? }` |
| `POST /sessions` · `GET` / `DELETE /sessions/current` | the driver | Go online with a vehicle (`Idempotency-Key`), checked against [Role.md §6](../../docs/design/Role.md#going-online-which-vehicle-is-allowed): driver active and licence valid, vehicle verified, own car (V6) or fleet member with an authorisation (V7), not in use (V4/V5) · go offline |
| `GET /internal/drivers/:userId/session` | service token | The driver's current vehicle and beneficiary (for trip/payment) |

### How it works

- **Ownership rules in the database.** `ck_vehicle_single_owner` (V1) and the partial unique indexes `ux_session_vehicle_active` / `ux_session_driver_active` (V4, V5) settle races; the code's checks give the friendly message.
- **Events.** State changes and their events commit together (transactional outbox → Kafka): `driver.applied/submitted/activated/changes_requested/suspended/reinstated`, `vehicle.submitted/verified/rejected/suspended/retired/driver_authorized/driver_unauthorized`, `driver.online/offline`, `document.expiring`, `audit.recorded`. Payloads carry ids and facts, never licence numbers or files.
- **Expiry.** Hourly: approved documents past their date become `EXPIRED`; an expired insurance or inspection suspends the vehicle, an expired licence suspends the driver, and the session ends (V10). Daily: `document.expiring` 30, 7 and 1 days ahead (notification-service sends the reminder). Renewing = upload the new document and submit again.
- **Licence numbers** are AES-256-GCM encrypted (`PII_ENCRYPTION_KEY`) with an HMAC blind index (`PII_BLIND_INDEX_KEY`) for duplicate detection.
- **Files** never pass through the database: `STORAGE=s3` gives pre-signed S3 URLs (AWS, or MinIO with `S3_ENDPOINT`); `STORAGE=local` keeps them in `STORAGE_DIR` and serves signed links at `/api/fleet/files/:ticket` (development only, refused in production).

### Not yet

- **Balance check when going online** (workflow 04 step 4): payment-service has no balances yet, so every driver may take cash (`cashAllowed: true`).
- **Vehicle ownership transfer** with a second onboarding officer (`vehicle:transfer`, maker–checker).
- **Driver app screens**: the phone app doesn't call these endpoints yet; drivers are created with `seed:dev` (or curl).

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Watch mode |
| `pnpm test` | Unit tests: document rules, the going-online decision, crypto |
| `pnpm test:integration` | Against a throwaway `fleet_service_test` database (`make infra-up` first): application, upload, review, approval, fleet cars, sessions, expiry, suspension |
| `pnpm seed:dev` | Development data for the dev sign-in accounts: an applicant and their car waiting for review, an approved owner-driver, the dev fleet's cars and driver, company papers. Runs once (skips what exists); `NODE_ENV=development` only |
| `pnpm lint` / `pnpm typecheck` | |
