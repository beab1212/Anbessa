# API usage

Every backend endpoint the web app calls, found by searching `src/` for `api(`, `authCall(`, `http.get(` and `axios.put(`. Paths are as the browser sends them (relative, same origin). The service column follows the prefix routing in [vite.config.ts](../vite.config.ts) and [infra/kong/kong.yml](../../../infra/kong/kong.yml).

Token column:

- **staff**: `Authorization: Bearer` with the `ride-admin` access token
- **partner**: `Authorization: Bearer` with the `ride-app` access token
- **cookie**: a Better Auth call with the surface's session cookie (`authHttp`, `withCredentials: true`), no bearer token
- **none**: no credentials

`Idem` marks calls sent with an `Idempotency-Key: web-<uuid>` header.

For request and response shapes, see each service's code and [docs/api/README.md](../../../docs/api/README.md).

## auth-service: Better Auth, admin surface (`/api/admin-auth`)

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/admin-auth/token` | cookie | `lib/api.ts` `accessToken("staff")`; every staff call, session start |
| POST | `/api/admin-auth/sign-in/email` | cookie | pages/SignIn.tsx `StaffSignIn`, dev/DevSignIn.tsx |
| POST | `/api/admin-auth/two-factor/verify-totp` | cookie | `StaffSignIn`, staff/Setup.tsx, DevSignIn |
| POST | `/api/admin-auth/change-password` | cookie | staff/Setup.tsx |
| POST | `/api/admin-auth/two-factor/enable` | cookie | staff/Setup.tsx |
| POST | `/api/admin-auth/sign-out` | cookie | `lib/session.tsx` `signOut("staff")` (Shell → Sign out) |

## auth-service: Better Auth, app surface (`/api/auth`)

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/auth/token` | cookie | `accessToken("partner")`; every partner call, session start |
| POST | `/api/auth/phone-number/send-otp` | cookie | `PartnerSignIn`, DevSignIn |
| POST | `/api/auth/phone-number/verify` | cookie | `PartnerSignIn`, DevSignIn |
| POST | `/api/auth/sign-out` | cookie | `signOut("partner")` |
| GET | `/api/auth/organization/list` | cookie | partner/Partner.tsx `useOrgs` (partner Shell, PartnerHome) |
| POST | `/api/auth/organization/create` | cookie | `RegisterCompany` |
| GET | `/api/auth/organization/get-full-organization?organizationId=` | cookie | `OrgPage`, `CorporateBooking`, partner/Fleet.tsx `FleetVehiclePage` |
| POST | `/api/auth/organization/invite-member` | cookie | `OrgPage` |
| POST | `/api/auth/organization/cancel-invitation` | cookie | `OrgPage` |
| POST | `/api/auth/organization/remove-member` | cookie | `OrgPage` |

