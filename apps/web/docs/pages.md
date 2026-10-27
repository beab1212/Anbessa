# Pages

Every screen in the app: what it shows, who can open it, the API calls it makes and what you can do on it. "Guard" is the route check in [src/App.tsx](../src/App.tsx); "inline" checks are `allowed(...)` calls inside the page that show or hide actions. All `/staff/*` calls use the staff token, all `/partner/*` calls the partner token, unless noted. Method `GET` without a body and `POST` with one is the `api()` default ([src/lib/api.ts](../src/lib/api.ts)).

Endpoints are summarised across pages in [api-usage.md](api-usage.md).

## Contents

- [Sign-in and setup](#sign-in-and-setup): `/sign-in`, `/sign-in/staff`, `/sign-in/partner`, staff setup, dev sign-in
- [Public](#public): `/t/:token`
- [Staff: Today](#staff-today): board, live map, book by phone, find a trip
- [Staff: Onboarding](#staff-onboarding): review queue, drivers, vehicles, companies
- [Staff: Accounts](#staff-accounts): suspend, staff and roles
- [Staff: Money](#staff-money)
- [Staff: Administration](#staff-administration)
- [Partner portal](#partner-portal)
- [Shared components with their own API calls](#shared-components-with-their-own-api-calls)

---

## Sign-in and setup

### `/sign-in`: SignInChooser

[src/pages/SignIn.tsx](../src/pages/SignIn.tsx). Two links: "Anbessa staff" → `/sign-in/staff`, "Fleet or company" → `/sign-in/partner`. All sign-in pages sit on a non-interactive Addis Ababa `CityMap` backdrop. No API calls apart from the map style. It does not redirect a user who is already signed in.

### `/sign-in/staff`: StaffSignIn

| | |
|---|---|
| Shows | Work email + password, then a 6-digit authenticator code |
| Calls | `POST /api/admin-auth/sign-in/email` `{ email, password }`; if the answer has `twoFactorRedirect`, `POST /api/admin-auth/two-factor/verify-totp` `{ code }` |
| After | `refresh("staff")`, navigate to `/staff`. With no 2FA yet the token has a `setup` claim and the setup page takes over |

### `/sign-in/partner`: PartnerSignIn

| | |
|---|---|
| Shows | Ethiopian mobile number (validated by `toE164`), then a 6-digit code. Text says the code goes to Telegram first and by SMS after 20 s |
| Calls | `POST /api/auth/phone-number/send-otp` `{ phoneNumber }`; `POST /api/auth/phone-number/verify` `{ phoneNumber, code }`. "Send a new code" repeats send-otp |
| After | `refresh("partner")`, navigate to `/partner` |

### Staff setup: StaffSetup

[src/pages/staff/Setup.tsx](../src/pages/staff/Setup.tsx). Rendered by `StaffArea` for any `/staff/*` URL while the token has a `setup` claim.

| Step | Calls |
|---|---|
| Replace the temporary password (min 12 characters, if `setup.changePassword`) | `POST /api/admin-auth/change-password` `{ currentPassword, newPassword, revokeOtherSessions: true }`, then `refresh("staff")` |
| Enrol an authenticator | `POST /api/admin-auth/two-factor/enable` `{ password }` → `{ totpURI, backupCodes }`. The page draws a QR code with the `qrcode` package, shows the secret in groups of four and the backup codes once |
| Confirm the first code | `POST /api/admin-auth/two-factor/verify-totp` `{ code }`, `refresh("staff")`, navigate to `/staff` |

### Dev sign-in panel: DevSignIn

[src/dev/DevSignIn.tsx](../src/dev/DevSignIn.tsx). Lazy-loaded under the sign-in card only when `import.meta.env.DEV` is true; not in production builds. Tabs "Staff" and "Fleet and companies".

| Call | Purpose |
|---|---|
| `GET /api/dev/accounts` | The seeded accounts. Accounts with `app: "phone"` are hidden. If the call fails, the panel explains how to turn on `DEV_LOGIN` |
| `GET /api/dev/code?email=…` or `?phone=…` | The TOTP or OTP code a person would read |
| The normal sign-in calls above | Same flow as a person |

A 429 is turned into a hint to set `AUTH_RATE_LIMIT=off` in auth-service.

---

## Public

### `/t/:token`: SharedTrip

[src/pages/public/SharedTrip.tsx](../src/pages/public/SharedTrip.tsx). No sign-in and no `Shell`.

| | |
|---|---|
| Shows | Full map with the route (`RouteLine` from `routePolyline`), pickup (green) and drop-off pins, the car (`DriverMarker`); a card with a status headline, driver first name and photo (or initial), car colour/make/model and plate, pickup and destination names, and "Car position updated N s ago" or "Link ends HH:MM" |
| Calls | `GET /api/trips/shared/:token` via `http.get` with no `surface`, so no `Authorization` header |
| Live updates | Every 5 s while the status is not `completed`/`cancelled` and there is no error. Retries up to 2 times except on 404 |
| Errors | 404 → "This link has ended" (shared trips stop 30 minutes after the end or when the rider stops sharing). Other errors → "Can't load this trip" with "Try again" |

The map is created with `cityId="addis-ababa"` for its initial bounds, then fits the pickup, drop-off and car position once (`fitOnce`).

Note: like every page, it is inside `SessionProvider`, so loading it also calls `GET /api/admin-auth/token` and `GET /api/auth/token` (both answer 401 for a visitor).

---

## Staff: Today

### `/staff/board`: Board (Live board)

[src/pages/staff/Board.tsx](../src/pages/staff/Board.tsx). Guard: `trip:read` in any city. Full-bleed map workspace.

| | |
|---|---|
| Shows | Floating counts: finding a driver (red when any waited over 60 s), driver on the way, on a trip, free drivers. Map: free, non-stale drivers and a pickup pin per active trip (red when requested over a minute ago, else the status tone). Side panel: a card per active trip with status, waiting time, pickup address, vehicle type, payment method, channel, estimated fare |
| Calls | `GET /api/trips/board?cityId=` every 8 s; `GET /api/locations/cities/:cityId/drivers` every 5 s, only with `location:read_live` in the city |
| Actions | Select a trip. **Assign driver** (`trip:assign` in the city, trip `requested`): a drawer lists the 5 closest free drivers of the same vehicle type by straight-line distance, or takes a pasted driver id → `POST /api/trips/:id/assign` `{ driverId }` with an `Idempotency-Key`. **Cancel** (`trip:cancel`, status `requested`/`matched`/`en_route`, browser `confirm`) → `POST /api/trips/:id/cancel` `{ reason: "STAFF_DECISION" }` with an `Idempotency-Key`. **Details** → `/staff/trips/:id` |
| After an action | Invalidates `board` and `drivers`; the changed trip card flashes once |

City: `CityPicker` over the cities where the user has `trip:read`.

### `/staff/drivers`: Drivers (Live map)

[src/pages/staff/Drivers.tsx](../src/pages/staff/Drivers.tsx). Guard: `location:read_live` in any city.

| | |
|---|---|
| Shows | Counts of free, on a trip and silent drivers (silent is highlighted when non-zero). Map of drivers with a position, rotated by heading. Table: short driver id, vehicle type and id, state, time of last ping. Filter chips All / Free / On a trip / Silent |
| Calls | `GET /api/locations/cities/:cityId/drivers` every 5 s |
| Actions | Select a driver (map zooms to it). No writes |

"Silent" is the `stale` flag from location-service; the footer says it means no ping for 20 s.

### `/staff/phone`: PhoneBooking (Book by phone)

[src/pages/staff/PhoneBooking.tsx](../src/pages/staff/PhoneBooking.tsx). Guard: `trip:create_on_behalf` in any city. The sidebar item is hidden when client config has `features.phoneBooking === false`.

| Step | What happens | Calls |
|---|---|---|
| Caller | Type the caller's mobile, "Find caller" | `POST /api/identity/guests` `{ phoneNumber, cityId }` → `{ userId, created }` ("new caller, guest account created" or "known caller") |
| Route | Pickup and destination from `PlacePicker` or a tap on the map (fills pickup first, then destination); car type economy / comfort / minivan | `GET /api/maps/search` (PlacePicker); on a map tap `GET /api/maps/reverse?lat=&lng=` for a label, kept as coordinates if it fails |
| Fare | "Get the fare" | `POST /api/pricing/estimates` `{ pickup, dropoff, vehicleTypes: [type], pickupAddress, dropoffAddress }`; the first quote is shown with distance and time; a notice when `approximate` |
| Request | Payment cash or mobile money, "Request the ride" | `POST /api/trips` `{ quoteId, paymentMethod, riderUserId }` with one `Idempotency-Key` per booking |
| Done | A script to read to the caller, "Follow this trip" → `/staff/trips/:id`, "Next caller" resets the form and the key | |

### `/staff/trips` and `/staff/trips/:tripId`: TripDetail (Find a trip)

[src/pages/staff/TripDetail.tsx](../src/pages/staff/TripDetail.tsx). Guard: `trip:read` in any city.

| | |
|---|---|
| Shows | A trip-id box (36 characters). With an id: short id, status, flags, city and time; a boxed map with pickup, drop-off, the dashed `TripLine` and the driver's live position while the trip is on the road; a timeline (requested, assigned, arrived, picked up, dropped off, cancelled); from/to/rider; a Money card (quoted fare, waiting fee, charged, cancellation fee and driver compensation, payment method, corporate billing) |
| Calls | `GET /api/trips/:id` every 8 s, no retry. While `matched`/`en_route`/`in_progress` and with `location:read_live`: `GET /api/locations/cities/:cityId/drivers` every 5 s, filtered to the trip's driver. For completed trips or trips with a cancellation fee: `GET /api/payments/trips/:tripId` every 10 s, no retry (payments and settlements: commission, VAT, driver's balance movement) |
| Actions | **Cancel trip** (`trip:cancel` in the trip's city, status `requested`/`matched`/`en_route`) → `POST /api/trips/:id/cancel` `{ reason: "STAFF_DECISION" }` with an `Idempotency-Key`. A payment line opens the `PaymentDrawer` from the Rider payments page |

---

## Staff: Onboarding

### `/staff/review`: ReviewQueuePage

[src/pages/staff/Fleet.tsx](../src/pages/staff/Fleet.tsx). Guard: `document:review` in any city.

| | |
|---|---|
| Shows | Counts: drivers waiting, vehicles waiting, company documents, approved documents expiring within 30 days. Tabs Drivers / Vehicles / Companies with tables; rows waiting over 24 h are marked urgent |
| Calls | `GET /api/fleet/review/queue?cityId=` every 30 s; `GET /api/identity/organizations?cityId=` for company names when the user has `org:read` in the city |
| Actions | Click a row → driver record, vehicle record, or `/staff/onboarding?org=<id>` |

### `/staff/fleet/drivers`: DriverDirectory

Guard: `driver:read` in any city. Status chips (All, Applying, Waiting for review, Active, Suspended) and a search box (name or last 4 of the licence, sent from 2 characters). Calls `GET /api/fleet/drivers?cityId=&status=&q=`. Rows open `/staff/fleet/drivers/:userId`.

### `/staff/fleet/drivers/:userId`: DriverRecord

Guard: `driver:read` in any city.

| | |
|---|---|
| Shows | Name, status, licence, city, dates, the last review note; the document checklist; own and fleet vehicles; "Right now" (online session or offline) |
| Calls | `GET /api/fleet/drivers/:userId`; the checklist's document calls (see [shared components](#shared-components-with-their-own-api-calls)) |
| Actions (all `POST /api/fleet/drivers/:userId/<action>`) | `request-changes` `{ reason }` (`driver:verify`, status `PENDING_REVIEW`); `approve` (`driver:verify` to see it, `driver:activate` to enable it, and no missing documents); `suspend` `{ reason }` (`driver:suspend`, 10+ characters); `reinstate` `{ reason }` (`driver:reinstate`, 10+ characters). Document review needs `document:review` in the driver's city |

### `/staff/fleet/vehicles`: VehicleDirectory

Guard: `vehicle:read` in any city. Status chips (All, Waiting for review, Verified, Suspended, Rejected, Draft, Retired). Calls `GET /api/fleet/vehicles?cityId=&status=` and the organisation names query. Rows open `/staff/fleet/vehicles/:id`.

### `/staff/fleet/vehicles/:id`: VehicleRecord

Guard: `vehicle:read` in any city.

| | |
|---|---|
| Shows | Plate, status, car, type, seats, city; review note; a notice when suspended for an expired document; documents with the rule that the registration must name the owner; owner card; for company cars the drivers allowed; "Right now" |
| Calls | `GET /api/fleet/vehicles/:id`; organisation names; document calls |
| Actions | With `vehicle:verify` and status `PENDING_REVIEW`: `POST /api/fleet/vehicles/:id/reject` `{ reason }`, `POST /api/fleet/vehicles/:id/approve` (disabled while documents are missing) |

### `/staff/onboarding`: Onboarding (Companies)

[src/pages/staff/Onboarding.tsx](../src/pages/staff/Onboarding.tsx). Guard: `org:read` in any city.

| | |
|---|---|
| Shows | Tabs Waiting / Verified / Suspended; table of companies (name, legal name, kind fleet or company account, TIN, people, registered); waiting over 2 days is urgent. `?org=<id>` opens a drawer with the company's documents |
| Calls | `GET /api/identity/organizations?cityId=&status=`; when a drawer is open, `GET /api/identity/organizations?cityId=` to find it; documents for `ORGANIZATION` |
| Actions | **Verify** (`org:verify`, status `PENDING`, disabled until the required documents are approved) → `POST /api/identity/organizations/:id/verify`. **Suspend** (`org:suspend`, reason via browser `prompt`, 10+ characters) → `POST /api/identity/organizations/:id/suspend` `{ reason }`. Document review with `document:review` |

---

## Staff: Accounts

### `/staff/safety`: Safety (Suspend)

[src/pages/staff/Safety.tsx](../src/pages/staff/Safety.tsx). Guard: `user:suspend` in any city.

Form: user id (UUID format), city handling the case (select only if more than one), reason (10+ characters). **Suspend** (with `confirm`) → `POST /api/identity/users/:userId/suspend` `{ reason, cityId }`. **Reinstate** → `POST /api/identity/users/:userId/reinstate` `{ reason, cityId }`.

### `/staff/people`: People (Staff and roles)

[src/pages/staff/People.tsx](../src/pages/staff/People.tsx). Guard: `role:request` or `role:approve` or `staff:manage`.

| | |
|---|---|
| Shows | Staff table: name (links to the user page), email, suspended pill, role chips, authenticator status, last sign-in. A notice for pending role requests; an access-review notice for staff with roles who have not signed in for over 30 days |
| Calls | `GET /api/identity/users?kind=staff&limit=100&q=` (search from 2 characters); `GET /api/identity/approvals?status=PENDING&action=role:grant` (with `role:request` or `role:approve`) |
| Actions | **New staff account** (`staff:manage`) → `POST /api/identity/staff-accounts` `{ name, email }`; the temporary password is shown once. **Ask for a role** (`role:request`) → `POST /api/identity/staff-role-requests` `{ userId, role, cityId?, reason }`; roles come from `grantableStaffRoles()`, city only for city-stored roles, reason 10+ characters. **Remove a role** (`staff:manage`, not on yourself) → `POST /api/identity/staff-roles/revoke` `{ userId, role, cityId?, reason }` |

---

## Staff: Money

### `/staff/money`: MoneyOverviewPage

[src/pages/money/Overview.tsx](../src/pages/money/Overview.tsx). Guard: `balance:read` or `report:read_finance`.

Shows last 7 days (fares settled, commission, VAT, trips by method), drivers and fleets (we owe them, they owe us, balance states), riders and companies (waiting for the payer, will be asked again, riders owe, companies owe), money at each provider, ledger integrity, open payout batches and a link to Money approvals when decisions wait. Calls `GET /api/payments/overview` every 30 s and, with `report:read_finance` or `system:read`, `GET /api/payments/ledger/integrity` every 5 min. Read-only.

### `/staff/money/balances`: BalancesPage

[src/pages/money/Balances.tsx](../src/pages/money/Balances.tsx). Guard: `balance:read` in any city.

Chips by state (OK, Warning, Cash paused, Blocked) and by type (Owner-drivers, Fleets), search from 3 characters, pages of 50. Calls `GET /api/payments/balances?limit=50&offset=&state=&type=&q=`. Rows open `/staff/money/balances/:accountId`. **Record cash or a bank transfer** (`topup:record_cash`) opens `RecordCashDrawer` with a reference code field.

### `/staff/money/balances/:accountId`: BalancePage

Guard: `balance:read` in any city. Calls `GET /api/payments/balances/:accountId` every 15 s and renders `BalancePanel` with `recordCash` when the user has `topup:record_cash`.

`BalancePanel` ([src/pages/money/BalancePanel.tsx](../src/pages/money/BalancePanel.tsx)), shared with the partner Balance tab:

| Part | Calls |
|---|---|
| Balance, state, limits, dues (overdue dues as errors) | from the balance object |
| Statement (30 entries) | `GET /api/payments/balances/:accountId/statement?limit=30` |
| Top-ups | `GET /api/payments/balances/:accountId/top-ups`, every 3 s while one is `ACTION_REQUIRED` |
| **Top up** (owner only) | `GET /api/payments/methods` (mobile-money providers), then `POST /api/payments/balances/:accountId/top-ups` `{ amountMinor, provider }` with an `Idempotency-Key` |
| **Payout method** (owner only) | `PUT /api/payments/balances/:accountId/payout-method` `{ provider, destination }` |
| **Record cash or a bank transfer** (`recordCash`) | `POST /api/payments/top-ups/manual` `{ accountId \| referenceCode, channel: OFFICE_CASH \| BANK_TRANSFER, amountMinor, receiptNo, note? }` with an `Idempotency-Key`; it then waits under Money approvals |

On the staff page `owner` is never set, so staff do not see Top up or Payout method.

### `/staff/money/payments`: PaymentsPage (Rider payments)

[src/pages/money/Payments.tsx](../src/pages/money/Payments.tsx). Guard: `balance:read` or `refund:request` in any city, or `refund:approve`.

| | |
|---|---|
| Shows | Chips All / Waiting for the payer / Will ask again / Failed / Paid / Refunded; table of payments. A row opens `PaymentDrawer` |
| Calls | `GET /api/payments/payments?limit=100&status=` every 15 s; in the drawer `GET /api/payments/payments/:id` every 5 s |
| Actions | **Check with the provider** (`commission:collect`, status `ACTION_REQUIRED` or `PENDING`) → `POST /api/payments/payments/:id/reconcile`. **Ask for a refund** (`refund:request` in the payment's city, status `SUCCEEDED` or `PARTIALLY_REFUNDED`) → `POST /api/payments/payments/:id/refunds` `{ amountMinor, reason, driverAtFault }` with an `Idempotency-Key` |

### `/staff/money/approvals`: MoneyApprovalsPage

[src/pages/money/Approvals.tsx](../src/pages/money/Approvals.tsx). Guard: any `MONEY_APPROVERS` permission in any city.

| Card type | Loaded by | Decided by | Decision call |
|---|---|---|---|
| Payout batch | `GET /api/payments/payouts` (filtered to `PENDING_APPROVAL`), with `payout:prepare` or `payout:approve` | `payout:approve` | `POST /api/payments/payouts/:id/{approve\|reject}` |
| Cash / bank top-up | `GET /api/payments/top-ups?status=PENDING_APPROVAL`, with `topup:record_cash` or `topup:approve_cash` | `topup:approve_cash` | `POST /api/payments/top-ups/:id/{approve\|reject}` |
| Refund | `GET /api/payments/refunds?status=PENDING_APPROVAL` (always fetched) | `refund:approve` in the payment's city | `POST /api/payments/refunds/:id/{approve\|reject}` |
| Commission rule / balance limits | `GET /api/payments/rules/pending` (always fetched) | `commission_rule:approve` / `balance_policy:approve` in the city | `POST /api/payments/rules/changes/:id/{approve\|reject\|cancel}` |

Reject needs a reason (3+ characters) sent as `{ reason }`. The maker sees "waiting for someone else" and, for rule changes only, **Withdraw** (`cancel`). Success invalidates every `["money", …]` query. Staff ids are shown as names through `useStaffNames()` (`GET /api/identity/users?kind=staff&limit=100`, with `user:read_masked`).

### `/staff/money/payouts`: PayoutsPage

[src/pages/money/Payouts.tsx](../src/pages/money/Payouts.tsx). Guard: `payout:prepare` or `payout:approve`.

Chips for each batch; the selected batch shows its status, totals, reject reason and lines. Calls `GET /api/payments/payouts` every 15 s and `GET /api/payments/payouts/:id` every 3 s while `SENDING`, else 20 s. **Run settlement now** (`payout:prepare`) → `POST /api/payments/settlements/run`; if `created` is false the page says today's settlement already ran.

### `/staff/money/rules`: RulesPage (Commission and limits)

[src/pages/money/Rules.tsx](../src/pages/money/Rules.tsx). Guard: any `RULE_READERS` permission in any city.

City chips (`?city=`, default the first city). Shows commission rules in force and scheduled, the balance policy, defaults and pending changes. Calls `GET /api/payments/rules?cityId=`. **Propose a commission** (`commission_rule:propose` in the city) and **Propose limits** (`balance_policy:propose`) → `POST /api/payments/rules/changes` `{ kind: COMMISSION_RULE | BALANCE_POLICY, cityId, payload, reason }` (reason 5+ characters); approval happens under Money approvals.

### `/staff/money/providers`: ProvidersPage

[src/pages/money/Providers.tsx](../src/pages/money/Providers.tsx). Guard: `balance:read` or `report:read_finance` or `system:read`. Calls `GET /api/payments/gateways` every 15 s: providers and their mode, simulator settings when simulated, callbacks in the last 24 h by signature result, unprocessed callbacks, recent callbacks. Read-only.

---

## Staff: Administration

### `/staff/admin`: OverviewPage

[src/pages/admin/Overview.tsx](../src/pages/admin/Overview.tsx). Guard: `report:read` or `system:read`.

| Block | Call | Condition | Interval |
|---|---|---|---|
| Trips today | `GET /api/trips/stats` | `report:read` | 30 s |
| People | `GET /api/identity/stats` | `report:read` | 60 s |
| Drivers and vehicles | `GET /api/fleet/stats` | `report:read` | 60 s |
| System alerts | `GET /api/platform/system` | `system:read` | 15 s |
| Waiting approvals | `GET /api/identity/approvals?status=PENDING` | `role:approve` or `authz:approve` | none |
| Waiting setting changes | `GET /api/platform/settings/changes?status=PENDING` | `settings:read` | none |

Alerts come from `systemAlerts()` in System.tsx. Read-only.

### `/staff/admin/users`: UsersPage

[src/pages/admin/Users.tsx](../src/pages/admin/Users.tsx). Guard: `user:read_masked`. Kind chips (all, staff, rider, driver, partner, guest), status filter, search from 2 characters, cursor paging. Calls `GET /api/identity/users?q=&kind=&status=&cursor=`. Rows open the user page.

### `/staff/admin/users/:id`: UserPage

Guard: `user:read_masked`.

| | |
|---|---|
| Shows | Status, ban reason and expiry, setup state for staff, access-review notice after 30 idle days, roles, organisation memberships, sessions (surface, IP, user agent, times), and with `audit_log:read` two audit trails: what they did (`actorId`) and what was done to them (`resourceId`) |
| Calls | `GET /api/identity/users/:id`; `GET /api/audit/entries?actorId=…&limit=20` and `?resourceId=…&limit=20` |
| Actions (`POST /api/identity/users/:id/<path>` `{ reason, cityId? }`, reason 10+ characters) | **Sign out everywhere** `sessions/revoke` (`session:revoke`); **Reset sign-in** `reset-mfa` (staff target, `staff:manage`, not yourself; may answer `pendingApproval` or a `temporaryPassword` shown once); **Suspend** `suspend` and **Reinstate** `reinstate` (staff targets need `staff:manage`; others `user:suspend` / `user:reinstate` in a city, and a city is sent) |

### `/staff/admin/roles`: RolesPage

[src/pages/admin/Roles.tsx](../src/pages/admin/Roles.tsx). Guard: `authz:read`.

| | |
|---|---|
| Shows | Matrix version; pending `authz:change` approvals; tab **Edit a role** (roles grouped Staff / Riders and partners / Custom, permission grid with scope letters S/O/C/G limited per role kind) and tab **Whole matrix** |
| Calls | `GET /api/identity/authz`; `GET /api/identity/approvals?status=PENDING&action=authz:change`; while editing, `POST /api/identity/authz/preview` `{ roleCode, set }` → `{ problems }` (guardrail check) |
| Actions (`authz:propose`; a role with a pending change cannot be edited) | Propose changes → `POST /api/identity/authz/changes` `{ roleCode, set, reason }`; archive a role → same endpoint with `{ roleCode, set: [], archive: true, reason }`; **New custom role** → same endpoint with `{ create: { label, description?, storage: city \| global }, set, reason }` |

### `/staff/admin/approvals`: ApprovalsPage

[src/pages/admin/Approvals.tsx](../src/pages/admin/Approvals.tsx). Guard: any `APPROVERS` permission.

Status tabs PENDING / EXECUTED / REJECTED / EXPIRED / CANCELLED. Merges identity approvals (role grants, permission changes, super-admin sign-in resets) and setting changes, sorted by creation time.

| Source | Load | Decide |
|---|---|---|
| auth-service | `GET /api/identity/approvals?status=` (with any of `role:request`, `role:approve`, `authz:propose`, `authz:approve`, `staff:manage`) | `POST /api/identity/approvals/:id/{approve\|reject\|cancel}`; approving a sign-in reset can return a `temporaryPassword`, shown once |
| platform-service | `GET /api/platform/settings/changes?status=` and `GET /api/platform/settings` for labels (with `settings:read`) | `POST /api/platform/settings/changes/:id/{approve\|reject\|cancel}` |

The maker sees Withdraw instead of Approve/Reject. Approving `maintenance.newTrips = true` shows a warning that all new trip requests pause.

### `/staff/admin/settings`: SettingsPage

[src/pages/admin/Settings.tsx](../src/pages/admin/Settings.tsx). Guard: `settings:read`. Group tabs from the server; each setting shows its global value, city overrides and pending changes. Calls `GET /api/platform/settings`. With `settings:propose`, **change** → `PUT /api/platform/settings/:key` `{ value, cityId, reason }` (reason 5+ characters; `value: null` resets to the default). Sensitive (★) settings answer `PENDING_APPROVAL`. The history icon opens `GET /api/platform/settings/history?key=`.

### `/staff/admin/cities`: CitiesPage

[src/pages/admin/Cities.tsx](../src/pages/admin/Cities.tsx). Guard: `settings:read`. Tables of cities (id, name, time zone, enabled, bounding box) and vehicle types (code, name, seats, enabled, cities). Calls `GET /api/platform/cities`, `GET /api/platform/vehicle-types`. With `city:manage`: add a city `POST /api/platform/cities`, edit `PUT /api/platform/cities/:id`; add or edit a vehicle type `PUT /api/platform/vehicle-types/:code` (the same PUT for both).

### `/staff/admin/announcements`: AnnouncementsPage

[src/pages/admin/Announcements.tsx](../src/pages/admin/Announcements.tsx). Guard: `announcement:manage`. List with scheduled / live / ended state. Calls `GET /api/platform/announcements`. New → `POST /api/platform/announcements`; edit → `PUT /api/platform/announcements/:id`; archive → `POST /api/platform/announcements/:id/archive`. Fields: title, body, kind info/warning, audiences, cities (empty = every city), from, until.

### `/staff/admin/system`: SystemPage

[src/pages/admin/System.tsx](../src/pages/admin/System.tsx). Guard: `system:read`. Calls `GET /api/platform/system` every 15 s; **Check now** → `GET /api/platform/system?refresh=true` then invalidates. Shows services (status, latency), outboxes, Kafka consumer lag, Redis, OTP delivery (channels, Telegram balance, last hour, SMS fallback rate), routing engines, location stream, document storage, payment providers. Alerts: a service down, outbox events older than a minute, a consumer group over 1000 behind, SMS fallback over 50 %, storage unreachable, unprocessed payment callbacks, callbacks with bad signatures.

### `/staff/admin/audit`: AuditPage

[src/pages/admin/Audit.tsx](../src/pages/admin/Audit.tsx). Guard: `audit_log:read`. Filters kept in the URL: `actorId`, `action` (prefix), `resourceType`, `resourceId`, `outcome`, `service`, `from`, `to`. Calls `GET /api/audit/entries?…&limit=50&cursor=` (infinite list). **Export CSV** → `GET /api/audit/entries.csv?…` as text with the staff token, saved as `audit-YYYY-MM-DD.csv`.

---

## Partner portal

The partner `Shell` lists the user's companies (`GET /api/auth/organization/list`) and "Register a company".

### `/partner`: PartnerHome

[src/pages/partner/Partner.tsx](../src/pages/partner/Partner.tsx). No companies → `/partner/register`; one → its page; several → a list.

### `/partner/register`: RegisterCompany

Kind (fleet company or company account), name, legal name, 10-digit TIN, city. `POST /api/auth/organization/create` `{ name, slug, kind, cityId, legalName, tin }`; the slug is the name in kebab case plus 6 random characters. Then the org list is refetched, `refresh("partner")` gets a token with the new owner/admin role, and the browser goes to the company page.

### `/partner/org/:orgId`: OrgPage

| | |
|---|---|
| Shows | Name, kind, city, legal name, TIN, status pill; notices while `PENDING` or `SUSPENDED`. Tabs: **People** (fleets: "Drivers and people"), **Vehicles** (fleets with `vehicle:read @ ORG`), **Balance** (verified fleets with `balance:read @ ORG`), **Documents** (with `document:upload @ ORG`); selected with `?tab=` |
| Calls | `GET /api/auth/organization/get-full-organization?organizationId=`; for fleets with `vehicle:read`, `GET /api/fleet/organizations/:orgId/overview?members=<driver ids>` every 30 s (each driver's onboarding status, cars and online state) |
| People actions | With `org:manage_members @ ORG` and status `VERIFIED`: **Invite by phone** → `POST /api/auth/organization/invite-member` `{ email: <placeholder email>, role, organizationId }` (fleets invite `fleet_driver`; company accounts `employee` or `corporate_coordinator`); **withdraw** → `POST /api/auth/organization/cancel-invitation` `{ invitationId }`; **remove** (not yourself, not owners or admins) → `POST /api/auth/organization/remove-member` `{ memberIdOrEmail, organizationId }` |
| Booking | Company accounts with `trip:create_on_behalf @ ORG` and `VERIFIED`: link to `/partner/org/:orgId/book` |
| Balance tab | `GET /api/payments/balances/org/:orgId?cityId=&open=true` every 15 s (`open=true` only with `topup:create @ ORG`), then `BalancePanel` with `owner` set to `topup:create` (see [BalancePanel](#staffmoneybalancesaccountid-balancepage)) |

### Vehicles tab (FleetVehicles) and documents tab (CompanyDocuments)

[src/pages/partner/Fleet.tsx](../src/pages/partner/Fleet.tsx).

- **Vehicles**: table of non-retired company cars (plate, car, status with missing-document count, allowed drivers, who is driving). **Add vehicle** (verified, `vehicle:register @ ORG`) → `POST /api/fleet/vehicles` `{ ownerType: "ORGANIZATION", ownerOrgId, plateNumber, vehicleType, make, model, year, color, seats }`, then opens the vehicle page. Vehicle types and seat ranges are hard-coded in `VEHICLE_TYPES` ([src/lib/fleet.ts](../src/lib/fleet.ts)).
- **Documents**: the company's `ORGANIZATION` checklist in owner mode, locked without `document:upload`.

### `/partner/org/:orgId/vehicles/:vehicleId`: FleetVehiclePage

| | |
|---|---|
| Shows | Plate, status, car; notices for draft, waiting, rejected, expired document; documents (locked while `PENDING_REVIEW`, retired, or without `document:upload`); "Who may drive it"; "Right now" |
| Calls | `GET /api/auth/organization/get-full-organization?organizationId=`; `GET /api/fleet/vehicles/:vehicleId`; document calls |
| Actions | **Submit for review** (status `DRAFT`/`REJECTED`, or suspended for an expired document; no missing documents) → `POST /api/fleet/vehicles/:id/submit`. **Remove from fleet** (`vehicle:retire @ ORG`, `confirm`) → `POST /api/fleet/vehicles/:id/retire`. **Allow** a fleet driver, optional end date (`vehicle:authorize_driver @ ORG`) → `POST /api/fleet/vehicles/:id/authorizations` `{ driverUserId, validUntil? }` (`validUntil` is the date at 23:59:59+03:00). **Take away** → `DELETE /api/fleet/vehicles/:id/authorizations/:driverUserId` |

### `/partner/org/:orgId/book`: CorporateBooking

Pick a rider from members with `employee`, `corporate_coordinator` or `corporate_admin`; pickup and destination with `PlacePicker` (partner token). **Get the fare** → `POST /api/pricing/estimates` with `vehicleTypes: ["economy"]` (fixed). **Request the ride** → `POST /api/trips` `{ quoteId, paymentMethod: "CORPORATE", billingOrgId, riderUserId }` with an `Idempotency-Key`. A boxed map shows the two pins and the dashed line. The route has no guard; the page does not check `trip:create_on_behalf` itself.

---

## Shared components with their own API calls

| Component | Calls |
|---|---|
| `PlacePicker` ([src/components/PlacePicker.tsx](../src/components/PlacePicker.tsx)) | `GET /api/maps/search?q=&cityId=` 300 ms after typing (2+ characters). Results are merged after the built-in `COMMON_PLACES` for the city (10 Addis Ababa places; none for other cities); up to 8 shown |
| `DocumentChecklist` ([src/components/Documents.tsx](../src/components/Documents.tsx)) | `GET /api/fleet/documents?subjectType=&subjectId=`; upload via `uploadDocument()` ([src/lib/fleet.ts](../src/lib/fleet.ts)): `POST /api/fleet/documents/upload-url` `{ subjectType, subjectId, kind, contentType, sizeBytes, sha256 }`, `PUT <uploadUrl>` with the returned headers and no credentials, `POST /api/fleet/documents` `{ ticket, expiresAt? }`. JPEG, PNG or PDF, under 10 MB; licence, insurance and inspection need a "valid until" date |
| `DocumentViewer` | `GET /api/fleet/documents/:id/url` (cached 60 s) and shows the image or PDF; reviewers `POST /api/fleet/documents/:id/review` `{ decision: APPROVE \| REJECT, expiresAt?, reason? }`. The page says staff views are recorded in the audit log |
| `AuditTrail` (admin/Users.tsx) | `GET /api/audit/entries?actorId=\|resourceId=&limit=20` |
| `useStaffNames` (admin/Approvals.tsx) | `GET /api/identity/users?kind=staff&limit=100`, cached 5 min, with `user:read_masked` |
