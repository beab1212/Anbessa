# web — the Anbessa web app

One React + Vite app for everyone who works in a browser: **staff** (dispatch, call center, support, onboarding, safety, finance, super admins) and **partners** (fleet companies and company accounts).

## Design

A **map-first operations console**. Dispatch work happens on a map of the city, so the map is the workspace: on the live board, drivers and book-by-phone pages it fills the screen, with the list or form in a panel beside it. Only a row of headline counts floats over the map. Everything else is a conventional, light dashboard: sidebar, top bar, cards, tables, pills.

| | |
|---|---|
| Colour | Neutral light UI (`--canvas #f5f6f8`, white surfaces, `--border #e4e7ec`, `--text #0f172a`). One accent, amber `--accent #d97706` (the lion), for the active thing: the selected trip, the primary button, the current page. Red `--danger` only for what needs a person *now*: a trip waiting over a minute, a request waiting for a second super admin, silent drivers |
| Status | Pills with a dot. Trips: finding a driver = amber, driver assigned / on the way = blue, on a trip = green, done = grey, cancelled = red. The same colours mark the pickup pins on the map |
| Type | Inter for text, JetBrains Mono for ids, times and money, Noto Serif Ethiopic for the አ mark |
| Map | MapLibre GL (`maplibre-gl`, no wrapper) with OpenStreetMap vector tiles. Drivers are round markers that rotate with their heading; pickups are pins coloured by trip status; a dashed line joins pickup and drop-off |
| Motion | Short transitions on hover, selection and the side drawer; the trip you just changed flashes once. Respects `prefers-reduced-motion` |
| Width | Desktop first (ops floors). Below 860 px the sidebar becomes a bottom bar and map workspaces stack (map above the list, or form above the map) |

Styles are plain CSS in `src/styles/`: `tokens.css` (all colours, radii, shadows), `base.css`, `components.css` (buttons, fields, cards, pills, tables, drawer…), `layout.css` (shell, map workspaces, markers, sign-in). Icons come from `lucide-react`.

### Map tiles