## auth-service: development only (`/api/dev`)

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/dev/accounts` | none | dev/DevSignIn.tsx |
| GET | `/api/dev/code?email=` / `?phone=` | none | dev/DevSignIn.tsx |

Served only with `DEV_LOGIN=on`; not routed by `infra/kong/kong.yml` (the generated `kong.dev.yml` adds it).

## auth-service: identity API (`/api/identity`)

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/identity/authz` | staff, else partner | `lib/session.tsx` (every 60 s), admin/Roles.tsx |
| POST | `/api/identity/authz/preview` | staff | Roles (role editor) |
| POST | `/api/identity/authz/changes` | staff | Roles (edit, archive, new custom role) |
| GET | `/api/identity/approvals?status=&action=` | staff | admin/Approvals.tsx, admin/Overview.tsx, admin/Roles.tsx (`action=authz:change`), staff/People.tsx (`action=role:grant`) |
| POST | `/api/identity/approvals/:id/approve` · `/reject` · `/cancel` | staff | admin/Approvals.tsx |
| GET | `/api/identity/users?kind=&q=&status=&cursor=&limit=` | staff | admin/Users.tsx, staff/People.tsx, `useStaffNames` (admin and money approvals, audit) |
| GET | `/api/identity/users/:id` | staff | admin/Users.tsx `UserPage` |
| POST | `/api/identity/users/:id/sessions/revoke` | staff | `UserPage` |
| POST | `/api/identity/users/:id/reset-mfa` | staff | `UserPage` |
| POST | `/api/identity/users/:id/suspend` | staff | `UserPage`, staff/Safety.tsx |
| POST | `/api/identity/users/:id/reinstate` | staff | `UserPage`, staff/Safety.tsx |
| GET | `/api/identity/stats` | staff | admin/Overview.tsx |
| POST | `/api/identity/staff-accounts` | staff | staff/People.tsx |
| POST | `/api/identity/staff-role-requests` | staff | staff/People.tsx |
| POST | `/api/identity/staff-roles/revoke` | staff | staff/People.tsx |
| GET | `/api/identity/organizations?cityId=&status=` | staff | staff/Onboarding.tsx, staff/Fleet.tsx (company names) |
| POST | `/api/identity/organizations/:id/verify` | staff | staff/Onboarding.tsx |
| POST | `/api/identity/organizations/:id/suspend` | staff | staff/Onboarding.tsx |
| POST | `/api/identity/guests` | staff | staff/PhoneBooking.tsx |

## trip-service (`/api/trips`)

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/trips/board?cityId=` | staff | `lib/hooks.ts` `useBoard` (Board, every 8 s) |
| GET | `/api/trips/:id` | staff | staff/TripDetail.tsx (every 8 s) |
| POST | `/api/trips/:id/assign` | staff, Idem | staff/Board.tsx |
| POST | `/api/trips/:id/cancel` | staff, Idem | staff/Board.tsx, staff/TripDetail.tsx |
| POST | `/api/trips` | staff, Idem | staff/PhoneBooking.tsx |
| POST | `/api/trips` | partner, Idem | partner/Partner.tsx `CorporateBooking` |
| GET | `/api/trips/stats` | staff | admin/Overview.tsx |
| GET | `/api/trips/shared/:token` | none | public/SharedTrip.tsx (every 5 s) |

## location-service (`/api/locations`)

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/locations/cities/:cityId/drivers` | staff | `lib/hooks.ts` `useCityDrivers` (Board, Drivers, TripDetail; every 5 s) |

## pricing-service (`/api/pricing`)

| Method | Path | Token | Used by |
|---|---|---|---|
| POST | `/api/pricing/estimates` | staff | staff/PhoneBooking.tsx |
| POST | `/api/pricing/estimates` | partner | `CorporateBooking` |

