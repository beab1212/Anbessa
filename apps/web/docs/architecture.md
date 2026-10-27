# Architecture

How the web app is put together: files, routes, sessions, data fetching, maps, styling and error handling. Paths are relative to `apps/web/`.

## Contents

1. [Folder structure](#1-folder-structure)
2. [Start-up](#2-start-up)
3. [Routing](#3-routing)
4. [Auth and sessions](#4-auth-and-sessions)
5. [Data fetching](#5-data-fetching)
6. [Maps](#6-maps)
7. [Design system](#7-design-system)
8. [State](#8-state)
9. [Error handling](#9-error-handling)
10. [Internationalisation, time and money](#10-internationalisation-time-and-money)

## 1. Folder structure

```
apps/web/
├── index.html              title, meta, Google Fonts (Inter, JetBrains Mono, Noto Serif Ethiopic), mounts src/main.tsx
├── vite.config.ts          React plugin, dev server :5173, /api/* proxy per prefix
├── package.json            scripts: dev, build, lint, test, preview, typecheck
├── tsconfig.json           extends ../../tsconfig.base.json; includes src and vite.config.ts
├── .env.example            proxy targets and VITE_MAP_STYLE_URL
├── public/favicon.svg
├── tests/                  api, logic, account, admin, money, onboarding, partner, safety, trips (*.test.ts; see operations.md)
└── src/
    ├── main.tsx            QueryClient, providers, global CSS imports
    ├── App.tsx             every route, staff navigation (staffSections), guards
    ├── lib/
    │   ├── api.ts          axios clients, access-token cache, 401 retry, ApiError, principal helpers
    │   ├── session.tsx     SessionProvider: staff and partner claims, live permission matrix, sign-out
    │   ├── platform.tsx    ConfigProvider: /api/platform/client-config (cities, flags, maintenance, announcements)
    │   ├── hooks.ts        useNow, useStaffCity, useCityDrivers, useBoard
    │   ├── format.ts       money (santim), Addis Ababa times, phone numbers, city list, trip status words
    │   ├── fleet.ts        fleet-service types and words, document upload flow
    │   ├── money.ts        payment-service types and words, toMinor, percent
    │   ├── admin.ts        identity/platform/audit types, setting value display, CSV download
    │   ├── trips.ts        staff cancel reasons, useTripParties, recent trips (localStorage), useRoutePreview, vehicleOptions, useFares, usePaymentMethods, live-map filters
    │   ├── account.ts      My account rules (name, password, backup codes, sessions), reportScope/statsPath, suspension lengths
    │   ├── partner.ts      member roles, invitations, booker cancel reasons and fee notes, trips booked in this tab (sessionStorage), vehicle choices
    │   ├── reports.ts      trip/finance report types, trip search filters, Addis day ranges, qs(), downloadCsv(), chart helpers
    │   ├── support.ts      support-service types, words and `supportApi` (tickets, lost items, SOS, incidents)
    │   ├── polyline.ts     decodePolyline6 (precision-6 encoded polylines)
    │   └── polyline.test.ts
    ├── components/
    │   ├── Shell.tsx       sidebar + top bar + banners + <Outlet/>
    │   ├── ui.tsx          Logo, Brand, Pill, TripStatus, Field, SelectField, TextArea, Problem, Notice, PageHead, Empty, Stat, Drawer
    │   ├── CityPicker.tsx  city label or select
    │   ├── PlacePicker.tsx place search combobox (mapping-service, falls back to COMMON_PLACES)
    │   ├── Documents.tsx   DocumentChecklist, DocumentViewer (fleet-service documents)
    │   ├── BarChart.tsx    grouped bar chart in plain SVG (Reports, fleet Earnings)
    │   └── map/
    │       ├── CityMap.tsx MapLibre map + context
    │       └── markers.tsx DriverMarker, PickupMarker, DropoffMarker, TripLine, RouteLine
    ├── dev/                DevSignIn.tsx + dev.css (development builds only)
    ├── pages/
    │   ├── SignIn.tsx      SignInChooser, StaffSignIn, PartnerSignIn
    │   ├── public/         SharedTrip
    │   ├── staff/          Setup, Board, Drivers, PhoneBooking, TripDetail, TripSearch, Onboarding, Safety, People, Fleet, Account
    │   ├── support/        Tickets (list and one ticket), LostItems
    │   ├── safety/         SosQueue, Incidents (list and one incident)
    │   ├── reports/        Reports
    │   ├── partner/        Partner (home, register, org page, corporate booking), Fleet (vehicles, vehicle page, documents), Trip, Driver, CompanyTrips (trips, charges), FleetEarnings, Account
    │   ├── money/          Overview, Balances, BalancePanel, Payments, Approvals, Payouts, Rules, Providers
    │   └── admin/          Overview, Users, Roles, Approvals, Settings, Cities, Announcements, System, Audit
    └── styles/             tokens.css, base.css, components.css, layout.css
```

Workspace libraries used (from `package.json`):

| Library | Used for |
|---|---|
| `@ride-app/shared-authz` | `can`, `parseRoleClaims`, `setAuthzSnapshot`, `roleInfo`, `grantableStaffRoles`, `PERMISSIONS`, `PERMISSION_GROUPS`; types `Principal`, `Permission`, `AuthzSnapshot` |
| `@ride-app/shared-location` | `CITIES` bounding boxes for the map, `haversineMeters`, `LatLng` |
| `@ride-app/shared-settings` | `SettingDef` type for the Settings page |
| `@ride-app/shared-types` | `Trip` type |

## 2. Start-up

[src/main.tsx](../src/main.tsx) renders, inside `StrictMode`:

```
QueryClientProvider → ConfigProvider → SessionProvider → App (BrowserRouter)
```

It imports `maplibre-gl/dist/maplibre-gl.css` and the four stylesheets in order: tokens, base, components, layout.

- `ConfigProvider` ([src/lib/platform.tsx](../src/lib/platform.tsx)) fetches `GET /api/platform/client-config` without a token, every 60 s, one retry. On success it calls `applyCities()` which replaces the in-memory city list (`CITIES`, `CITY_NAMES` in [src/lib/format.ts](../src/lib/format.ts)) in place. Until it loads, or if platform-service is down, the context value is `null` and the app runs on built-in defaults: cities `addis-ababa` and `hawassa`, no banners, phone booking shown.
- `SessionProvider` ([src/lib/session.tsx](../src/lib/session.tsx)) asks both surfaces for an access token at once, see [section 4](#4-auth-and-sessions).

## 3. Routing

All routes are declared in [src/App.tsx](../src/App.tsx) with `BrowserRouter`. There is no lazy loading of pages; only the dev sign-in panel is a lazy chunk.

### Area guards

| Element | Behaviour |
|---|---|
| `Home` (`/`) | Waits for both surfaces. Staff session → first staff page (or `/staff` if setup is pending). Else partner session → `/partner`. Else `/sign-in`. A staff session wins when both exist |
| `StaffArea` (`/staff`) | No staff principal → `/sign-in/staff`. Token has a `setup` claim → renders `StaffSetup` instead of any child route. Otherwise `Shell` with the sections from `staffSections()` |
| `PartnerArea` (`/partner`) | No partner principal → `/sign-in/partner`. Otherwise `Shell` with two sections: "Companies" (one item per organisation from `/api/auth/organization/list`, plus "Register a company") and "You" (My account) |
| `Guard` | Wraps every staff child route. Renders the page if `ok(staff.principal)` is true, else `NoAccess` ("Nothing here for your roles."). Partner routes have no `Guard`; their pages check permissions inline with `allowed()` |
| `StaffIndex` (`/staff` index) | Redirects to the first item in `staffSections()` other than My account (`firstStaffPage()`), or `/staff/account` when there is none. `Home` uses the same rule |

`inAnyCity(p, perm)` in `App.tsx` is true when the principal holds the permission in any city in `CITIES` or unscoped. City-scoped staff pages then pick the city inside the page (`useStaffCity`, `CityPicker`). The guards for `report:read` (Overview, Reports), `user:read_masked` (Users), `balance:read` (money pages) and `org:read`/`org:suspend` (Companies) use `inAnyCity`, so city-scoped roles (dispatchers, onboarding, support, operations, safety) reach them; before 2026-10-27 some of them used an unscoped `can()` and hid the page from city roles.

### Route table

| Path | Component (file) | Guard: permission required | Audience |
|---|---|---|---|
| `/` | `Home` (App.tsx) | none, redirects | all |
| `/t/:token` | `SharedTrip` (pages/public/SharedTrip.tsx) | none | public |
| `/sign-in` | `SignInChooser` (pages/SignIn.tsx) | none | all |
| `/sign-in/staff` | `StaffSignIn` (pages/SignIn.tsx) | none | staff |
| `/sign-in/partner` | `PartnerSignIn` (pages/SignIn.tsx) | none | partner |
| `/staff` (index) | `StaffIndex` → first allowed page; `StaffSetup` (pages/staff/Setup.tsx) while setup is pending | staff session | staff |
| `/staff/board` | `Board` (pages/staff/Board.tsx) | `trip:read` in any city | staff |
| `/staff/drivers` | `Drivers` (pages/staff/Drivers.tsx) | `location:read_live` in any city | staff |
| `/staff/phone` | `PhoneBooking` (pages/staff/PhoneBooking.tsx) | `trip:create_on_behalf` in any city (nav item also hidden when `features.phoneBooking` is false; the route itself stays reachable) | staff |
| `/staff/trips` | `TripDetail` (pages/staff/TripDetail.tsx) | `trip:read` in any city | staff |
| `/staff/trips/:tripId` | `TripDetail` | `trip:read` in any city | staff |
| `/staff/search` | `TripSearchPage` (pages/staff/TripSearch.tsx) | `trip:read` in any city | staff |
| `/staff/safety/sos` | `SosQueuePage` (pages/safety/SosQueue.tsx) | `sos:respond` in any city | staff |
| `/staff/safety/incidents` | `IncidentsPage` (pages/safety/Incidents.tsx) | `incident:manage` in any city | staff |
| `/staff/safety/incidents/:id` | `IncidentPage` (pages/safety/Incidents.tsx) | `incident:manage` in any city | staff |
| `/staff/support/tickets` | `TicketsPage` (pages/support/Tickets.tsx) | `ticket:read` in any city | staff |
| `/staff/support/tickets/:id` | `TicketPage` (pages/support/Tickets.tsx) | `ticket:read` in any city | staff |
| `/staff/support/lost-items` | `LostItemsPage` (pages/support/LostItems.tsx) | `lost_item:manage` in any city | staff |
| `/staff/onboarding` | `Onboarding` (pages/staff/Onboarding.tsx) | `org:read` or `org:suspend` in any city | staff |
| `/staff/review` | `ReviewQueuePage` (pages/staff/Fleet.tsx) | `document:review` in any city | staff |
| `/staff/fleet/drivers` | `DriverDirectory` (pages/staff/Fleet.tsx) | `driver:read` in any city | staff |
| `/staff/fleet/drivers/:userId` | `DriverRecord` (pages/staff/Fleet.tsx) | `driver:read` in any city | staff |
| `/staff/fleet/vehicles` | `VehicleDirectory` (pages/staff/Fleet.tsx) | `vehicle:read` in any city | staff |
| `/staff/fleet/vehicles/:id` | `VehicleRecord` (pages/staff/Fleet.tsx) | `vehicle:read` in any city | staff |
| `/staff/safety` | `Safety` (pages/staff/Safety.tsx) | `user:suspend` in any city | staff |
| `/staff/people` | `People` (pages/staff/People.tsx) | `role:request` or `role:approve` or `staff:manage` | staff |
| `/staff/admin` | `OverviewPage` (pages/admin/Overview.tsx) | `report:read` in any city, or `system:read` | staff |
| `/staff/reports` | `ReportsPage` (pages/reports/Reports.tsx) | `report:read` in any city, or `report:read_finance` | staff |
| `/staff/admin/users` | `UsersPage` (pages/admin/Users.tsx) | `user:read_masked` in any city | staff |
| `/staff/admin/users/:id` | `UserPage` (pages/admin/Users.tsx) | `user:read_masked` in any city | staff |
| `/staff/admin/roles` | `RolesPage` (pages/admin/Roles.tsx) | `authz:read` | staff |
| `/staff/admin/approvals` | `ApprovalsPage` (pages/admin/Approvals.tsx) | any of `role:request`, `role:approve`, `staff:manage`, `authz:propose`, `authz:approve`, `settings:propose`, `settings:approve` (`APPROVERS`) | staff |
| `/staff/admin/settings` | `SettingsPage` (pages/admin/Settings.tsx) | `settings:read` | staff |
| `/staff/admin/cities` | `CitiesPage` (pages/admin/Cities.tsx) | `settings:read` | staff |
| `/staff/admin/announcements` | `AnnouncementsPage` (pages/admin/Announcements.tsx) | `announcement:manage` | staff |
| `/staff/admin/system` | `SystemPage` (pages/admin/System.tsx) | `system:read` | staff |
| `/staff/admin/audit` | `AuditPage` (pages/admin/Audit.tsx) | `audit_log:read` | staff |
| `/staff/money` | `MoneyOverviewPage` (pages/money/Overview.tsx) | `balance:read` in any city, or `report:read_finance` (unscoped) | staff |
| `/staff/money/balances` | `BalancesPage` (pages/money/Balances.tsx) | `balance:read` in any city | staff |
| `/staff/money/balances/:accountId` | `BalancePage` (pages/money/Balances.tsx) | `balance:read` in any city | staff |
| `/staff/money/payments` | `PaymentsPage` (pages/money/Payments.tsx) | `balance:read` or `refund:request` in any city, or `refund:approve` | staff |
| `/staff/money/approvals` | `MoneyApprovalsPage` (pages/money/Approvals.tsx) | any of `topup:record_cash`, `topup:approve_cash`, `refund:request`, `refund:approve`, `payout:prepare`, `payout:approve`, `commission_rule:propose`, `commission_rule:approve`, `balance_policy:propose`, `balance_policy:approve` in any city (`MONEY_APPROVERS`) | staff |
| `/staff/money/payouts` | `PayoutsPage` (pages/money/Payouts.tsx) | `payout:prepare` or `payout:approve` | staff |
| `/staff/money/rules` | `RulesPage` (pages/money/Rules.tsx) | any of `commission_rule:propose`, `commission_rule:approve`, `balance_policy:propose`, `balance_policy:approve`, `commission:read` in any city (`RULE_READERS`) | staff |
| `/staff/money/providers` | `ProvidersPage` (pages/money/Providers.tsx) | `balance:read` or `report:read_finance` or `system:read` | staff |
| `/staff/account` | `StaffAccountPage` (pages/staff/Account.tsx) | staff session, no guard | staff |
| `/staff/none` | `NoAccess` (App.tsx) | staff session | staff |
| `/partner` (index) | `PartnerHome` (pages/partner/Partner.tsx) | partner session | partner |
| `/partner/register` | `RegisterCompany` (pages/partner/Partner.tsx) | partner session | partner |
| `/partner/org/:orgId` | `OrgPage` (pages/partner/Partner.tsx) | partner session; tabs and actions checked inline | partner |
| `/partner/org/:orgId/book` | `CorporateBooking` (pages/partner/Partner.tsx) | partner session; the page refuses without `trip:create_on_behalf` and `trip:bill_corporate @ ORG`, or when `features.corporateBooking` is off | partner |
| `/partner/org/:orgId/vehicles/:vehicleId` | `FleetVehiclePage` (pages/partner/Fleet.tsx) | partner session; actions checked inline | partner |
| `/partner/org/:orgId/trips` | `CompanyTripsPage` (pages/partner/CompanyTrips.tsx) | partner session; page needs `trip:read @ ORG` | partner |
| `/partner/org/:orgId/trips/:tripId` | `PartnerTripPage` (pages/partner/Trip.tsx) | partner session; page needs `trip:read @ ORG` | partner |
| `/partner/org/:orgId/earnings` | `FleetEarningsPage` (pages/partner/FleetEarnings.tsx) | partner session; page needs `earnings:read @ ORG` | partner |
| `/partner/org/:orgId/charges` | `CompanyChargesPage` (pages/partner/CompanyTrips.tsx) | partner session; page needs `payment:read @ ORG` | partner |
| `/partner/org/:orgId/drivers/:userId` | `PartnerDriverPage` (pages/partner/Driver.tsx) | partner session; page needs `driver:read @ ORG` (fleets) | partner |
| `/partner/account` | `PartnerAccountPage` (pages/partner/Account.tsx) | partner session | partner |
| `*` | inline "No such page." | none | all |

"Unscoped check" means `can(p, perm)` with no scope argument: the result depends on how `@ride-app/shared-authz` treats a missing scope (see [Role.md](../../../docs/design/Role.md)).

### Staff navigation

`staffSections(principal, { phoneBooking })` in [src/App.tsx](../src/App.tsx) builds the sidebar from the same predicates as the guards, in seven groups: **Today** (Live board, Live map, Book by phone, Find a trip, Search trips), **Support and safety** (SOS alerts, Incidents, Tickets, Lost items), **Onboarding** (Review queue, Drivers, Vehicles, Companies), **Accounts** (Suspend), **Money** (Overview, Balances, Rider payments, Money approvals, Payouts, Commission and limits, Payment providers), **Administration** (Overview, Reports, Users, Staff and roles, Roles and permissions, Approvals, Settings, Cities and vehicles, Announcements, System, Audit log), **You** (My account, always shown). Empty groups are hidden by `Shell`. Icons come from `ICONS` in [src/components/Shell.tsx](../src/components/Shell.tsx). The function is exported and tested in [tests/logic.test.ts](../tests/logic.test.ts).

### Shell

[src/components/Shell.tsx](../src/components/Shell.tsx) renders the sidebar (brand, sections, a summary of the user's roles), the top bar (current page label, a red "new trips paused" pill during maintenance, an Addis Ababa clock updated every 30 s, Sign out) and `<main>` with the `<Outlet/>`. The current item is the longest matching `to` prefix. Board, Live map and Book by phone render "flush" (full-bleed map, no banners). Other pages show the maintenance message and the announcements whose `audiences` include `staff` or `partner`.

## 4. Auth and sessions

The app keeps two independent sign-ins on one origin. Both are Better Auth instances inside auth-service. The details of the surfaces are in [Auth.md](../../../docs/design/Auth.md); this section covers what the browser code does.

| | Staff | Partner |
|---|---|---|
| `Surface` value | `"staff"` | `"partner"` |
| Better Auth base path | `/api/admin-auth` | `/api/auth` |
| Token audience (`principalOf`) | `ride-admin` | `ride-app` |
| Sign-in | `POST /sign-in/email`, then `POST /two-factor/verify-totp` if `twoFactorRedirect` | `POST /phone-number/send-otp`, then `POST /phone-number/verify` |
| Session credential | Cookie set by auth-service (`authHttp` uses `withCredentials: true`) | Cookie, same mechanism |
| Access token | `GET /api/admin-auth/token`, kept in memory | `GET /api/auth/token`, kept in memory |

### Token handling ([src/lib/api.ts](../src/lib/api.ts))

- `authHttp`: axios instance for Better Auth endpoints, with credentials. `authCall(surface, path, body?)` does a GET without a body and a POST with one.
- `http`: axios instance for service calls. A request with `surface` set gets `Authorization: Bearer <token>` from `accessToken(surface)`.
- `accessToken(surface, force)` keeps one `{ token, claims }` per surface in a module-level object. It reuses the cached token while it has more than 60 s left, otherwise calls `/token`. A 401 or 403 from `/token` clears the cache and returns `null` (signed out); other errors are thrown. Claims are decoded from the JWT payload with `atob`; the signature is not checked in the browser.
- No token is ever written to `localStorage`, `sessionStorage` or a cookie by the app. The only browser storage is two id lists, see [section 8](#8-state).
- On a 401 from a service, the response interceptor retries the same request once with `retried: true`, which forces a fresh `/token`. A second 401 becomes `ApiError(401, "signed_out", "Your session ended. Sign in again.")`. The comment gives the reasons: an expired token or a role change (`pv`). The retry repeats the original method, body and headers, including any `Idempotency-Key`.
- `api(surface, path, { method, body, idempotencyKey })` is the wrapper pages use. Method defaults to GET without a body, POST with one. `newIdempotencyKey()` returns `web-<uuid>`.
- `principalOf(surface, claims)` builds a `Principal` (`userId`, `audience`, `roles` via `parseRoleClaims`, `permissionVersion`, `amr`). `allowed(p, perm, scope?)` and `citiesFor(p, perm, cities)` are UI helpers over `can()`.

### Session state ([src/lib/session.tsx](../src/lib/session.tsx))

- `useClaims(surface)`: a query `["session", surface]` that calls `accessToken(surface, true)` and stores its claims (`null` if signed out). `staleTime` 5 min, no retry. It runs for both surfaces on every page load except public pages: on a path starting with `/t/` the query is disabled (`enabled: !onPublicPage()`), so the shared-trip page makes no token calls.
- `useAuthz(surface)`: once a staff (preferred) or partner session exists, fetches `GET /api/identity/authz` every 60 s and passes it to `setAuthzSnapshot()`, so `can()` reads the live matrix instead of the bundled fallback. Staff `loading` stays true until the first snapshot arrives.
- `principal` objects are re-derived when the matrix `version` changes.
- `refresh(surface)` drops the cached token and refetches the session query. Sign-in pages, setup and company registration call it.
- `signOut(surface)` posts `/sign-out`, forgets the token, removes every cached query except the session ones, and sets that surface's session to `null`.

### Staff setup

A staff token carries a `setup` claim (`{ twoFactor, changePassword }`) and no roles until the temporary password is replaced and an authenticator is enrolled ([Auth.md §8](../../../docs/design/Auth.md#8-sessions-and-tokens)). `StaffArea` shows [StaffSetup](../src/pages/staff/Setup.tsx) for every `/staff/*` URL while the claim is present.

### Permissions in the UI

Pages call `allowed(staff.principal, perm, { cityId })` or `{ orgId }` to show buttons, tabs and forms. This is presentation only; the comments in `api.ts` and the README say every service checks the same matrix on every request.

## 5. Data fetching

### Query client ([src/main.tsx](../src/main.tsx))

| Option | Value | Effect |
|---|---|---|
| `retry` | `(count, err) => !(err instanceof ApiError && err.status < 500) && count < 2` | 4xx are not retried; network errors and 5xx get up to 2 retries |
| `refetchOnWindowFocus` | `false` | Data refreshes only by polling, invalidation or remount |

Mutation defaults are TanStack's (no retry).

### Conventions seen in the code

- Reads are `useQuery` with an array key that starts with a domain word: `"board"`, `"drivers"`, `"trip"`, `"fleet-…"`, `"money"`, `"admin-…"`, `"approvals"`, `"audit"`, `"system"`, `"session"`, `"authz"`, `"client-config"`.
- Writes are `useMutation`; `onSuccess` invalidates by key prefix (for example `["money"]`, `["board"]`, `["approvals"]`, `["admin-users"]`) or writes the returned object with `setQueryData` (trip cancel).
- Some forms call `api()` directly inside an async handler with local `busy`/`error` state instead of `useMutation` (sign-in, setup, Safety, PhoneBooking).
- City-scoped lists use `enabled: !!cityId`. Permission-dependent reads use `enabled: allowed(...)`.
- Lists with a `next` cursor use `useInfiniteQuery` and a "Load older" button: the audit log, trip search, company trips and charges, rider payments and a balance's statement (`before`), tickets, lost items and incidents. Users uses a cursor stack in state; Balances uses `limit`/`offset`; the fleet directories ask for 50, then up to fleet-service's maximum of 200 (no cursor).

### Polling

| What | Interval | Where |
|---|---|---|
| Client config | 60 s | lib/platform.tsx |
| Permission matrix | 60 s | lib/session.tsx |
| Live drivers in a city | 5 s | lib/hooks.ts `useCityDrivers` (Board, Live map, Trip detail) |
| Live board | 8 s | lib/hooks.ts `useBoard` |
| One trip | 8 s | staff/TripDetail.tsx |
| Trip history (`/events`) | 15 s | staff/TripDetail.tsx |
| Trip money | 10 s | staff/TripDetail.tsx |
| SOS queue and one alert | 5 s | safety/SosQueue.tsx |
| Incidents list; one incident | 30 s; 20 s | safety/Incidents.tsx |
| Tickets list; one ticket | 30 s; 15 s | support/Tickets.tsx |
| Lost items list; one item | 30 s; 15 s | support/LostItems.tsx |
| Partner trip; its car position | 8 s until it ends; 5 s while on the road (15 s after an error) | partner/Trip.tsx |
| Fleet driver (partner) | 30 s | partner/Driver.tsx |
| Shared trip | 5 s, stops on `completed`, `cancelled` or error | public/SharedTrip.tsx |
| Review queue | 30 s | staff/Fleet.tsx |
| Fleet overview (partner) | 30 s | partner/Fleet.tsx |
| Admin stats | identity 60 s, trips 30 s, fleet 60 s | admin/Overview.tsx |
| City money view (balances, payments waiting or failed) | 30 s | money/Overview.tsx (staff without the platform-wide view) |
| System report | 15 s | admin/System.tsx (also used by admin Overview) |
| Money overview | 30 s; ledger integrity 5 min | money/Overview.tsx |
| One balance (staff), fleet balance (partner) | 15 s | money/Balances.tsx, partner/Partner.tsx |
| Top-ups on a balance | 3 s while any is `ACTION_REQUIRED`, otherwise off | money/BalancePanel.tsx |
| Payments list | 15 s; one payment 5 s | money/Payments.tsx |
| Payout batches | 15 s; one batch 3 s while `SENDING`, else 20 s | money/Payouts.tsx |
| Payment providers | 15 s | money/Providers.tsx |

Clocks that only re-render (no network) use `useNow(ms)` in [src/lib/hooks.ts](../src/lib/hooks.ts): 5 s on the board, 15 s on System, 60 s on lists that show "waiting since".

## 6. Maps

### CityMap ([src/components/map/CityMap.tsx](../src/components/map/CityMap.tsx))

- Uses `maplibre-gl` directly, no React wrapper. `setWorkerUrl()` points MapLibre at the worker file Vite emits (`maplibre-gl-worker.mjs?url`).
- Style: `MAP_STYLE_URL = import.meta.env.VITE_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/liberty"`.
- Initial bounds come from `CITIES[cityId]` in `@ride-app/shared-location` (fallback `addis-ababa`), not from the client-config city list.
- Options: compact attribution, `dragRotate: false`, `pitchWithRotate: false`; a zoom control (no compass) at bottom-right when interactive.
- `fit`: when the points change, one point eases to it (zoom ≥ 14), several fit their bounds (padding 80, max zoom 15), none fits the city box. `fitOnce` stops refitting after the first fit.
- A map `error` whose message mentions style, source, tile or fetch shows "Map tiles unavailable. Positions still update." over the map; `load` clears it.
- A `ResizeObserver` keeps the canvas sized. The map instance is shared with children through `MapCtx` (`useMap()`).
- `boxed` renders a rounded map inside a page; otherwise it fills its positioned parent.

### Markers and lines ([src/components/map/markers.tsx](../src/components/map/markers.tsx))

| Component | Drawn as | Used on |
|---|---|---|
| `DriverMarker` | DOM marker `.mk-driver`, rotated by `heading`; classes `trip`, `stale`, `selected` | Board (free drivers), Live map, Trip detail, partner Trip, Shared trip |
| `PickupMarker` | DOM pin `.mk-pin` anchored at the bottom, tone `amber`/`red`/`blue`/`green`/`grey`, optional label | Board, Phone booking, Trip detail, Corporate booking, Shared trip |
| `DropoffMarker` | DOM pin `.mk-pin.dropoff` | Phone booking, Trip detail, Corporate booking, Shared trip |
| `TripLine` | GeoJSON line, `#0f172a`, width 2, dashed, between two points | Fallback when there is no road line: Phone booking and Corporate booking before the route loads, Trip detail for a trip without `route.polyline`, partner Trip |
| `RouteLine` | GeoJSON line with a white 8 px casing and a 5 px coloured line (default `#d97706`) through decoded points | Shared trip (`routePolyline`), Trip detail (`trip.route.polyline`), Phone booking and Corporate booking (`GET /api/maps/route` preview) |

Markers register through context, so pages only declare what is on the map. Layers are added on `load` if the style is not ready yet and removed on unmount.

`decodePolyline6()` ([src/lib/polyline.ts](../src/lib/polyline.ts)) decodes Google's encoded polyline at precision 6.

## 7. Design system

Plain CSS, no CSS-in-JS or utility framework.

| File | Contents |
|---|---|
| [src/styles/tokens.css](../src/styles/tokens.css) | `:root` custom properties: surfaces (`--canvas`, `--surface`, `--surface-2`), borders, text greys, accent amber (`--accent #d97706`, `--accent-strong`, `--accent-soft`, `--accent-ring`), status colours (success, warning, danger, info and their `-soft` variants), fonts (`--font` Inter, `--mono` JetBrains Mono, `--ethiopic` Noto Serif Ethiopic), radii (`--r-sm` 6, `--r` 8, `--r-lg` 12 px), three shadows, `--sidebar-w` 232 px, `--topbar-h` 56 px, `--gutter`, `--ease`. `color-scheme: light`; there is no dark theme |
| [src/styles/base.css](../src/styles/base.css) | Element defaults; a `prefers-reduced-motion: reduce` block |
| [src/styles/components.css](../src/styles/components.css) | Buttons, fields, cards, pills, tables, tabs, chips, drawer, alerts, documents, shared-trip page and more; `max-width: 860px` rules |
| [src/styles/layout.css](../src/styles/layout.css) | Shell, map workspaces (`.workspace`, `.panel`, `.map-area`, `.stats-float`), markers (`.mk-*`), sign-in backdrop; breakpoints at 1100 px and 860 px |

React building blocks in [src/components/ui.tsx](../src/components/ui.tsx):

| Component | Purpose |
|---|---|
| `Logo`, `Brand` | The አ mark and "Anbessa" with a subtitle |
| `Pill` | Status pill with tone `amber` / `blue` / `green` / `red` / `grey`, optional pulse |
| `TripStatus`, `tripTone` | Trip status → tone: requested amber (pulsing), matched/en_route blue, in_progress green, completed grey, cancelled red |
| `Field`, `SelectField`, `TextArea` | Labelled inputs with `useId` and an optional hint |
| `Problem` | Turns an error into an alert, see [section 9](#9-error-handling) |
| `Notice` | Info / ok / error alert |
| `PageHead` | Title, lede, right-hand actions |
| `Empty` | Empty state |
| `Stat` | Headline number, optional `urgent` style |
| `Drawer` | Side panel with backdrop, closes on Escape or backdrop click |

[src/components/BarChart.tsx](../src/components/BarChart.tsx) draws a grouped bar chart in plain SVG (no chart library), one group per day, using `niceMax`/`barHeight` from [src/lib/reports.ts](../src/lib/reports.ts). Used by Reports and the fleet Earnings page.

Icons come from `lucide-react`. Fonts are loaded from Google Fonts in [index.html](../index.html).

## 8. State

- **Server state**: TanStack Query only. There is no Redux, Zustand or other global store.
- **Global React context**: `ConfigProvider` (client config), `SessionProvider` (both surfaces), `MapCtx` (inside a map).
- **Module state**: the access-token cache in `lib/api.ts`; the city list in `lib/format.ts`, mutated in place by `applyCities()`; the permission matrix inside `@ride-app/shared-authz` via `setAuthzSnapshot()`.
- **URL state**: `?tab=` on the partner org page, `?org=` on Companies (open drawer), `?user=` on Suspend (open person drawer), `?tab=history` on Money approvals, `?city=` on Commission and limits, `?role=billing|fleet` on company trips, `?backup=used` on My account after a backup-code sign-in, all audit filters on the Audit log.
- **Local state**: everything else (`useState`), including the city picked with `CityPicker`; it is not persisted and resets on reload.
- **Browser storage** (ids only, never tokens or personal data; read and write are wrapped in `try`, so blocked storage just means no list):
  - `localStorage` `anbessa.staff.recentTrips`: the last 8 trip ids opened on Find a trip, shown as "Recently opened" chips with a "clear" link ([src/lib/trips.ts](../src/lib/trips.ts)).
  - `sessionStorage` `anbessa.partner.booked`: up to 30 trips booked from this tab on a company account (id, rider label, from/to, car type, fare, time), shown on the company page; gone when the tab closes ([src/lib/partner.ts](../src/lib/partner.ts)).
  - Backup codes on My account live only in component state while on screen.

## 9. Error handling

- Every failure leaving `lib/api.ts` is an `ApiError(status, code, message)`. With a response, `code` is the body's `error` or `code` (else `"error"`) and `message` the body's `message` (else `Request failed (<status>)`). Without a response: `ApiError(0, "network", "Can't reach the server. Check your connection and try again.")`.
- `Problem` ([src/components/ui.tsx](../src/components/ui.tsx)) shows: for 403 a fixed "You don't have permission for this…" text; for 503 the message plus "Try again in a minute."; otherwise the server message; for non-`ApiError` values a generic connection message.
- Pages render `<Problem error={query.error ?? mutation.error} />` near the top. There is no React error boundary in `src/`.
- Map tile failures are shown on the map only; the rest of the page keeps working.
- `PlacePicker` falls back to the built-in `COMMON_PLACES` list and says "Address search is offline" when `/api/maps/search` fails; Phone booking keeps the raw coordinates when `/api/maps/reverse` fails.
- The shared-trip page treats 404 as "This link has ended" and offers "Try again" for other errors.

## 10. Internationalisation, time and money

- No i18n library; all UI text is English in the components. `index.html` has `lang="en"`.
- Times are formatted with `toLocaleString("en-GB", { timeZone: "Africa/Addis_Ababa" })` ([src/lib/format.ts](../src/lib/format.ts), Shell clock).
- Money is integer santim (1 ETB = 100); `birr()` formats with `en-ET` and the suffix `ETB`. `toMinor()` in [src/lib/money.ts](../src/lib/money.ts) turns typed birr into santim. Basis points are shown with `percent()`.
- Phone numbers: `toE164()` accepts `09…`, `07…`, `9…`, `+251…`; `phone()` formats `+251 91 122 3344`. Phone-only accounts use a placeholder email `<digits>@phone.anbessa.invalid` (`phoneToPlaceholderEmail`, `placeholderEmailToPhone`), which is how partner invitations by phone are sent through Better Auth's email-based organisation API.