The style URL is `VITE_MAP_STYLE_URL` (in `.env`, read at build time). The default is [OpenFreeMap](https://openfreemap.org)'s free OSM tiles, fine for development. Production uses the self-hosted TileServer GL from `infra/mapping-stack` (or a licensed provider). Whatever the source, the OpenStreetMap attribution in the map corner must stay visible.

If the style or tiles can't load, the map says so and everything beside it keeps working: positions, lists and forms don't depend on tiles.

## Who sees what

What each person sees comes from the roles in their access token, read with the **same permission matrix** the services enforce. The matrix is live: the app loads it from auth-service (`GET /api/identity/authz`, `lib/session.tsx`), so permission changes and custom roles made in Administration show up without a release. The bundled `libs/shared-authz` matrix is only the fallback. Hiding a page is a convenience: every service checks every request again.

| Area | Who (permission @ scope) | Signs in with |
|---|---|---|
| **Live board** `/staff/board`: active trips with rider, driver and car, assign, cancel with a reason | `trip:read @ CITY` (assign: dispatchers) | email + password + TOTP or a backup code (`/api/admin-auth`) |
| **Live map** `/staff/drivers`: every online driver on the map, state and car-type filters, list, a drawer per driver | `location:read_live @ CITY` | 〃 |
| **Book by phone** `/staff/phone`: guest caller, places (search or tap the map) with the road route, the city's car types and fare card, fare, cash or mobile money as the city allows, request | `trip:create_on_behalf @ CITY` | 〃 |
| **Find a trip** `/staff/trips/:id`: road route and live driver on a map, the trip's history (who changed what, when), rider, driver and car, money (the charge, commission and what the driver's balance moved by), cancel with a reason; recently opened trips | `trip:read @ CITY` | 〃 |
| **Search trips** `/staff/search`: by city, dates, status, channel, payment, rider, driver, vehicle, company or id prefix | `trip:read @ CITY` | 〃 |
| **SOS alerts** `/staff/safety/sos`: the city's alerts, oldest unanswered first; acknowledge, notes, resolve, open an incident | `sos:respond @ CITY` (resolve: `incident:manage`) | 〃 |
| **Incidents** `/staff/safety/incidents` and `/:id`: open, triage, notes, actions taken, resolve | `incident:manage @ CITY` | 〃 |
| **Tickets** `/staff/support/tickets` and `/:id`: the city queue with SLA, log a caller's ticket, conversation and internal notes, assign, resolve, link refunds | `ticket:read @ CITY` (changes: `ticket:update`, new: `ticket:create`) | 〃 |
| **Lost items** `/staff/support/lost-items`: reported items, status, messages to rider and driver | `lost_item:manage @ CITY` | 〃 |
| **Review queue** `/staff/review`: drivers, vehicles and company papers waiting, oldest first | `document:review @ CITY` | 〃 |
| **Drivers** `/staff/fleet/drivers` and `/:userId`: applications and drivers; review documents, approve, request changes, suspend, reinstate | `driver:read @ CITY` (decisions: `driver:verify`, `driver:suspend`…) | 〃 |
| **Vehicles** `/staff/fleet/vehicles` and `/:id`: cars; review documents, approve or reject | `vehicle:read @ CITY` (decisions: `vehicle:verify`) | 〃 |
| **Companies** `/staff/onboarding`: verification queue, each company's papers and cars in a drawer, suspend with a reason | `org:read` or `org:suspend @ CITY` (verify: `org:verify`; documents: `document:review`) | 〃 |
| **Suspend** `/staff/safety`: find a person by name, phone digits or id; suspend (optionally until a time) or reinstate | `user:suspend @ CITY` (staff targets: super admins) | 〃 |
| **Staff and roles** `/staff/people`: every staff member with their roles, authenticator status and last sign-in (access review: roles unused for 30+ days are flagged); remove a role (at once); ask for one (approved under Approvals); new staff accounts | `staff:manage`, `role:request`, `role:approve` | 〃 |
| **Money → Overview** `/staff/money`: fares, commission and VAT in the last 7 days; what drivers and fleets owe and are owed; balance states; open charges, receivables; what each provider holds; ledger integrity. City-scoped holders get one city's balances and payments instead | `balance:read` or `report:read_finance` everywhere; `balance:read @ CITY` for the city view | 〃 |
| **Balances** `/staff/money/balances` and `/:accountId`: every driver and fleet balance, most negative first, by state and city, CSV; one balance's limits, dues, statement (paged) and top-ups; record cash paid at an office or a bank transfer | `balance:read` (recording: `topup:record_cash`) | 〃 |
| **Rider payments** `/staff/money/payments`: charges by mobile money and card, filtered by state, city, provider or trip, paged, CSV; check one with the provider; ask for a refund | `balance:read`, `refund:request` (checking: `commission:collect`) | 〃 |
| **Money approvals** `/staff/money/approvals`: cash and bank top-ups, refunds, payout batches, commission and limit changes waiting for a second person; a History tab of what was decided | any of `topup:*`, `refund:*`, `payout:*`, `commission_rule:*`, `balance_policy:*` | 〃 |
| **Payouts** `/staff/money/payouts`: the weekly settlement batches and their lines (by status, CSV); run it now | `payout:prepare` / `payout:approve` | 〃 |
| **Commission and limits** `/staff/money/rules`: per city, what's in force and what's proposed; propose a commission rule or new limits | `commission_rule:*`, `balance_policy:*`, `commission:read` | 〃 |
| **Payment providers** `/staff/money/providers`: telebirr, CBE Birr, Chapa (simulated or live) and their latest callbacks | `balance:read`, `report:read_finance` or `system:read` | 〃 |
| **Administration → Overview** `/staff/admin`: trips today, people, drivers and vehicles (every city or one), system status, approvals waiting, alerts | `report:read` (city-scoped: one of your cities) or `system:read` | 〃 |
| **Reports** `/staff/reports`: trips per day by status, channel and car type; money per day for finance; CSV | `report:read` (finance tab: `report:read_finance`) | 〃 |
| **Users** `/staff/admin/users` and `/:id`: every account (riders, drivers, partners, guests, staff), search; one person's roles, organisations and sessions; links to a driver's record and balance; sign out everywhere, suspend (for a set time or until reinstated) or reinstate, reset a staff member's sign-in; what they did and what was done to them (audit log). Phones and session devices are masked without `user:read_pii` | `user:read_masked` in any city (actions: `session:revoke`, `staff:manage`, `user:suspend`…) | 〃 |
| **Roles and permissions** `/staff/admin/roles`: the live matrix, a role editor (checked against the guardrails as you edit), custom roles. Changes go to Approvals | `authz:read` (changes: `authz:propose`) | 〃 |
| **Approvals** `/staff/admin/approvals`: everything waiting for a second person (role grants, permission changes, sensitive settings, super-admin sign-in resets); approve, reject, or withdraw your own | any of `role:*`, `authz:*`, `settings:*`, `staff:manage` | 〃 |
| **Settings** `/staff/admin/settings`: every live setting by group, with city overrides, history and reset to default. ★ = needs approval | `settings:read` (changes: `settings:propose`) | 〃 |
| **Cities and vehicles** `/staff/admin/cities`: open or close cities, their map area; vehicle types and where they're offered | `settings:read` (changes: `city:manage`) | 〃 |
| **Announcements** `/staff/admin/announcements`: banners for riders, drivers, partners and staff, by city and time | `announcement:manage` | 〃 |
| **System** `/staff/admin/system`: every service's health and answer time, outboxes, Kafka lag, Redis, login-code delivery, routing engines, document storage | `system:read` | 〃 |
| **Audit log** `/staff/admin/audit`: search and export the write-once log | `audit_log:read` | 〃 |
| **My account** `/staff/account`: name, password, new backup codes, where you're signed in | every staff member | 〃 |
| **Company** `/partner/org/:id`: edit name and logo; people, roles (employee ↔ travel desk) and invitations by phone (fleets: each driver's onboarding status and cars); **Vehicles** tab (fleets, with retired cars on request); **Balance** tab (fleets: the fleet's one balance, statement, top up by mobile money, payout method); **Documents** tab (company papers); links to Trips, Earnings, Charges | the org's owner or admin (edit: `org:update`) | phone + 6-digit code (`/api/auth`) |
| **Fleet car** `/partner/org/:id/vehicles/:vehicleId`: documents, submit for review, who may drive it, remove | `vehicle:read` / `vehicle:authorize_driver @ ORG` | 〃 |
| **Fleet driver** `/partner/org/:id/drivers/:userId`: onboarding status, documents, allowed cars, driving now | `driver:read @ ORG` | 〃 |
| **Book a ride** `/partner/org/:id/book` (company accounts): rider, places with the road route, the city's car types and fares | `trip:create_on_behalf` + `trip:bill_corporate @ ORG` | 〃 |
| **Trips** `/partner/org/:id/trips` and `/:tripId`: billed to the company or driven in its cars; one trip with its people, PIN, live car and cancel | `trip:read @ ORG` (cancel: `trip:cancel`) | 〃 |
| **Earnings** `/partner/org/:id/earnings` (fleets): per period, day and driver | `earnings:read @ ORG` | 〃 |
| **Charges** `/partner/org/:id/charges` (company accounts): what's owed and each charge | `payment:read @ ORG` | 〃 |
| **My account** `/partner/account`: name, invitations to you, where you're signed in | any signed-in partner | 〃 |
| **Register a company** `/partner/register` | any signed-in partner | 〃 |