## mapping-service (`/api/maps`)

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/maps/search?q=&cityId=` | staff or partner (caller's surface) | components/PlacePicker.tsx |
| GET | `/api/maps/reverse?lat=&lng=` | staff | staff/PhoneBooking.tsx (map tap) |

## fleet-service (`/api/fleet`)

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/fleet/review/queue?cityId=` | staff | staff/Fleet.tsx `ReviewQueuePage` (every 30 s) |
| GET | `/api/fleet/drivers?cityId=&status=&q=` | staff | `DriverDirectory` |
| GET | `/api/fleet/drivers/:userId` | staff | `DriverRecord` |
| POST | `/api/fleet/drivers/:userId/request-changes` · `/approve` · `/suspend` · `/reinstate` | staff | `DriverRecord` |
| GET | `/api/fleet/vehicles?cityId=&status=` | staff | `VehicleDirectory` |
| GET | `/api/fleet/vehicles/:id` | staff | `VehicleRecord` |
| GET | `/api/fleet/vehicles/:id` | partner | `FleetVehiclePage` |
| POST | `/api/fleet/vehicles/:id/approve` · `/reject` | staff | `VehicleRecord` |
| POST | `/api/fleet/vehicles` | partner | partner/Fleet.tsx `AddVehicle` |
| POST | `/api/fleet/vehicles/:id/submit` · `/retire` | partner | `FleetVehiclePage` |
| POST | `/api/fleet/vehicles/:id/authorizations` | partner | `FleetVehiclePage` |
| DELETE | `/api/fleet/vehicles/:id/authorizations/:driverUserId` | partner | `FleetVehiclePage` |
| GET | `/api/fleet/organizations/:orgId/overview?members=` | partner | partner/Fleet.tsx `useFleetOverview` (every 30 s) |
| GET | `/api/fleet/documents?subjectType=&subjectId=` | staff or partner | components/Documents.tsx `useDocuments` |
| GET | `/api/fleet/documents/:id/url` | staff or partner | `DocumentViewer` |
| POST | `/api/fleet/documents/:id/review` | staff | `DocumentViewer` |
| POST | `/api/fleet/documents/upload-url` | staff or partner | `lib/fleet.ts` `uploadDocument` |
| PUT | `<uploadUrl>` returned by upload-url | none (signed URL) | `uploadDocument` (S3, or fleet-service in local storage mode) |
| POST | `/api/fleet/documents` | staff or partner | `uploadDocument` (confirm with the ticket) |
| GET | `/api/fleet/stats` | staff | admin/Overview.tsx |

In practice only owner-mode checklists upload, and those are on partner pages; staff checklists are in review mode.

