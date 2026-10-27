# Pages

Every screen in the app: what it shows, who can open it, the API calls it makes and what you can do on it. "Guard" is the route check in [src/App.tsx](../src/App.tsx); "inline" checks are `allowed(...)` calls inside the page that show or hide actions. All `/staff/*` calls use the staff token, all `/partner/*` calls the partner token, unless noted. Method `GET` without a body and `POST` with one is the `api()` default ([src/lib/api.ts](../src/lib/api.ts)).

Endpoints are summarised across pages in [api-usage.md](api-usage.md).

## Contents

- [Sign-in and setup](#sign-in-and-setup): `/sign-in`, `/sign-in/staff`, `/sign-in/partner`, staff setup, dev sign-in
- [Public](#public): `/t/:token`
- [Staff: Today](#staff-today): board, live map, book by phone, find a trip, search trips, scheduled rides, GPS trace and reassign
- [Staff: Support and safety](#staff-support-and-safety): SOS alerts, incidents, tickets, lost items
- [Staff: Onboarding](#staff-onboarding): review queue, drivers, vehicles, companies
- [Staff: Accounts](#staff-accounts): suspend, staff and roles
- [Staff: Money](#staff-money): overview, balances, payments, approvals, payouts, adjustments, write-offs, limit exceptions, incentives, invoices, rules, providers
- [Staff: Pricing and marketing](#staff-pricing-and-marketing): fares, zones, promo codes, campaigns
- [Staff: Administration](#staff-administration): overview, reports, regulatory report, users, roles, approvals, settings, cities, announcements, system, audit
- [Staff: You](#staff-you): my account
- [Partner portal](#partner-portal)
- [Shared components with their own API calls](#shared-components-with-their-own-api-calls)

---

## Sign-in and setup

### `/sign-in`: SignInChooser

[src/pages/SignIn.tsx](../src/pages/SignIn.tsx). Two links: "Anbessa staff" → `/sign-in/staff`, "Fleet or company" → `/sign-in/partner`. All sign-in pages sit on a non-interactive Addis Ababa `CityMap` backdrop. No API calls apart from the map style. It does not redirect a user who is already signed in.

### `/sign-in/staff`: StaffSignIn

| | |
|---|---|
| Shows | Work email + password, then a 6-digit authenticator code. "Use a backup code" switches to a backup-code field (and back with "Use the authenticator app") |
| Calls | `POST /api/admin-auth/sign-in/email` `{ email, password }`; if the answer has `twoFactorRedirect`, `POST /api/admin-auth/two-factor/verify-totp` `{ code }`, or `POST /api/admin-auth/two-factor/verify-backup-code` `{ code }` (spaces removed by `normalizeBackupCode`, 6+ characters) |
| After | `refresh("staff")`, navigate to `/staff`; after a backup code, to `/staff/account?backup=used`, which says that code is spent and offers new ones. With no 2FA yet the token has a `setup` claim and the setup page takes over |

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

Note: it is inside `SessionProvider` like every page, but the session queries are disabled on `/t/...` paths (`src/lib/session.tsx`), so it does not call `GET /api/admin-auth/token` or `GET /api/auth/token` (fixed 2026-10-27).

---

## Staff: Today

### `/staff/board`: Board (Live board)

[src/pages/staff/Board.tsx](../src/pages/staff/Board.tsx). Guard: `trip:read` in any city. Full-bleed map workspace.

| | |
|---|---|
| Shows | Floating counts: finding a driver (red when any waited over 60 s), driver on the way, on a trip, free drivers. Map: free, non-stale drivers and a pickup pin per active trip (red when requested over a minute ago, else the status tone). Side panel: a card per active trip with status, waiting time, pickup address, vehicle type, payment method, channel, estimated fare |
| Calls | `GET /api/trips/board?cityId=` every 8 s; `GET /api/locations/cities/:cityId/drivers` every 5 s, only with `location:read_live` in the city |
| Selected card | Rider and driver names and the car (colour, make, model, plate) from `GET /api/trips/:id/parties` (`useTripParties`, only for the selected card; ids when a name is missing) |
| Actions | Select a trip. **Assign driver** (`trip:assign` in the city, trip `requested` only; there is no reassign of a matched trip): a drawer lists the 5 closest free drivers of the same vehicle type by straight-line distance, or takes a pasted driver id → `POST /api/trips/:id/assign` `{ driverId }` with an `Idempotency-Key`. **Cancel** (`trip:cancel`, status `requested`/`matched`/`en_route`) opens `CancelTripDrawer` (from TripDetail.tsx): pick a reason from `STAFF_CANCEL_REASONS` (staff decision, safety, rider changed plans, wrong pickup, driver too far, driver asked to cancel, other) → `POST /api/trips/:id/cancel` `{ reason }` with an `Idempotency-Key`. **Details** → `/staff/trips/:id` |
| After an action | Invalidates `board` and `drivers`; the changed trip card flashes once; a cancel shows the reason and the fee (staff cancellations are free) |

City: `CityPicker` over the cities where the user has `trip:read`.

### `/staff/drivers`: Drivers (Live map)

[src/pages/staff/Drivers.tsx](../src/pages/staff/Drivers.tsx). Guard: `location:read_live` in any city.

| | |
|---|---|
| Shows | Counts of free, on a trip and silent drivers for the chosen car type (silent is highlighted when non-zero). Map of drivers with a position, rotated by heading. Table: short driver id, vehicle type and short vehicle id, state, time of last ping. Filter chips All / Free / On a trip / Silent, and a car-type select ("All cars" plus the types online, shown when there are two or more). Filters run in the browser (`filterDrivers` in [src/lib/trips.ts](../src/lib/trips.ts)) |
| Calls | `GET /api/locations/cities/:cityId/drivers` every 5 s. In the drawer, for a driver on a trip and with `trip:read` in the city: `GET /api/trips/:tripId/parties` (car and rider name) |
| Actions | Select a driver (map zooms to it; keyboard Enter/Space works on rows) and open a drawer: state, last ping, position and heading, car, driver id, current trip. Links: **Driver record** (`driver:read` in the city) and **Open trip** (`trip:read`). No writes |

"Silent" is the `stale` flag from location-service; the footer says it means no ping for 20 s.

### `/staff/phone`: PhoneBooking (Book by phone)

[src/pages/staff/PhoneBooking.tsx](../src/pages/staff/PhoneBooking.tsx). Guard: `trip:create_on_behalf` in any city. The sidebar item is hidden when client config has `features.phoneBooking === false`.

| Step | What happens | Calls |
|---|---|---|
| Caller | Type the caller's mobile, "Find caller" | `POST /api/identity/guests` `{ phoneNumber, cityId }` → `{ userId, created }` ("new caller, guest account created" or "known caller") |
| Route | Pickup and destination from `PlacePicker` or a tap on the map (fills pickup first, then destination). Once both are set the map draws the road route and the panel says "By road: 3.2 km · 12 min" (or a straight-line estimate when mapping-service answers `approximate`) | `GET /api/maps/search` (PlacePicker); on a map tap `GET /api/maps/reverse?lat=&lng=` for a label, kept as coordinates if it fails; `GET /api/maps/route?from=lat,lng&to=lat,lng` (`useRoutePreview`, cached 5 min) |
| Car | The city's enabled vehicle types from client config (`vehicleOptions()`: types whose `cities` is empty or includes the city; the built-in economy / comfort / minivan when the config has none), with seats. The fare card for the chosen type (base, per km, per minute, minimum, waiting per minute) | `GET /api/pricing/fares?cityId=` (`useFares`) |
| Fare | "Get the fare" | `POST /api/pricing/estimates` `{ pickup, dropoff, vehicleTypes: [type], pickupAddress, dropoffAddress }`; the first quote is shown with distance and time; a notice when `approximate` |
| Request | Payment: cash and mobile money only (card checkout needs the rider app), and only those the city has switched on; mobile money lists the providers that take it. An error notice when neither is on | `GET /api/payments/methods?cityId=` (`usePaymentMethods`); `POST /api/trips` `{ quoteId, paymentMethod, riderUserId }` with one `Idempotency-Key` per booking |
| Done | A script to read to the caller (fare and how it's paid), "Follow this trip" → `/staff/trips/:id`, "Next caller" resets the form and the key | |

Changing the city clears the quote; the car and payment choices fall back to the first option the city offers.

### `/staff/trips` and `/staff/trips/:tripId`: TripDetail (Find a trip)

[src/pages/staff/TripDetail.tsx](../src/pages/staff/TripDetail.tsx). Guard: `trip:read` in any city.

| | |
|---|---|
| Shows | A trip-id box ("Open" enabled for a full 36-character id). "Recently opened" chips: the last 8 trips opened in this browser (`localStorage` key `anbessa.staff.recentTrips`, ids only, with a "clear" link). With an id: short id, status, flags, city and time; a boxed map with pickup, drop-off, the road route (`RouteLine` from `trip.route.polyline`, or the dashed `TripLine` when the trip has no polyline) and the driver's live position while the trip is on the road; under it "planned 3.2 km · 12 min" and, once driven, the actual distance and time; a timeline; from/to with coordinates; the people: rider, driver (name, photo or initial, rating and count) and car (colour, make, model, plate), with ids kept visible and a **Driver record** link; a Money card (quoted fare, waiting fee, charged, cancellation fee and driver compensation, payment method, corporate billing) |
| Timeline | From `GET /api/trips/:id/events` (trip-service's history, staff only): one row per status change with its time and who made it ("by the driver", "by <short id>" or "by the system"); arriving at the pickup is the `en_route → en_route` row. Until it loads, or if it fails, the timeline is built from the trip's own timestamps |
| Calls | `GET /api/trips/:id` every 8 s, no retry; `GET /api/trips/:id/events` every 15 s; `GET /api/trips/:id/parties` once the trip loads (cached 30 s). While `matched`/`en_route`/`in_progress` and with `location:read_live` in the trip's city: `GET /api/locations/cities/:cityId/drivers` every 5 s, filtered to the trip's driver. For completed trips or trips with a cancellation fee: `GET /api/payments/trips/:tripId` every 10 s, no retry (payments and settlements: commission, VAT, driver's balance movement) |
| Actions | **Cancel trip** (`trip:cancel` in the trip's city, status `requested`/`matched`/`en_route`) opens `CancelTripDrawer`: a reason from `STAFF_CANCEL_REASONS` and a note that staff cancellations are free → `POST /api/trips/:id/cancel` `{ reason }` with an `Idempotency-Key`; the result shows the recorded reason and fee. A payment line opens the `PaymentDrawer` from the Rider payments page |

`PartiesView` and `CancelTripDrawer` are exported and reused by the Board.

### `/staff/search`: TripSearchPage (Search trips)

[src/pages/staff/TripSearch.tsx](../src/pages/staff/TripSearch.tsx). Guard: `trip:read` in any city.

| | |
|---|---|
| Shows | A filter form: city ("All cities" only for a global `trip:read`; city-scoped staff pick one of theirs), trip id prefix, status, from/to dates, channel (app, phone, company portal), payment (cash, mobile money, card, company), rider user id, driver user id, vehicle id, company (org id). Results table: short id (links to `/staff/trips/:id`), requested, status, city, from → to, channel, payment, fare. "Older trips" loads the next page |
| Calls | `GET /api/trips/search?cityId=&status=&from=&to=&channel=&paymentMethod=&riderUserId=&driverUserId=&vehicleId=&billingOrgId=&q=&limit=50` (empty filters left out), then `&before=<next>` per page |
| Checks in the page | Dates must form a 1–92 day range (`rangeProblem`); the id prefix may only hold hex digits and dashes. "Clear" resets the form |

---

### `/staff/scheduled`: StaffScheduledPage (Scheduled rides)

[src/pages/staff/Scheduled.tsx](../src/pages/staff/Scheduled.tsx). Guard: `trip:read` in any city. City chips, then rides booked ahead with pickup time ("in 2 h 10"), rider or company, vehicle type and status. Calls `GET /api/trips/scheduled?cityId=&status=`; **Cancel** (with a reason) → `POST /api/trips/scheduled/:id/cancel`.

### `/staff/trips/:tripId/trace`: TripTracePage

[src/pages/staff/Trace.tsx](../src/pages/staff/Trace.tsx). Guard: `trip:read_gps_trace` in any city. The GPS trace is personal data: the page asks for a reason (5+ characters) before it loads `GET /api/trips/:id/trace?reason=` and draws the points on the map; **Download CSV** → `GET /api/trips/:id/trace.csv?reason=`. Every read is audited by trip-service. TripDetail embeds the same `TripTrace` card, and Board and TripDetail show `ReassignButton` (`trip:reassign` in the trip's city) → `POST /api/trips/:id/reassign` `{ driverId?, reason? }`: either hands the trip to a nearby online driver picked from the live map list, or (no `driverId`) sends it back to matching without the current driver.

## Staff: Support and safety

These pages call support-service through `supportApi` in [src/lib/support.ts](../src/lib/support.ts) (prefix `/api/support`, port 3009; see [services/support-service/docs/api.md](../../../services/support-service/docs/api.md)). The staff console polls: realtime-gateway only admits `ride-app` tokens, so there are no socket pushes to staff.

### `/staff/safety/sos`: SosQueuePage (SOS alerts)

[src/pages/safety/SosQueue.tsx](../src/pages/safety/SosQueue.tsx). Guard: `sos:respond` in any city.

| | |
|---|---|
| Shows | `CityPicker` over the cities with `sos:respond`; tabs Active / Resolved; a card per alert (open alerts outlined red) with who pressed it (rider or driver), how long it has waited (a 1 s clock), the trip. The selected alert: trip link (with a warning when the trip couldn't be verified), position, status, outcome, linked incident, notes |
| Calls | `GET /api/support/sos?cityId=&status=active|resolved` every 5 s; `GET /api/support/sos/:id` every 5 s |
| Actions | With `sos:respond` in the alert's city: **Acknowledge** → `POST /api/support/sos/:id/acknowledge`; **Add a note** → `POST /api/support/sos/:id/notes` `{ body }`. With `incident:manage`: **Resolve** with an outcome (false alarm, assisted, escalated), a note and, when escalated, an emergency services reference → `POST /api/support/sos/:id/resolve`; **Open an incident** → `POST /api/support/incidents` `{ sosAlertId, category: "OTHER", severity: HIGH (CRITICAL when escalated), summary }` with an `Idempotency-Key`, then the incident page |

### `/staff/safety/incidents` and `/staff/safety/incidents/:id`: IncidentsPage, IncidentPage

[src/pages/safety/Incidents.tsx](../src/pages/safety/Incidents.tsx). Guard: `incident:manage` in any city.

| | |
|---|---|
| List | `CityPicker`; status chips (all, open, investigating, resolved), severity and category selects; table of incidents (ref, summary, severity, category, status, opened). `GET /api/support/incidents?cityId=&status=&severity=&category=&limit=50&cursor=` every 30 s, "Load older" by cursor. **Open incident** drawer (city, category, severity, summary, optional trip id, people involved as user ids, optional safety ticket id whose trip and people are copied) → `POST /api/support/incidents` with an `Idempotency-Key` |
| One incident | `GET /api/support/incidents/:id` every 20 s: summary (trip link, subjects, owner, source), investigation notes, linked SOS alerts and tickets, actions taken |
| Actions (`incident:manage` in its city) | Triage: severity, category, start investigating, take ownership or assign an owner by user id → `PATCH /api/support/incidents/:id`. **Note** → `POST /api/support/incidents/:id/notes` `{ body }`. **Record an action** (warning, suspended, banned, reinstated, pair block; user id, optional until, reference, note) → `POST /api/support/incidents/:id/actions`; the page says suspensions themselves are done on the Suspend page (auth-service). **Resolve** with an outcome (cleared, warning, suspended for a time, removed permanently) and a note → `POST /api/support/incidents/:id/resolve` |

### `/staff/support/tickets` and `/staff/support/tickets/:id`: TicketsPage, TicketPage

[src/pages/support/Tickets.tsx](../src/pages/support/Tickets.tsx). Guard: `ticket:read` in any city.

| | |
|---|---|
| List | Status chips and an "Overdue" chip; city (cities with `ticket:read`), category, priority, assigned (anyone, to me, nobody) selects; search (words or ticket number). Table: number, subject (with city and assignee), category, from, opened, first response ("due in 12 min" / "overdue by 1 h 05" / answered), status. `GET /api/support/tickets?cityId=&status=&category=&priority=&assignee=&overdue=true&q=&limit=50&cursor=` every 30 s, "Load older" by cursor |
| Log a ticket | With `ticket:create` in any city: a drawer for a caller (requester user id, category, subject, description, city, optional trip id, priority) → `POST /api/support/tickets` `{ …, source: "PHONE" }` with an `Idempotency-Key`, then the ticket page |
| One ticket | `GET /api/support/tickets/:id` every 15 s: the conversation (requester messages, staff replies, internal notes marked), details (requester, trip link, city, category, priority, SLA, linked incident, lost item), linked refunds |
| Actions | Reply or internal note → `POST /api/support/tickets/:id/messages` `{ body, internal }`. With `ticket:update` in its city: **Take it** `POST …/claim`; **Unassign** / assign by user id `POST …/assign` `{ assigneeUserId }`; **Working on it**, **Waiting for requester**, **Close without decision** `POST …/status` `{ status }`; priority and category `PATCH /api/support/tickets/:id`; **Resolve** with a resolution and a note `POST …/resolve`; **Reopen** with a reason `POST …/reopen`; **Link a refund** (refund id from Rider payments, optional amount) `POST …/refunds` |

### `/staff/support/lost-items`: LostItemsPage

[src/pages/support/LostItems.tsx](../src/pages/support/LostItems.tsx). Guard: `lost_item:manage` in any city.

| | |
|---|---|
| Shows | City (`useStaffCity("lost_item:manage")`), status chips (default Reported); table of items with trip links. A drawer per item: description, status, trip and city, rider and driver (short ids; the fleet when the car is a company's), what the driver said, the ticket link, reported/returned/closed times, and the message thread. No phone numbers are shown: the thread (seen by rider and driver) is the only channel |
| Calls | `GET /api/support/lost-items?cityId=&status=&limit=50&cursor=` every 30 s; `GET /api/support/lost-items/:id` every 15 s |
| Actions | With `lost_item:manage` in the item's city: move the status to the next allowed ones (`LOST_NEXT`: found, not found, returned, closed) with an optional note → `POST /api/support/lost-items/:id/status`; send a message → `POST /api/support/lost-items/:id/messages` `{ body }` |

---

## Staff: Onboarding

### `/staff/review`: ReviewQueuePage

[src/pages/staff/Fleet.tsx](../src/pages/staff/Fleet.tsx). Guard: `document:review` in any city.

| | |
|---|---|
| Shows | Counts: drivers waiting, vehicles waiting, company documents, approved documents expiring within 30 days. Tabs Drivers / Vehicles / Companies with tables; rows waiting over 24 h are marked urgent. With `vehicle:transfer` in the city, a fourth tab **Ownership transfers**: open transfers (`REQUESTED` and `PENDING`) with plate, from → to, reason, dates |
| Calls | `GET /api/fleet/review/queue?cityId=` every 30 s; `GET /api/identity/organizations?cityId=` for company names when the user has `org:read` in the city; `GET /api/fleet/transfers?cityId=&limit=200` every 60 s (open ones kept) |
| Actions | Click a row → driver record, vehicle record, or `/staff/onboarding?org=<id>`. On a transfer (`transferActions()` in [src/lib/fleet2.ts](../src/lib/fleet2.ts)): **Propose it** (owner's request) → `POST /api/fleet/transfers/:id/endorse`; **Approve transfer** (not the maker, `confirm`) → `/approve`; **Reject** (reason ≥ 10, not the maker) → `/reject`; **Withdraw** (whoever opened it) → `/cancel` |

### `/staff/fleet/drivers`: DriverDirectory

Guard: `driver:read` in any city. Status chips (All, Applying, Waiting for review, Active, Suspended) and a search box (name or last 4 of the licence, sent from 2 characters). Calls `GET /api/fleet/drivers?cityId=&limit=&status=&q=`: 50 rows first, "Show more" asks for 200 (fleet-service's maximum; it has no cursor), after which the page says to narrow the filters. Rows open `/staff/fleet/drivers/:userId`.

### `/staff/fleet/drivers/:userId`: DriverRecord

Guard: `driver:read` in any city.

| | |
|---|---|
| Shows | Name, status, licence, city, dates, the last review note; the document checklist; own and fleet vehicles; "Right now" (online session or offline) |
| Calls | `GET /api/fleet/drivers/:userId`; the checklist's document calls (see [shared components](#shared-components-with-their-own-api-calls)) |
| Actions (all `POST /api/fleet/drivers/:userId/<action>`) | `request-changes` `{ reason }` (`driver:verify`, status `PENDING_REVIEW`); `approve` (`driver:verify` to see it, `driver:activate` to enable it, and no missing documents; without `driver:activate` the page says someone else must approve); `suspend` `{ reason }` (`driver:suspend`, 10+ characters); `reinstate` `{ reason }` (`driver:reinstate`, 10+ characters; lists missing documents first). Document review needs `document:review` in the driver's city |
| Notes | A notice when suspended for an expired document. With `user:suspend` in any city: suspending here stops driving only; a link to `/staff/safety?user=<id>` locks the whole account |

### `/staff/fleet/vehicles`: VehicleDirectory

Guard: `vehicle:read` in any city. Status chips (All, Waiting for review, Verified, Suspended, Rejected, Draft, Retired), owner chips (Any owner, Owner-drivers, Fleet cars) and a plate filter; owner and plate filter the loaded rows in the browser. Calls `GET /api/fleet/vehicles?cityId=&limit=&status=` (50, then 200 with "Show more") and the organisation names query. Rows open `/staff/fleet/vehicles/:id`.

### `/staff/fleet/vehicles/:id`: VehicleRecord

Guard: `vehicle:read` in any city.

| | |
|---|---|
| Shows | Plate, status, car, type, seats, city; review note; notices when suspended for an expired document, suspended by staff, or just transferred (new registration needed); documents with the rule that the registration must name the owner; owner card (company status pill, and "open the company" → `/staff/onboarding?org=<id>` with `org:read` or `org:suspend` in the car's city); for company cars the drivers allowed; "Right now"; **Ownership transfers** card (history, with the same actions as the review queue tab) |
| Calls | `GET /api/fleet/vehicles/:id`; organisation names; document calls; `GET /api/fleet/vehicles/:id/transfers`; in the start drawer `GET /api/fleet/drivers?cityId=&q=&limit=20` (driver search) or `GET /api/identity/organizations?cityId=&status=VERIFIED` (fleets) |
| Actions | With `vehicle:verify` and status `PENDING_REVIEW`: `POST /api/fleet/vehicles/:id/reject` `{ reason }`, `POST /api/fleet/vehicles/:id/approve` (disabled while documents are missing). **Suspend vehicle** (`driver:suspend` in the city, status `VERIFIED`; reason ≥ 10; category `ONBOARDING` for holders of `vehicle:verify`, else `SAFETY`) → `POST /api/fleet/vehicles/:id/suspend`. **Reinstate vehicle** (`driver:reinstate`, status `SUSPENDED`) → `/reinstate` `{ reason }`. **Start a transfer** (`vehicle:transfer` in the city, no open transfer, not retired): new owner a driver (search) or a verified fleet of the city, reason ≥ 10 → `POST /api/fleet/vehicles/:id/transfers` (the officer is the maker); transfer actions as above |

### `/staff/onboarding`: Onboarding (Companies)

[src/pages/staff/Onboarding.tsx](../src/pages/staff/Onboarding.tsx). Guard: `org:read` or `org:suspend` in any city (`companyCities()`), so safety and finance officers who may only suspend can find a company.

| | |
|---|---|
| Shows | City select over the cities with either permission; tabs Waiting / Verified / Suspended; table of companies (name, legal name, kind fleet or company account, TIN, people, registered); waiting over 2 days is urgent. `?org=<id>` opens a drawer: details, papers, cars, **documents expiring** (fleets, with `document:read`: chips 7 / 30 / 90 days, expired rows urgent, plate links to the vehicle record) and **people** (with `org:read` or `org:suspend`: name, masked phone, organisation role, since, account suspended; pending invitations; suspension history with reasons) |
| Calls | `GET /api/identity/organizations?cityId=&status=`; when a drawer is open, `GET /api/identity/organizations?cityId=` to find it; with `document:read` in the city, the `ORGANIZATION` documents and `GET /api/fleet/organizations/:id/expiring-documents?days=`; with `vehicle:read` in the city, the company's cars: `GET /api/fleet/vehicles?ownerOrgId=&cityId=&limit=200` (links to each vehicle record); `GET /api/identity/organizations/:id/members` |
| Actions | What shows is `companyPowers()` × `orgActions()`. **Verify** (`org:verify`, status `PENDING`, disabled until the required documents are approved; says so when the papers can't be opened) → `POST /api/identity/organizations/:id/verify`. **Suspend company** (`org:suspend`, any status but `SUSPENDED`) opens a drawer: reason 10–500 characters, a confirm step → `POST /api/identity/organizations/:id/suspend` `{ reason }` with an `Idempotency-Key`. **Lift suspension** (`canReinstateOrg()`: `org:suspend` in the company's city, status `SUSPENDED`; table link and drawer notice) opens a drawer: reason 10–500 → `POST /api/identity/organizations/:id/reinstate` `{ reason }`; says whether it went back to verified or to waiting. Document review with `document:review` |

---

## Staff: Accounts

### `/staff/safety`: Safety (Suspend)

[src/pages/staff/Safety.tsx](../src/pages/staff/Safety.tsx). Guard: `user:suspend` in any city.

| | |
|---|---|
| Find | One search box: a name, the last 4+ digits of a phone, or a pasted user id; "Suspended only" narrows the list. `GET /api/identity/users?q=&limit=25&status=suspended` from 2 characters (not for a pasted id, which opens directly). Rows open a person drawer, kept in the URL as `?user=<id>` (other pages link here that way) |
| Person drawer | `GET /api/identity/users/:id`: name, phone (masked unless `user:read_pii`), roles, status and, when suspended, until when and why; a driver-record link with `driver:read`; with `audit_log:read`, what was done to them (`AuditTrail`). If the details can't load, the id can still be acted on |
| Actions | **Suspend** (cities with `user:suspend`; staff targets need `staff:manage`) and **Reinstate** (`user:reinstate`). Form: city handling the case (select when more than one), reason 10–500 characters, and for a suspension an optional "until" (`datetime-local` read as Addis Ababa time; must be in the future). A confirm step, then `POST /api/identity/users/:userId/suspend` or `/reinstate` `{ reason, cityId, until? }` with an `Idempotency-Key`. Not on your own account |

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

[src/pages/money/Overview.tsx](../src/pages/money/Overview.tsx). Guard: `balance:read` in any city, or `report:read_finance`.

Two views. `GET /api/payments/overview` is platform-wide, so payment-service answers it only for `balance:read` or `report:read_finance` held everywhere:

- **Platform-wide** (those holders): last 7 days (fares settled, commission, VAT, trips by method), drivers and fleets (we owe them, they owe us, balance states), riders and companies (waiting for the payer, will be asked again, riders owe, companies owe), rider payments by status, money at each provider, ledger integrity, open payout batches and a link to Money approvals when decisions wait. Calls `GET /api/payments/overview` every 30 s and, with `report:read_finance` or `system:read`, `GET /api/payments/ledger/integrity` every 5 min.
- **One city** (for example a city support agent with `balance:read` there): city chips over the cities with `balance:read`; the five most negative balances and a count per state (`GET /api/payments/balances?cityId=&limit=5` and `?cityId=&state=&limit=1`, every 30 s); with a payment-reading role, refunds waiting (`GET /api/payments/refunds?status=PENDING_APPROVAL`) and payments waiting for the payer or failed (`GET /api/payments/payments?status=ACTION_REQUIRED|FAILED&limit=100`, every 30 s).

Read-only.

### `/staff/money/balances`: BalancesPage

[src/pages/money/Balances.tsx](../src/pages/money/Balances.tsx). Guard: `balance:read` in any city.

City chips when the person has `balance:read` in more than one city ("Every city" for global holders, "All my cities" otherwise; a city outside their reach would be a 403), chips by state (Warning, Cash paused, Blocked) and by type (Owner-drivers, Fleets), search from 3 characters, pages of 50. Calls `GET /api/payments/balances?limit=50&offset=&state=&type=&cityId=&q=`. **Export CSV** of the shown rows. Rows open `/staff/money/balances/:accountId`. **Record cash or a bank transfer** (`topup:record_cash`) opens `RecordCashDrawer` with a reference code field.

### `/staff/money/balances/:accountId`: BalancePage

Guard: `balance:read` in any city. Calls `GET /api/payments/balances/:accountId` every 15 s and renders `BalancePanel` with `recordCash` when the user has `topup:record_cash`.

`BalancePanel` ([src/pages/money/BalancePanel.tsx](../src/pages/money/BalancePanel.tsx)), shared with the partner Balance tab:

| Part | Calls |
|---|---|
| Balance, state, limits, dues (overdue dues as errors) | from the balance object |
| Statement (30 entries a page, "Load older") | `GET /api/payments/balances/:accountId/statement?limit=30&before=` |
| Top-ups | `GET /api/payments/balances/:accountId/top-ups`, every 3 s while one is `ACTION_REQUIRED` |
| **Top up** (owner only) | `GET /api/payments/methods` (mobile-money providers), then `POST /api/payments/balances/:accountId/top-ups` `{ amountMinor, provider }` with an `Idempotency-Key` |
| **Payout method** (owner only) | `PUT /api/payments/balances/:accountId/payout-method` `{ provider, destination }` |
| **Record cash or a bank transfer** (`recordCash`) | `POST /api/payments/top-ups/manual` `{ accountId \| referenceCode, channel: OFFICE_CASH \| BANK_TRANSFER, amountMinor, receiptNo, note? }` with an `Idempotency-Key`; it then waits under Money approvals |

On the staff page `owner` is never set, so staff do not see Top up or Payout method.

### `/staff/money/payments`: PaymentsPage (Rider payments)

[src/pages/money/Payments.tsx](../src/pages/money/Payments.tsx). Guard: `balance:read` or `refund:request` in any city, or `refund:approve`.

| | |
|---|---|
| Shows | Status chips All / Waiting for the payer / Will ask again / Failed / Paid / Partly refunded / Refunded; city chips ("All your cities" plus each city where the person holds a `PAYMENT_READERS` permission, shown when more than one); provider select (every enabled provider from `useProviders()`, plus "None"); trip id field (the full id). Table: when, trip, for, provider, amount, status. **Export CSV** of the loaded rows. A row opens `PaymentDrawer` |
| Calls | `GET /api/payments/payments?status=&provider=&tripId=&cityId=&limit=50` every 15 s, "Load older" with `&before=<next>`; `GET /api/payments/methods` (providers, cached 5 min); in the drawer `GET /api/payments/payments/:id` every 5 s |
| Actions | **Check with the provider** (`commission:collect`, status `ACTION_REQUIRED` or `PENDING`) → `POST /api/payments/payments/:id/reconcile`. **Ask for a refund** (`refund:request` in the payment's city, status `SUCCEEDED` or `PARTIALLY_REFUNDED`) → `POST /api/payments/payments/:id/refunds` `{ amountMinor, reason, driverAtFault }` with an `Idempotency-Key` |

### `/staff/money/approvals`: MoneyApprovalsPage

[src/pages/money/Approvals.tsx](../src/pages/money/Approvals.tsx). Guard: any `MONEY_APPROVERS` permission in any city. Tabs **Pending** and **History** (`?tab=history`). Each list is only asked for when the person's roles let payment-service answer it, so nobody sees a 403 for a list they can't have.

**Pending**:

| Card type | Loaded by | Decided by | Decision call |
|---|---|---|---|
| Payout batch | `GET /api/payments/payouts` (filtered to `PENDING_APPROVAL`), with `payout:approve`, `payout:prepare` or `report:read_finance` everywhere (`canReadPayouts`) | `payout:approve` | `POST /api/payments/payouts/:id/{approve\|reject}` |
| Cash / bank top-up | `GET /api/payments/top-ups?status=PENDING_APPROVAL`, with `topup:record_cash`, `topup:approve_cash` or `balance:read` everywhere (`canListTopUps`) | `topup:approve_cash` | `POST /api/payments/top-ups/:id/{approve\|reject}` |
| Refund | `GET /api/payments/refunds?status=PENDING_APPROVAL`, with a `PAYMENT_READERS` permission in any city | `refund:approve` in the payment's city | `POST /api/payments/refunds/:id/{approve\|reject}` |
| Commission rule / balance limits | `GET /api/payments/rules/pending`, with a rule propose/approve permission in any city (`RULE_DECIDERS`) | `commission_rule:approve` / `balance_policy:approve` in the city | `POST /api/payments/rules/changes/:id/{approve\|reject\|cancel}` |

Approve has a confirm step; reject needs a reason (3+ characters) sent as `{ reason }`. The maker sees "waiting for someone else" and, for rule changes only, **Withdraw** (`cancel`). Success invalidates every `["money", …]` query. Staff ids are shown as names through `useStaffNames()` (`GET /api/identity/users?kind=staff&limit=100`, with `user:read_masked`).

**History**: chips for the lists the person may read; decided items only (`decided()` drops what still waits).

| List | Calls | Extras |
|---|---|---|
| Refunds | `GET /api/payments/refunds?status=` (all decided, sending, refunded, failed, rejected); newest 100 in the person's cities | CSV; a row opens the payment drawer |
| Top-ups | `GET /api/payments/top-ups?status=&channel=` (channel defaults to cash at an office; payment-service limits the list to the person's cities) | CSV; a row opens a drawer with `GET /api/payments/top-ups/:id` |
| Payouts | `GET /api/payments/payouts` | a row opens `BatchDetail` (from Payouts) in a drawer |
| Rule changes | `GET /api/payments/rules?cityId=` per city (cities with a `RULE_VIEWERS` permission) | proposals decided, withdrawn or expired |

### `/staff/money/payouts`: PayoutsPage

[src/pages/money/Payouts.tsx](../src/pages/money/Payouts.tsx). Guard: `payout:prepare` or `payout:approve`.

Chips for each batch; the selected batch (`BatchDetail`) shows its status, who prepared and decided it, totals, reject reason, line-status chips with count and amount per status, the lines, and a CSV of the lines. Calls `GET /api/payments/payouts` every 15 s and `GET /api/payments/payouts/:id` every 3 s while `SENDING`, else 20 s. **Run settlement now** (`payout:prepare`) asks for confirmation, then `POST /api/payments/settlements/run`; if `created` is false the page says today's settlement already ran.

### Money controls: adjustments, write-offs, limit exceptions, incentives, invoices

[src/pages/money/Adjustments.tsx](../src/pages/money/Adjustments.tsx), [WriteOffs.tsx](../src/pages/money/WriteOffs.tsx), [Incentives.tsx](../src/pages/money/Incentives.tsx), [Invoices.tsx](../src/pages/money/Invoices.tsx); guards in `lib/money2.ts` (`canSeeAdjustments`, `canSeeWriteOffs`, `canSeeOverrides`, `canSeeIncentives`, `canSeeInvoices`). All follow maker–checker: the person who proposes cannot approve, and pending items also appear on Money approvals (`MoreMoneyApprovals`, from `GET /api/payments/approvals/pending`).

| Page | Route | Calls |
|---|---|---|
| Adjustments | `/staff/money/adjustments` | `GET/POST /api/payments/adjustments`, `POST /api/payments/adjustments/:id` (approve / reject / cancel) |
| Write-offs | `/staff/money/write-offs` | `GET /api/payments/write-offs/candidates`, `GET/POST /api/payments/write-offs`, `POST /api/payments/write-offs/:id` |
| Limit exceptions | `/staff/money/overrides` | `GET/POST /api/payments/policy-overrides`, `POST /api/payments/policy-overrides/:id` |
| Incentives | `/staff/money/incentives` | `GET/POST /api/payments/incentives`, `GET/POST /api/payments/incentives/:id` |
| Invoices | `/staff/money/invoices` | `GET /api/payments/invoices/uninvoiced?period=`, `GET/POST /api/payments/invoices`, `GET /api/payments/invoices/:id`, `GET /api/payments/invoices/:id/csv`, `POST /api/payments/invoices/:id/payments` |

BalancePanel links **Adjust** and **Limit exception** to the first two pages with the account prefilled.

### `/staff/money/rules`: RulesPage (Commission and limits)

[src/pages/money/Rules.tsx](../src/pages/money/Rules.tsx). Guard: any `RULE_READERS` permission in any city.

City chips (`?city=`) over the cities where the person holds a `RULE_VIEWERS` permission (default the first; none → "No city to show"). Shows commission rules in force and scheduled, the balance policy, defaults, the latest 30 proposals and other versions (ended or scheduled). Calls `GET /api/payments/rules?cityId=`. **Propose a commission** (`commission_rule:propose` in the city) and **Propose limits** (`balance_policy:propose`) → `POST /api/payments/rules/changes` `{ kind: COMMISSION_RULE | BALANCE_POLICY, cityId, payload, reason }` (reason 5+ characters); approval happens under Money approvals.

### `/staff/money/providers`: ProvidersPage

[src/pages/money/Providers.tsx](../src/pages/money/Providers.tsx). Guard: `balance:read` or `report:read_finance` or `system:read`. Calls `GET /api/payments/gateways` every 15 s: providers and their mode, simulator settings when simulated, callbacks in the last 24 h by signature result, unprocessed callbacks, latest callbacks with provider chips, "Signature refused" / "Not processed" chips and a CSV. With `balance:read` or `report:read_finance` everywhere, also `GET /api/payments/overview` (every 30 s) for what each provider holds. Read-only.

---

## Staff: Pricing and marketing

Helpers and guards live in [src/lib/marketing.ts](../src/lib/marketing.ts). Every page has city chips over the cities where the person holds the permission.

### `/staff/ops/pricing`: PricingPage (Fares)

Guard: `pricing:propose` or `pricing:approve` in any city. Current fare rules per vehicle type (`GET /api/pricing/fare-rules?cityId=`) and fare changes (`GET /api/pricing/fare-changes?cityId=&status=`). **Propose** → `POST /api/pricing/fare-changes/preview` (shows sample trips before/after) then `POST /api/pricing/fare-changes`; a different person approves or rejects (`POST /api/pricing/fare-changes/:id/approve|reject`); the proposer can cancel.

### `/staff/ops/zones`: ZonesPage

Guard: `zone:manage` in any city. Zones of kind `SERVICE_AREA`, `NO_PICKUP`, `AIRPORT` and `SURGE`, drawn as polygons on the map. `GET /api/pricing/zones?cityId=&includeArchived=`, `POST /api/pricing/zones`, `PUT /api/pricing/zones/:id`, archive → `DELETE /api/pricing/zones/:id`; the polygon is validated with `POST /api/pricing/zones/check` `{ cityId, polygon }` before saving.

### `/staff/marketing/promos`: PromosPage (Promo codes)

Guard: `promo:manage` or `incentive:approve` in any city. `GET /api/pricing/promos?cityId=`, create → `POST /api/pricing/promos`, edit → `PUT /api/pricing/promos/:id`; activate / pause / resume / archive → `POST /api/pricing/promos/:id/:action`; redemptions → `GET /api/pricing/promos/:id/redemptions`. Riders enter codes on the quote screen of the phone app; the discount is booked as a promo expense by payment-service.

### `/staff/marketing/campaigns`: CampaignsPage

Guard: `campaign:send` in any city. Needs the `/api/notifications` proxy (vite `NOTIFICATION_URL`, default port 3006). Audience size preview → `GET /api/notifications/campaigns/audience?cityId=&audience=&channel=&lastActiveDays=`; draft → `POST /api/notifications/campaigns`; edit `PUT /api/notifications/campaigns/:id`; schedule → `POST /api/notifications/campaigns/:id/schedule`; cancel → `POST /api/notifications/campaigns/:id/cancel`. People who opted out of marketing are excluded by notification-service.

## Staff: Administration

### `/staff/admin`: OverviewPage

[src/pages/admin/Overview.tsx](../src/pages/admin/Overview.tsx). Guard: `report:read` in any city, or `system:read`.

Whose numbers: `reportScope()` ([src/lib/account.ts](../src/lib/account.ts)). A global `report:read` holder sees every city or picks one; a city-scoped holder (dispatchers, support, onboarding, operations, marketing, analysts) sees one of their cities at a time, with a city select when they have more than one. The stats calls take `?cityId=` (`statsPath()`), or none for every city.

| Block | Call | Condition | Interval |
|---|---|---|---|
| Trips today | `GET /api/trips/stats[?cityId=]` | `report:read` in a city or everywhere | 30 s |
| People | `GET /api/identity/stats[?cityId=]` (with a city, staff and company counts are that city's; account counts stay platform-wide) | 〃 | 60 s |
| Drivers and vehicles | `GET /api/fleet/stats[?cityId=]` | 〃 | 60 s |
| System alerts | `GET /api/platform/system` | `system:read` | 15 s |
| Waiting approvals | `GET /api/identity/approvals?status=PENDING` | `role:approve` or `authz:approve` | none |
| Waiting setting changes | `GET /api/platform/settings/changes?status=PENDING` | `settings:read` | none |

Alerts come from `systemAlerts()` in System.tsx. Read-only.

### `/staff/reports`: ReportsPage

[src/pages/reports/Reports.tsx](../src/pages/reports/Reports.tsx). Guard: `report:read` in any city, or `report:read_finance`.

| | |
|---|---|
| Shows | City select ("All cities" only for a global `report:read`), from/to dates (default the last 7 days in Addis Ababa; 1–92 days). Tab **Trips**: totals (requested, completed, cancelled, completion rate, time to match, fares), trips per day as a `BarChart`, a per-day table with channels and vehicle types, cancellations by side and reason. Tab **Finance** (only with `report:read_finance` held everywhere): fares, commission, VAT, earnings, payment methods, cancellation fees, collections, refunds, payouts and top-ups per day, with a chart |
| Calls | `GET /api/trips/reports/daily?cityId=&from=&to=`; `GET /api/payments/reports/daily?cityId=&from=&to=` (Finance tab) |
| Actions | **Download CSV** → `GET /api/trips/reports/daily.csv?…` or `GET /api/payments/reports/daily.csv?…` as text with the staff token (`downloadCsv()`), saved as `trips|finance-<city|all>-<from>-<to>.csv` |

### `/staff/reports/regulatory`: RegulatoryReportPage (Regulatory report)

[src/pages/reports/Regulatory.tsx](../src/pages/reports/Regulatory.tsx). Guard: `report:read_regulatory` in any city. City and date range, a summary from `GET /api/trips/reports/regulatory?cityId=&from=&to=`, and **Download CSV** → `GET /api/trips/reports/regulatory.csv?…`.

### `/staff/admin/users`: UsersPage

[src/pages/admin/Users.tsx](../src/pages/admin/Users.tsx). Guard: `user:read_masked` in any city. City-scoped holders get the masked directory: auth-service masks phones without a global `user:read_pii` and hides session devices; the page says which view you have. Kind chips (all, staff, rider, driver, partner, guest), status filter, search from 2 characters, cursor paging. Calls `GET /api/identity/users?q=&kind=&status=&cursor=`. Rows open the user page.

### `/staff/admin/users/:id`: UserPage

Guard: `user:read_masked` in any city.

| | |
|---|---|
| Shows | Status, ban reason and expiry, setup state for staff, access-review notice after 30 idle days, roles, organisation memberships, sessions (surface, IP and user agent, or "devices hidden for your role" when auth-service sends them as `null`, times), and with `audit_log:read` two audit trails: what they did (`actorId`) and what was done to them (`resourceId`). For drivers: a **Driver record** link (`driver:read` in any city) and, with `balance:read` in any city, a link to their balance with the amount |
| Calls | `GET /api/identity/users/:id`; `GET /api/audit/entries?actorId=…&limit=20` and `?resourceId=…&limit=20`; for drivers `GET /api/payments/balances?q=<id>&type=INDIVIDUAL&limit=5` |
| Actions (`POST /api/identity/users/:id/<path>` `{ reason, cityId?, until? }`, reason 10+ characters) | **Sign out everywhere** `sessions/revoke` (`session:revoke`); **Reset sign-in** `reset-mfa` (staff target, `staff:manage`, not yourself; may answer `pendingApproval` or a `temporaryPassword` shown once); **Suspend** `suspend` with "How long" (until reinstated, 24 hours, 7 days, 30 days, or until a date, which ends at the start of that day in Addis Ababa; `suspendUntil()`) and **Reinstate** `reinstate` (staff targets need `staff:manage`; others `user:suspend` / `user:reinstate` in a city, and a city is sent) |

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

## Staff: You

### `/staff/account`: StaffAccountPage (My account)

[src/pages/staff/Account.tsx](../src/pages/staff/Account.tsx). No guard: every staff member has it (sidebar group "You"). Admin-surface cookie calls only (`authCall("staff", …)`).

| Part | Calls |
|---|---|
| Who you are (email), your roles with their city or "everywhere" | `GET /api/admin-auth/get-session`; roles from the token |
| **Your name** (2–120 characters, `nameProblem()`) | `POST /api/admin-auth/update-user` `{ name }` |
| **Password** (current, new 12–128 characters, different, typed twice; optional "sign out my other sessions") | `POST /api/admin-auth/change-password` `{ currentPassword, newPassword, revokeOtherSessions }` |
| **Two-step sign-in**: authenticator status; **new backup codes** (needs the password; old codes stop working). Codes are shown once, with Copy (`backupCodesText()`), and kept only in component state | `POST /api/admin-auth/two-factor/generate-backup-codes` `{ password }` |
| **Where you're signed in**: this browser first, then by last activity, with a device label from the user agent; sign out one, or all others | `GET /api/admin-auth/list-sessions`; `POST /api/admin-auth/revoke-session` `{ token }`; `POST /api/admin-auth/revoke-other-sessions` |

After a backup-code sign-in (`?backup=used`) a notice says the code is spent and suggests new ones.

---

## Partner portal

The partner `Shell` lists the user's companies (`GET /api/auth/organization/list`), "Register a company" and, under "You", My account.

### `/partner`: PartnerHome

[src/pages/partner/Partner.tsx](../src/pages/partner/Partner.tsx). No companies → `/partner/register`; one → its page; several → a list.

### `/partner/register`: RegisterCompany

Kind (fleet company or company account), name, legal name, 10-digit TIN, city. `POST /api/auth/organization/create` `{ name, slug, kind, cityId, legalName, tin }`; the slug is the name in kebab case plus 6 random characters. Then the org list is refetched, `refresh("partner")` gets a token with the new owner/admin role, and the browser goes to the company page.

### `/partner/org/:orgId`: OrgPage

| | |
|---|---|
| Shows | Logo and name, kind, city, legal name, TIN, status pill; notices while `PENDING` or `SUSPENDED`. Header links: **Trips** (`trip:read @ ORG`), **Earnings** (fleets, `earnings:read @ ORG`), **Charges** (company accounts, `payment:read @ ORG`), **Edit name and logo** (`org:update @ ORG`). Tabs: **People** (fleets: "Drivers"), **Vehicles** (fleets with `vehicle:read @ ORG`), **Balance** (verified fleets with `balance:read @ ORG`), **Documents** (with `document:upload @ ORG`); selected with `?tab=` |
| Calls | `GET /api/auth/organization/get-full-organization?organizationId=`; `GET /api/auth/organization/list-invitations?organizationId=`; for fleets with `vehicle:read`, `GET /api/fleet/organizations/:orgId/overview?members=<driver ids>` every 30 s (each driver's onboarding status, cars and online state) |
| People actions | With `org:manage_members @ ORG` and status `VERIFIED`: **Invite by phone** → `POST /api/auth/organization/invite-member` `{ email: <placeholder email>, role, organizationId }` (fleets invite `fleet_driver`; company accounts `employee` or `corporate_coordinator`); invitations listed with status, **withdraw** (or clear an expired one) → `POST /api/auth/organization/cancel-invitation` `{ invitationId }`; on company accounts, switch a member between employee and travel desk (`switchedRole()`) → `POST /api/auth/organization/update-member-role` `{ memberId, role, organizationId }`; **remove** (not yourself, not owners or admins) → `POST /api/auth/organization/remove-member` `{ memberIdOrEmail, organizationId }`. Fleet drivers' names link to the driver page with `driver:read @ ORG` |
| Edit company | Drawer: name and logo (JPEG/PNG/WebP under 5 MB, downscaled to a 160 px JPEG data URL by `imageToDataUrl()`, or removed) → `POST /api/auth/organization/update` `{ organizationId, data: { name, logo } }`. Kind, city, TIN and legal name change only through Anbessa |
| Trips card | Company accounts with `trip:read @ ORG`: rides booked from this browser tab (`sessionStorage` `anbessa.partner.booked`, forgotten when the tab closes), and a box to open any trip by its full id |
| Booking | Company accounts with `trip:create_on_behalf @ ORG` and `VERIFIED`: link to `/partner/org/:orgId/book` |
| Balance tab | `GET /api/payments/balances/org/:orgId?cityId=&open=true` every 15 s (`open=true` only with `topup:create @ ORG`), then `BalancePanel` with `owner` set to `topup:create` (see [BalancePanel](#staffmoneybalancesaccountid-balancepage)) |

### Company pages: trips, earnings, charges, invoices, ride policy, booked ahead

Linked from the OrgPage header. Each checks the org role (`orgRoleOf`) and shows "Not available" otherwise; the service checks again.

| Route | Page | Calls |
|---|---|---|
| `/partner/org/:orgId/trips` (`/:tripId`) | CompanyTripsPage ([CompanyTrips.tsx](../src/pages/partner/CompanyTrips.tsx)) | `GET /api/trips/org/:orgId?status=&from=&to=&before=` (paged) |
| `/partner/org/:orgId/earnings` | FleetEarningsPage (fleets) | `GET /api/payments/earnings/org/:orgId?period=` |
| `/partner/org/:orgId/charges` | CompanyChargesPage (company accounts) | `GET /api/payments/org/:orgId/payments?limit=50&before=` |
| `/partner/org/:orgId/invoices` | CompanyInvoicesPage ([Invoices.tsx](../src/pages/partner/Invoices.tsx)) | `GET /api/payments/org/:orgId/invoices`, `/:id`, `/:id/csv` |
| `/partner/org/:orgId/policy` | CompanyPoliciesPage ([Policies.tsx](../src/pages/partner/Policies.tsx)) | `GET/PUT /api/trips/corporate/:orgId/policy` (allowed vehicle types, hours, max fare, purpose required) |
| `/partner/org/:orgId/scheduled` | CompanyScheduledPage ([Scheduled.tsx](../src/pages/partner/Scheduled.tsx)) | `POST /api/pricing/estimates`, `GET/POST /api/trips/scheduled`, `POST /api/trips/scheduled/:id/cancel` |

Corporate booking sends `purpose` when the policy asks for it; a `policy_violation` answer is shown with the rule that failed. "Book for later instead" links to the scheduled page.

### Vehicles tab (FleetVehicles) and documents tab (CompanyDocuments)

[src/pages/partner/Fleet.tsx](../src/pages/partner/Fleet.tsx).

- **Vehicles**: table of non-retired company cars (plate, car, status with missing-document count, allowed drivers, who is driving). "Show cars removed from the fleet" loads `GET /api/fleet/vehicles?ownerOrgId=&status=RETIRED`. **Add vehicle** (verified, `vehicle:register @ ORG`) → `POST /api/fleet/vehicles` `{ ownerType: "ORGANIZATION", ownerOrgId, plateNumber, vehicleType, make, model, year, color, seats }`, then opens the vehicle page. Vehicle types and seat ranges are hard-coded in `VEHICLE_TYPES` ([src/lib/fleet.ts](../src/lib/fleet.ts)).
- **Documents**: the company's `ORGANIZATION` checklist in owner mode, locked without `document:upload`.
- **Ownership changes in progress** (on the Vehicles tab, only when there are some): open transfers out of or into the fleet, from `GET /api/fleet/transfers?ownerOrgId=&limit=100` (`vehicle:read @ ORG`); outgoing rows open the vehicle page.

### `/partner/org/:orgId/vehicles/:vehicleId`: FleetVehiclePage

| | |
|---|---|
| Shows | Plate, status, car; notices for draft, waiting, rejected, expired document, suspended by staff, just transferred to the company; documents (locked while `PENDING_REVIEW`, retired, or without `document:upload`); "Who may drive it"; "Right now"; **Change of owner** (transfer history with status) |
| Calls | `GET /api/auth/organization/get-full-organization?organizationId=`; `GET /api/fleet/vehicles/:vehicleId`; document calls; `GET /api/fleet/vehicles/:vehicleId/transfers` |
| Actions | **Submit for review** (status `DRAFT`/`REJECTED`, or suspended for an expired document; no missing documents) → `POST /api/fleet/vehicles/:id/submit`. **Remove from fleet** (`vehicle:retire @ ORG`, `confirm`) → `POST /api/fleet/vehicles/:id/retire`. **Allow** a fleet driver, optional end date (`vehicle:authorize_driver @ ORG`) → `POST /api/fleet/vehicles/:id/authorizations` `{ driverUserId, validUntil? }` (`validUntil` is the date at 23:59:59+03:00). **Take away** → `DELETE /api/fleet/vehicles/:id/authorizations/:driverUserId`. **Hand this car to a new owner** (`fleetMayAskTransfer()`: `vehicle:retire @ ORG`, the fleet still owns it, no open transfer) opens a drawer: one of the fleet's drivers, or another fleet by its Anbessa company id (from its portal address), reason ≥ 10 → `POST /api/fleet/vehicles/:id/transfers` (status `REQUESTED`; an onboarding officer proposes it and a second approves). **Withdraw** an open request the person made → `POST /api/fleet/transfers/:id/cancel` |

### `/partner/org/:orgId/book`: CorporateBooking

The page refuses (with an explanation) unless the person has `trip:create_on_behalf` and `trip:bill_corporate @ ORG`, and when client config has `features.corporateBooking` off; during maintenance (`newTripsPaused`) it shows the maintenance message.

| Step | Calls |
|---|---|
| Rider: members with `employee`, `corporate_coordinator` or `corporate_admin` | from `get-full-organization` |
| Pickup and destination with `PlacePicker` (partner token); the map draws the road route | `GET /api/maps/route?from=&to=` (partner) |
| Car: the city's vehicle types from client config (`vehicleChoices()`; the built-in three before the config loads), each with its fare card; types without a fare card are left out | `GET /api/pricing/fares?cityId=` (sent through `http.get` without a token) |
| **Get the fare**: price, distance, time, cars nearby, minutes to the pickup, "price held until" | `POST /api/pricing/estimates` `{ pickup, dropoff, vehicleTypes: [type], pickupAddress, dropoffAddress }` |
| **Request the ride** (only while the quote is usable, `quoteUsable()`; an expired quote asks for a new fare) | `POST /api/trips` `{ quoteId, paymentMethod: "CORPORATE", billingOrgId, riderUserId }` with an `Idempotency-Key`; the trip is remembered in this tab and the browser goes to the trip page |

### `/partner/org/:orgId/trips`: CompanyTripsPage

[src/pages/partner/CompanyTrips.tsx](../src/pages/partner/CompanyTrips.tsx). The page needs `trip:read @ ORG`. Tabs **Billed to us** and **In our cars** (`?role=billing|fleet`, default from the person's org role), status and from/to date filters. Calls `GET /api/trips/org/:orgId?role=&status=&from=&to=&limit=50`, then `&before=` for older trips. Rows link to the trip page.

### `/partner/org/:orgId/charges`: CompanyChargesPage

Same file. The page needs `payment:read @ ORG`. "Owed now" and the charges (when, what: trip fare or cancellation fee, trip, car type, amount), invoiced monthly. Calls `GET /api/payments/org/:orgId/payments?limit=50`, then `&before=`.

### `/partner/org/:orgId/earnings`: FleetEarningsPage

[src/pages/partner/FleetEarnings.tsx](../src/pages/partner/FleetEarnings.tsx). The page needs `earnings:read @ ORG` (fleet owner). Period tabs today / week / month / custom (1–92 days). Totals (trips and cancellation fees, gross fares, commission, VAT, net with the balance change, cash collected and kept by drivers), a per-day `BarChart` and a per-driver table. Calls `GET /api/payments/earnings/org/:orgId?period=&from=&to=`.

### `/partner/org/:orgId/trips/:tripId`: PartnerTripPage

[src/pages/partner/Trip.tsx](../src/pages/partner/Trip.tsx). The page needs `trip:read @ ORG`; trip-service answers 404 for a trip that isn't the company's ("No such trip for this company").

| | |
|---|---|
| Shows | Status, a map with pickup, drop-off and the car while on the road; the trip PIN while active (to pass to a rider without the app); "What happened" timeline from the trip's timestamps; people and car (`/parties`: billed companies see rider, driver and car; fleets see their driver and car); for fleets, the car record. A notice when the trip isn't billed to this company |
| Calls | `GET /api/trips/:tripId` every 8 s until it ends; `GET /api/trips/:tripId/parties`; while `matched`/`en_route`/`in_progress`, `GET /api/locations/trips/:tripId/driver` every 5 s (15 s after an error). location-service lets the booker and the billed company's `trip:read` holders see it, as well as the fleet owner. For fleets with `vehicle:read @ ORG`, `GET /api/fleet/vehicles/:vehicleId` |
| Actions | **Cancel trip** (trip billed to this company, status `requested`/`matched`/`en_route`, `trip:cancel @ ORG`): a drawer with booker reasons (`BOOKER_CANCEL_REASONS`) and a note on whether a fee applies (`cancelFeeNote()`) → `POST /api/trips/:tripId/cancel` `{ reason }` with an `Idempotency-Key` |

### `/partner/org/:orgId/drivers/:userId`: PartnerDriverPage

[src/pages/partner/Driver.tsx](../src/pages/partner/Driver.tsx). Fleets only; the page needs `driver:read @ ORG`. Onboarding status, documents, which company cars the driver may use, and whether they're driving now. Calls `GET /api/fleet/drivers/:userId?orgId=` every 30 s.

### `/partner/account`: PartnerAccountPage

[src/pages/partner/Account.tsx](../src/pages/partner/Account.tsx). App-surface cookie calls only; the phone number is the sign-in and can't be changed here.

| Part | Calls |
|---|---|
| Phone number, **Your name** | `GET /api/auth/get-session`; `POST /api/auth/update-user` `{ name }` |
| **Invitations to you**: accept (then the company list is refetched) or decline | `GET /api/auth/organization/list-user-invitations`; `POST /api/auth/organization/accept-invitation` `{ invitationId }`; `POST /api/auth/organization/reject-invitation` `{ invitationId }` |
| **Where you're signed in** (opens only within a day of signing in, else a notice offers to sign in again) | `GET /api/auth/list-sessions`; `POST /api/auth/revoke-session` `{ token }`; `POST /api/auth/revoke-other-sessions` |

---

## Shared components with their own API calls

| Component | Calls |
|---|---|
| `PlacePicker` ([src/components/PlacePicker.tsx](../src/components/PlacePicker.tsx)) | `GET /api/maps/search?q=&cityId=` 300 ms after typing (2+ characters). Results are merged after the built-in `COMMON_PLACES` for the city (10 Addis Ababa places; none for other cities); up to 8 shown |
| `DocumentChecklist` ([src/components/Documents.tsx](../src/components/Documents.tsx)) | `GET /api/fleet/documents?subjectType=&subjectId=`; upload via `uploadDocument()` ([src/lib/fleet.ts](../src/lib/fleet.ts)): `POST /api/fleet/documents/upload-url` `{ subjectType, subjectId, kind, contentType, sizeBytes, sha256 }`, `PUT <uploadUrl>` with the returned headers and no credentials, `POST /api/fleet/documents` `{ ticket, expiresAt? }`. JPEG, PNG or PDF, under 10 MB; licence, insurance and inspection need a "valid until" date |
| `DocumentViewer` | `GET /api/fleet/documents/:id/url` (cached 60 s) and shows the image or PDF; reviewers `POST /api/fleet/documents/:id/review` `{ decision: APPROVE \| REJECT, expiresAt?, reason? }`. The page says staff views are recorded in the audit log |
| `AuditTrail` (admin/Users.tsx, also on Suspend) | `GET /api/audit/entries?actorId=\|resourceId=&limit=20` |
| `useStaffNames` (admin/Approvals.tsx; used by admin and money approvals, Audit, Settings, Payouts, Rules) | `GET /api/identity/users?kind=staff&limit=100`, cached 5 min, with `user:read_masked` |
| `useTripParties` ([src/lib/trips.ts](../src/lib/trips.ts); Board, Live map, Trip detail) | `GET /api/trips/:id/parties` (staff), cached 30 s |