The first staff sign-in goes through **setup**: replace the temporary password, then enrol an authenticator app (QR code and one-time backup codes). Until both are done the token carries no roles.

## Running it

```bash
make setup-web        # pnpm install + .env
make dev-web          # http://localhost:5173
```

The browser only calls `/api/*` **on its own origin**. In development Vite forwards each prefix to its service (`vite.config.ts`, targets in `.env`), so cookies stay first-party and no service needs CORS. In production put Kong behind the same origin (e.g. the CDN routes `/api/*` to Kong).

| Prefix | Service |
|---|---|
| `/api/auth`, `/api/admin-auth`, `/api/identity` | auth-service (3001) |
| `/api/trips` | trip-service (3002) |
| `/api/pricing` | pricing-service (3004): estimates |
| `/api/payments` | payment-service (3005): balances, payments, payouts, providers |
| `/api/locations` | location-service (3003) |
| `/api/maps` | mapping-service (3007) |
| `/api/fleet` | fleet-service (3008) |
| `/api/support` | support-service (3009): tickets, lost items, SOS, incidents |
| `/api/platform` | platform-service (3011): settings, cities, announcements, system; `client-config` is public |
| `/api/audit` | audit-service (3010) |

The app reads `/api/platform/client-config` at start (`lib/platform.tsx`): the city list, feature flags (the Book by phone page disappears when phone booking is off), the maintenance message (a banner and a "new trips paused" badge) and announcements for staff and partners.