## payment-service (`/api/payments`)

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/payments/overview` | staff | money/Overview.tsx (every 30 s) |
| GET | `/api/payments/ledger/integrity` | staff | money/Overview.tsx (every 5 min) |
| GET | `/api/payments/balances?limit=&offset=&state=&type=&q=` | staff | money/Balances.tsx `BalancesPage` |
| GET | `/api/payments/balances/:accountId` | staff | `BalancePage` (every 15 s) |
| GET | `/api/payments/balances/org/:orgId?cityId=&open=` | partner | partner/Partner.tsx `FleetBalance` (every 15 s) |
| GET | `/api/payments/balances/:accountId/statement?limit=30` | staff or partner | money/BalancePanel.tsx |
| GET | `/api/payments/balances/:accountId/top-ups` | staff or partner | `BalancePanel` |
| POST | `/api/payments/balances/:accountId/top-ups` | partner, Idem | `BalancePanel` `TopUpDrawer` (owner) |
| PUT | `/api/payments/balances/:accountId/payout-method` | partner | `BalancePanel` `PayoutMethodDrawer` (owner) |
| GET | `/api/payments/methods` | partner | `TopUpDrawer` |
| POST | `/api/payments/top-ups/manual` | staff, Idem | `RecordCashDrawer` (Balances list and one balance) |
| GET | `/api/payments/top-ups?status=PENDING_APPROVAL` | staff | money/Approvals.tsx |
| POST | `/api/payments/top-ups/:id/approve` · `/reject` | staff | money/Approvals.tsx |
| GET | `/api/payments/refunds?status=PENDING_APPROVAL` | staff | money/Approvals.tsx |
| POST | `/api/payments/refunds/:id/approve` · `/reject` | staff | money/Approvals.tsx |
| GET | `/api/payments/payments?limit=100&status=` | staff | money/Payments.tsx (every 15 s) |
| GET | `/api/payments/payments/:id` | staff | `PaymentDrawer` (every 5 s) |
| POST | `/api/payments/payments/:id/reconcile` | staff | `PaymentDrawer` |
| POST | `/api/payments/payments/:id/refunds` | staff, Idem | `PaymentDrawer` refund form |
| GET | `/api/payments/trips/:tripId` | staff | staff/TripDetail.tsx `TripPayments` (every 10 s) |
| GET | `/api/payments/payouts` | staff | money/Payouts.tsx (every 15 s), money/Approvals.tsx |
| GET | `/api/payments/payouts/:id` | staff | money/Payouts.tsx (3 s while sending, else 20 s) |
| POST | `/api/payments/payouts/:id/approve` · `/reject` | staff | money/Approvals.tsx |
| POST | `/api/payments/settlements/run` | staff | money/Payouts.tsx |
| GET | `/api/payments/rules?cityId=` | staff | money/Rules.tsx |
| GET | `/api/payments/rules/pending` | staff | money/Approvals.tsx |
| POST | `/api/payments/rules/changes` | staff | money/Rules.tsx |
| POST | `/api/payments/rules/changes/:id/approve` · `/reject` · `/cancel` | staff | money/Approvals.tsx |
| GET | `/api/payments/gateways` | staff | money/Providers.tsx (every 15 s) |

`useProviders()` in BalancePanel.tsx would call `GET /api/payments/methods` with the staff token, but nothing imports it.

## platform-service (`/api/platform`)

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/platform/client-config` | none | `lib/platform.tsx` `ConfigProvider` (every 60 s) |
| GET | `/api/platform/settings` | staff | admin/Settings.tsx, admin/Approvals.tsx (labels) |
| PUT | `/api/platform/settings/:key` | staff | admin/Settings.tsx |
| GET | `/api/platform/settings/history?key=` | staff | admin/Settings.tsx |
| GET | `/api/platform/settings/changes?status=` | staff | admin/Approvals.tsx, admin/Overview.tsx |
| POST | `/api/platform/settings/changes/:id/approve` · `/reject` · `/cancel` | staff | admin/Approvals.tsx |
| GET | `/api/platform/cities` | staff | admin/Cities.tsx |
| POST | `/api/platform/cities` | staff | admin/Cities.tsx (add) |
| PUT | `/api/platform/cities/:id` | staff | admin/Cities.tsx (edit) |
| GET | `/api/platform/vehicle-types` | staff | admin/Cities.tsx |
| PUT | `/api/platform/vehicle-types/:code` | staff | admin/Cities.tsx (add and edit) |
| GET | `/api/platform/announcements` | staff | admin/Announcements.tsx |
| POST | `/api/platform/announcements` | staff | admin/Announcements.tsx (new) |
| PUT | `/api/platform/announcements/:id` | staff | admin/Announcements.tsx (edit) |
| POST | `/api/platform/announcements/:id/archive` | staff | admin/Announcements.tsx |
| GET | `/api/platform/system` | staff | admin/System.tsx (every 15 s), admin/Overview.tsx |
| GET | `/api/platform/system?refresh=true` | staff | admin/System.tsx "Check now" |

## audit-service (`/api/audit`)

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/audit/entries?actorId=&action=&resourceType=&resourceId=&outcome=&service=&from=&to=&limit=&cursor=` | staff | admin/Audit.tsx, admin/Users.tsx `AuditTrail` |
| GET | `/api/audit/entries.csv?…` | staff | admin/Audit.tsx export |

## Outside the API

| Request | From | Notes |
|---|---|---|
| Map style, tiles, sprites, glyphs | MapLibre in `CityMap` | `VITE_MAP_STYLE_URL`, default `https://tiles.openfreemap.org/styles/liberty` |
| Fonts | `index.html` | `fonts.googleapis.com`, `fonts.gstatic.com` |
| Document files | `DocumentViewer` `<img>` / `<iframe>` | the signed URL from `/api/fleet/documents/:id/url` |
| Payment pages | links in PaymentDrawer and BalancePanel | `checkoutUrl` from payment-service, opened in a new tab |
| Driver photo | `SharedTrip` `<img>` | `driver.photo` URL from trip-service |

## Prefixes in Kong that the web app does not call

`/api/notifications` and `/api/webhooks/telegram-gateway` (notification-service) and `/api/payments/webhooks` (provider callbacks) are routed by Kong but never called from `src/`. The Vite proxy has no entry for notification-service.