In development the sign-in page also has a **Sign in as…** panel with ready-made accounts: run `pnpm --filter @ride-app/auth-service seed:dev` once, with `DEV_LOGIN=on` in auth-service's `.env`. The panel lives in `src/dev/`, is loaded only when `import.meta.env.DEV` is true, and isn't in production builds ([docs/development](../../docs/development/README.md#ready-made-accounts-web-app-dev-sign-in)).

Without Nominatim, place search falls back to a list of common Addis Ababa places (`src/components/PlacePicker.tsx`). Fares come from pricing-service (`/api/pricing/estimates`), priced with the live fare card in Settings → Fares.

## Layout

```
src/
├── lib/          api (axios clients: Better Auth calls, service calls with the surface token, ApiError), session, hooks, formatting,
│                 fleet, money, admin, trips, account, partner, reports, support (per-area types, helpers and API calls)
├── components/   Shell (sidebar + top bar), ui (pills, fields, notices, drawer), CityPicker, PlacePicker, Documents, BarChart
│   └── map/      CityMap (MapLibre + context), markers (driver, pickup, drop-off, trip line, route line)
├── dev/          development-only sign-in panel (left out of production builds)
├── pages/        SignIn · public/SharedTrip
│                 staff/{Setup, Board, Drivers, PhoneBooking, TripDetail, TripSearch, Onboarding, Safety, People, Fleet, Account}
│                 support/{Tickets, LostItems} · safety/{SosQueue, Incidents} · reports/Reports
│                 money/{Overview, Balances, BalancePanel, Payments, Approvals, Payouts, Rules, Providers}
│                 admin/{Overview, Users, Roles, Approvals, Settings, Cities, Announcements, System, Audit}
│                 partner/{Partner, Fleet, Trip, Driver, CompanyTrips, FleetEarnings, Account}
├── styles/       tokens · base · components · layout
└── App.tsx       routes and the role-based index
```

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Vite dev server |
| `pnpm build` | Type-check, then build to `dist/` |
| `pnpm test` | Logic tests (10 files, 68 tests): phone parsing, money and CSV, placeholder emails, role → navigation, the API client (token, retry, errors), trips, account, admin, onboarding, partner and safety helpers |
| `pnpm lint` / `pnpm typecheck` | |

## Documentation

Reference docs for engineers working on this app are in [docs/](docs/README.md): architecture and routes, every page and its API calls, the endpoint list, integrations, configuration and operations.
