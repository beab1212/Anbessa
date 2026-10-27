# API usage

Every backend endpoint the web app calls, found by searching `src/` for `api(`, `authCall(`, `http.get(`, `axios.put(` and `supportApi`. Paths are as the browser sends them (relative, same origin). The service column follows the prefix routing in [vite.config.ts](../vite.config.ts) and [infra/kong/kong.yml](../../../infra/kong/kong.yml).

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
| GET | `/api/admin-auth/token` | cookie | `lib/api.ts` `accessToken("staff")`; every staff call, session start (not on `/t/...` public pages) |
| POST | `/api/admin-auth/sign-in/email` | cookie | pages/SignIn.tsx `StaffSignIn`, dev/DevSignIn.tsx |
| POST | `/api/admin-auth/two-factor/verify-totp` | cookie | `StaffSignIn`, staff/Setup.tsx, DevSignIn |
| POST | `/api/admin-auth/two-factor/verify-backup-code` | cookie | `StaffSignIn` (backup-code path) |
| POST | `/api/admin-auth/change-password` | cookie | staff/Setup.tsx, staff/Account.tsx |
| POST | `/api/admin-auth/two-factor/enable` | cookie | staff/Setup.tsx |
| POST | `/api/admin-auth/two-factor/generate-backup-codes` | cookie | staff/Account.tsx |
| GET | `/api/admin-auth/get-session` | cookie | staff/Account.tsx |
| POST | `/api/admin-auth/update-user` | cookie | staff/Account.tsx (name) |
| GET | `/api/admin-auth/list-sessions` | cookie | staff/Account.tsx |
| POST | `/api/admin-auth/revoke-session` · `/revoke-other-sessions` | cookie | staff/Account.tsx |
| POST | `/api/admin-auth/sign-out` | cookie | `lib/session.tsx` `signOut("staff")` (Shell → Sign out) |

## auth-service: Better Auth, app surface (`/api/auth`)

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/auth/token` | cookie | `accessToken("partner")`; every partner call, session start (not on `/t/...` public pages) |
| POST | `/api/auth/phone-number/send-otp` | cookie | `PartnerSignIn`, DevSignIn |
| POST | `/api/auth/phone-number/verify` | cookie | `PartnerSignIn`, DevSignIn |
| POST | `/api/auth/sign-out` | cookie | `signOut("partner")` |
| GET | `/api/auth/get-session` | cookie | partner/Account.tsx |
| POST | `/api/auth/update-user` | cookie | partner/Account.tsx (name) |
| GET | `/api/auth/list-sessions` | cookie | partner/Account.tsx |
| POST | `/api/auth/revoke-session` · `/revoke-other-sessions` | cookie | partner/Account.tsx |
| GET | `/api/auth/organization/list` | cookie | partner/Partner.tsx `useOrgs` (partner Shell, PartnerHome) |
| POST | `/api/auth/organization/create` | cookie | `RegisterCompany` |
| GET | `/api/auth/organization/get-full-organization?organizationId=` | cookie | `OrgPage`, `CorporateBooking`, partner/Fleet.tsx `FleetVehiclePage`, partner Trip, Driver, CompanyTrips pages |
| POST | `/api/auth/organization/update` | cookie | `OrgPage` `EditCompany` (name, logo) |
| GET | `/api/auth/organization/list-invitations?organizationId=` | cookie | `OrgPage` |
| POST | `/api/auth/organization/invite-member` | cookie | `OrgPage` |
| POST | `/api/auth/organization/cancel-invitation` | cookie | `OrgPage` |
| POST | `/api/auth/organization/update-member-role` | cookie | `OrgPage` (employee ↔ travel desk) |
| POST | `/api/auth/organization/remove-member` | cookie | `OrgPage` |
| GET | `/api/auth/organization/list-user-invitations` | cookie | partner/Account.tsx |
| POST | `/api/auth/organization/accept-invitation` · `/reject-invitation` | cookie | partner/Account.tsx |

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
| GET | `/api/identity/users?kind=&q=&status=&cursor=&limit=` | staff | admin/Users.tsx, staff/People.tsx, staff/Safety.tsx (find a person), `useStaffNames` (admin and money approvals, audit, settings, payouts, rules) |
| GET | `/api/identity/users/:id` | staff | admin/Users.tsx `UserPage`, staff/Safety.tsx person drawer |
| POST | `/api/identity/users/:id/sessions/revoke` | staff | `UserPage` |
| POST | `/api/identity/users/:id/reset-mfa` | staff | `UserPage` |
| POST | `/api/identity/users/:id/suspend` | staff (Idem from Safety) | `UserPage`, staff/Safety.tsx (`until` optional) |
| POST | `/api/identity/users/:id/reinstate` | staff (Idem from Safety) | `UserPage`, staff/Safety.tsx |
| GET | `/api/identity/stats?cityId=` | staff | admin/Overview.tsx (no `cityId` = every city) |
| POST | `/api/identity/staff-accounts` | staff | staff/People.tsx |
| POST | `/api/identity/staff-role-requests` | staff | staff/People.tsx |
| POST | `/api/identity/staff-roles/revoke` | staff | staff/People.tsx |
| GET | `/api/identity/organizations?cityId=&status=` | staff | staff/Onboarding.tsx, staff/Fleet.tsx (company names) |
| POST | `/api/identity/organizations/:id/verify` | staff | staff/Onboarding.tsx |
| POST | `/api/identity/organizations/:id/suspend` | staff, Idem | staff/Onboarding.tsx `SuspendOrgDrawer` |
| POST | `/api/identity/organizations/:id/reinstate` | staff | staff/Onboarding.tsx `ReinstateOrgDrawer` |
| GET | `/api/identity/organizations/:id/members` | staff | staff/Onboarding.tsx `CompanyMembers` |
| GET | `/api/identity/organizations?cityId=&status=VERIFIED` | staff | staff/Fleet.tsx `StartTransfer` (fleets to transfer to) |
| POST | `/api/identity/guests` | staff | staff/PhoneBooking.tsx |

## trip-service (`/api/trips`)

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/trips/board?cityId=` | staff | `lib/hooks.ts` `useBoard` (Board, every 8 s) |
| GET | `/api/trips/:id` | staff | staff/TripDetail.tsx (every 8 s) |
| GET | `/api/trips/:id` | partner | partner/Trip.tsx (every 8 s until it ends) |
| GET | `/api/trips/:id/events` | staff | staff/TripDetail.tsx timeline (every 15 s) |
| GET | `/api/trips/:id/parties` | staff | `lib/trips.ts` `useTripParties` (Board selected card, Live map drawer, TripDetail) |
| GET | `/api/trips/:id/parties` | partner | partner/Trip.tsx |
| POST | `/api/trips/:id/assign` | staff, Idem | staff/Board.tsx |
| POST | `/api/trips/:id/cancel` | staff, Idem | staff/Board.tsx, staff/TripDetail.tsx (`{ reason }` from `STAFF_CANCEL_REASONS`) |
| POST | `/api/trips/:id/cancel` | partner, Idem | partner/Trip.tsx (`BOOKER_CANCEL_REASONS`) |
| POST | `/api/trips` | staff, Idem | staff/PhoneBooking.tsx |
| POST | `/api/trips` | partner, Idem | partner/Partner.tsx `CorporateBooking` |
| GET | `/api/trips/search?cityId=&status=&from=&to=&channel=&paymentMethod=&riderUserId=&driverUserId=&vehicleId=&billingOrgId=&q=&limit=&before=` | staff | staff/TripSearch.tsx |
| GET | `/api/trips/org/:orgId?role=billing\|fleet&status=&from=&to=&limit=&before=` | partner | partner/CompanyTrips.tsx |
| GET | `/api/trips/reports/daily?cityId=&from=&to=` | staff | reports/Reports.tsx (Trips tab) |
| GET | `/api/trips/reports/daily.csv?cityId=&from=&to=` | staff | Reports "Download CSV" (`downloadCsv`) |
| GET | `/api/trips/stats?cityId=` | staff | admin/Overview.tsx |
| GET | `/api/trips/shared/:token` | none | public/SharedTrip.tsx (every 5 s) |
| GET | `/api/trips/scheduled?cityId=&status=` | staff | staff/Scheduled.tsx |
| GET | `/api/trips/scheduled?orgId=` | partner | partner/Scheduled.tsx |
| POST | `/api/trips/scheduled` | partner | partner/Scheduled.tsx (book ahead) |
| POST | `/api/trips/scheduled/:id/cancel` | staff or partner | Scheduled pages |
| POST | `/api/trips/:id/reassign` | staff, Idem | staff/Trace.tsx `ReassignButton` (Board, TripDetail) `{ driverId?, reason? }` |
| GET | `/api/trips/:id/trace?reason=` | staff | staff/Trace.tsx `TripTrace` (on demand, audited) |
| GET | `/api/trips/:id/trace.csv?reason=` | staff | Trace "Download CSV" |
| GET · PUT | `/api/trips/corporate/:orgId/policy` | partner | partner/Policies.tsx; `CorporateBooking` reads it for `purpose` |
| GET | `/api/trips/reports/regulatory?cityId=&from=&to=` | staff | reports/Regulatory.tsx |
| GET | `/api/trips/reports/regulatory.csv?cityId=&from=&to=` | staff | Regulatory "Download CSV" |

## location-service (`/api/locations`)

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/locations/cities/:cityId/drivers` | staff | `lib/hooks.ts` `useCityDrivers` (Board, Drivers, TripDetail; every 5 s) |
| GET | `/api/locations/trips/:tripId/driver` | partner | partner/Trip.tsx (every 5 s while on the road). Allowed for the booker, the billed company's `trip:read` holders and the fleet owner |

## pricing-service (`/api/pricing`)

| Method | Path | Token | Used by |
|---|---|---|---|
| POST | `/api/pricing/estimates` | staff | staff/PhoneBooking.tsx |
| POST | `/api/pricing/estimates` | partner | `CorporateBooking` |
| GET | `/api/pricing/fares?cityId=` | staff | `lib/trips.ts` `useFares` (PhoneBooking fare card) |
| GET | `/api/pricing/fares?cityId=` | none (`http.get` without a surface) | `CorporateBooking` (fare card per car type) |
| POST | `/api/pricing/estimates` | partner | partner/Scheduled.tsx |
| GET | `/api/pricing/fare-rules?cityId=` | staff | ops/Pricing.tsx |
| GET · POST | `/api/pricing/fare-changes` (`?cityId=&status=`) | staff | ops/Pricing.tsx |
| POST | `/api/pricing/fare-changes/preview` | staff | ops/Pricing.tsx (impact before proposing) |
| POST | `/api/pricing/fare-changes/:id/approve` · `/reject` · `/cancel` | staff | ops/Pricing.tsx (maker–checker) |
| GET · POST | `/api/pricing/zones` (`?cityId=&includeArchived=`) | staff | ops/Zones.tsx |
| PUT · DELETE | `/api/pricing/zones/:id` | staff | ops/Zones.tsx (edit, archive) |
| POST | `/api/pricing/zones/check` | staff | ops/Zones.tsx (polygon validation) |
| GET · POST | `/api/pricing/promos` (`?cityId=&limit=`) | staff | marketing/Promos.tsx |
| PUT | `/api/pricing/promos/:id` | staff | marketing/Promos.tsx |
| POST | `/api/pricing/promos/:id/activate` · `/pause` · `/resume` · `/archive` | staff | marketing/Promos.tsx |
| GET | `/api/pricing/promos/:id/redemptions?limit=50` | staff | marketing/Promos.tsx |

## mapping-service (`/api/maps`)

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/maps/search?q=&cityId=` | staff or partner (caller's surface) | components/PlacePicker.tsx |
| GET | `/api/maps/reverse?lat=&lng=` | staff | staff/PhoneBooking.tsx (map tap) |
| GET | `/api/maps/route?from=lat,lng&to=lat,lng` | staff | `lib/trips.ts` `useRoutePreview` (PhoneBooking) |
| GET | `/api/maps/route?from=&to=` | partner | `CorporateBooking` |

## fleet-service (`/api/fleet`)

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/fleet/review/queue?cityId=` | staff | staff/Fleet.tsx `ReviewQueuePage` (every 30 s) |
| GET | `/api/fleet/drivers?cityId=&limit=&status=&q=` | staff | `DriverDirectory` (50, then 200); `StartTransfer` driver search (20) |
| GET | `/api/fleet/drivers/:userId` | staff | `DriverRecord` |
| POST | `/api/fleet/drivers/:userId/request-changes` · `/approve` · `/suspend` · `/reinstate` | staff | `DriverRecord` |
| GET | `/api/fleet/vehicles?cityId=&limit=&status=` | staff | `VehicleDirectory` (50, then 200) |
| GET | `/api/fleet/vehicles?ownerOrgId=&cityId=&limit=200` | staff | staff/Onboarding.tsx company drawer (city staff list a company's cars in that city) |
| GET | `/api/fleet/vehicles?ownerOrgId=&status=RETIRED` | partner | partner/Fleet.tsx (retired cars) |
| GET | `/api/fleet/drivers/:userId?orgId=` | partner | partner/Driver.tsx (every 30 s) |
| GET | `/api/fleet/vehicles/:id` | staff | `VehicleRecord` |
| GET | `/api/fleet/vehicles/:id` | partner | `FleetVehiclePage`, partner/Trip.tsx (fleets) |
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
| GET | `/api/fleet/stats?cityId=` | staff | admin/Overview.tsx |
| POST | `/api/fleet/vehicles/:id/suspend` · `/reinstate` | staff | staff/Fleet.tsx `VehicleRecord` |
| POST | `/api/fleet/vehicles/:id/transfers` | staff | staff/Fleet.tsx `StartTransfer` (officer = maker) |
| POST | `/api/fleet/vehicles/:id/transfers` | partner | partner/Fleet.tsx `AskTransfer` (owner request) |
| GET | `/api/fleet/vehicles/:id/transfers` | staff or partner | `VehicleRecord`, `FleetVehiclePage` |
| GET | `/api/fleet/transfers?cityId=&limit=200` | staff | staff/Fleet.tsx `ReviewQueuePage` transfers tab (every 60 s) |
| GET | `/api/fleet/transfers?ownerOrgId=&limit=100` | partner | partner/Fleet.tsx `OpenTransfers` |
| POST | `/api/fleet/transfers/:id/endorse` · `/approve` · `/reject` | staff | staff/Fleet.tsx `TransferItem` |
| POST | `/api/fleet/transfers/:id/cancel` | staff or partner | `TransferItem`, `FleetVehiclePage` |
| GET | `/api/fleet/organizations/:id/expiring-documents?days=` | staff | staff/Onboarding.tsx `ExpiringPapers` |

In practice only owner-mode checklists upload, and those are on partner pages; staff checklists are in review mode.

## payment-service (`/api/payments`)

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/payments/overview` | staff | money/Overview.tsx (platform-wide view, every 30 s), money/Providers.tsx |
| GET | `/api/payments/ledger/integrity` | staff | money/Overview.tsx (every 5 min) |
| GET | `/api/payments/balances?limit=&offset=&state=&type=&cityId=&q=` | staff | money/Balances.tsx `BalancesPage`; money/Overview.tsx city view (every 30 s); admin/Users.tsx `UserPage` (a driver's balance, `q=<id>&type=INDIVIDUAL`) |
| GET | `/api/payments/balances/:accountId` | staff | `BalancePage` (every 15 s) |
| GET | `/api/payments/balances/org/:orgId?cityId=&open=` | partner | partner/Partner.tsx `FleetBalance` (every 15 s) |
| GET | `/api/payments/balances/:accountId/statement?limit=30&before=` | staff or partner | money/BalancePanel.tsx |
| GET | `/api/payments/balances/:accountId/top-ups` | staff or partner | `BalancePanel` |
| POST | `/api/payments/balances/:accountId/top-ups` | partner, Idem | `BalancePanel` `TopUpDrawer` (owner) |
| PUT | `/api/payments/balances/:accountId/payout-method` | partner | `BalancePanel` `PayoutMethodDrawer` (owner) |
| GET | `/api/payments/methods` | staff or partner | `TopUpDrawer` (partner); `useProviders()` (staff: Rider payments provider filter) |
| GET | `/api/payments/methods?cityId=` | staff | `lib/trips.ts` `usePaymentMethods` (PhoneBooking) |
| POST | `/api/payments/top-ups/manual` | staff, Idem | `RecordCashDrawer` (Balances list and one balance) |
| GET | `/api/payments/top-ups?status=&channel=` | staff | money/Approvals.tsx (pending; History → Top-ups) |
| GET | `/api/payments/top-ups/:id` | staff | money/Approvals.tsx History top-up drawer |
| POST | `/api/payments/top-ups/:id/approve` · `/reject` | staff | money/Approvals.tsx |
| GET | `/api/payments/refunds?status=` | staff | money/Approvals.tsx (pending; History → Refunds), money/Overview.tsx city view |
| POST | `/api/payments/refunds/:id/approve` · `/reject` | staff | money/Approvals.tsx |
| GET | `/api/payments/payments?status=&provider=&tripId=&cityId=&limit=&before=` | staff | money/Payments.tsx (every 15 s), money/Overview.tsx city view |
| GET | `/api/payments/payments/:id` | staff | `PaymentDrawer` (every 5 s) |
| POST | `/api/payments/payments/:id/reconcile` | staff | `PaymentDrawer` |
| POST | `/api/payments/payments/:id/refunds` | staff, Idem | `PaymentDrawer` refund form |
| GET | `/api/payments/trips/:tripId` | staff | staff/TripDetail.tsx `TripPayments` (every 10 s) |
| GET | `/api/payments/payouts` | staff | money/Payouts.tsx (every 15 s), money/Approvals.tsx |
| GET | `/api/payments/payouts/:id` | staff | money/Payouts.tsx `BatchDetail` (3 s while sending, else 20 s), also in Approvals History |
| POST | `/api/payments/payouts/:id/approve` · `/reject` | staff | money/Approvals.tsx |
| POST | `/api/payments/settlements/run` | staff | money/Payouts.tsx |
| GET | `/api/payments/rules?cityId=` | staff | money/Rules.tsx, money/Approvals.tsx History → Rule changes |
| GET | `/api/payments/rules/pending` | staff | money/Approvals.tsx |
| POST | `/api/payments/rules/changes` | staff | money/Rules.tsx |
| POST | `/api/payments/rules/changes/:id/approve` · `/reject` · `/cancel` | staff | money/Approvals.tsx |
| GET | `/api/payments/gateways` | staff | money/Providers.tsx (every 15 s) |
| GET | `/api/payments/reports/daily?cityId=&from=&to=` | staff | reports/Reports.tsx (Finance tab) |
| GET | `/api/payments/reports/daily.csv?cityId=&from=&to=` | staff | Reports "Download CSV" |
| GET | `/api/payments/earnings/org/:orgId?period=&from=&to=` | partner | partner/FleetEarnings.tsx |
| GET | `/api/payments/org/:orgId/payments?limit=&before=` | partner | partner/CompanyTrips.tsx `CompanyChargesPage` |

Money controls (maker–checker; pending items also on Money approvals via `GET /api/payments/approvals/pending`):

| Method | Path | Token | Used by |
|---|---|---|---|
| GET · POST | `/api/payments/adjustments` | staff | money/Adjustments.tsx |
| POST | `/api/payments/adjustments/:id` | staff | approve / reject / cancel |
| GET | `/api/payments/write-offs/candidates` | staff | money/WriteOffs.tsx |
| GET · POST | `/api/payments/write-offs`, `POST /:id` | staff | money/WriteOffs.tsx |
| GET · POST | `/api/payments/policy-overrides`, `POST /:id` | staff | money/Adjustments.tsx (limit exceptions page) |
| GET · POST | `/api/payments/incentives`, `GET · POST /:id` | staff | money/Incentives.tsx |
| GET | `/api/payments/invoices/uninvoiced?period=` | staff | money/Invoices.tsx |
| GET · POST | `/api/payments/invoices`, `GET /:id`, `GET /:id/csv`, `POST /:id/payments` | staff | money/Invoices.tsx |
| GET | `/api/payments/earnings/org/:orgId?period=` | partner | partner/FleetEarnings.tsx |
| GET | `/api/payments/org/:orgId/payments?limit=&before=` | partner | partner/CompanyTrips.tsx `CompanyChargesPage` |
| GET | `/api/payments/org/:orgId/invoices`, `/:id`, `/:id/csv` | partner | partner/Invoices.tsx |

## notification-service (`/api/notifications`)

Proxied by Vite to `NOTIFICATION_URL` (default `http://localhost:3006`).

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/notifications/campaigns/audience?cityId=&audience=&channel=&lastActiveDays=` | staff | marketing/Campaigns.tsx (audience size) |
| GET · POST | `/api/notifications/campaigns` (`?limit=100&cityId=`) | staff | marketing/Campaigns.tsx |
| GET · PUT | `/api/notifications/campaigns/:id` | staff | marketing/Campaigns.tsx |
| POST | `/api/notifications/campaigns/:id/schedule` · `/cancel` | staff | marketing/Campaigns.tsx |

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

## support-service (`/api/support`)

All through `supportApi` in [src/lib/support.ts](../src/lib/support.ts), staff token. support-service listens on port 3009 (Kong route `support-routes`); see [services/support-service/docs/api.md](../../../services/support-service/docs/api.md).

| Method | Path | Token | Used by |
|---|---|---|---|
| GET | `/api/support/tickets?cityId=&status=&category=&priority=&assignee=&overdue=&q=&tripId=&requesterUserId=&cursor=&limit=` | staff | support/Tickets.tsx list (every 30 s) |
| POST | `/api/support/tickets` | staff, Idem | Tickets "Log a ticket for a caller" |
| GET | `/api/support/tickets/:id` | staff | `TicketPage` (every 15 s) |
| PATCH | `/api/support/tickets/:id` | staff | `TicketPage` (priority, category) |
| POST | `/api/support/tickets/:id/claim` · `/assign` · `/status` · `/resolve` · `/reopen` | staff | `TicketPage` actions |
| POST | `/api/support/tickets/:id/messages` | staff | `TicketPage` reply or internal note |
| POST | `/api/support/tickets/:id/refunds` | staff | `TicketPage` link a refund |
| GET | `/api/support/lost-items?cityId=&status=&cursor=&limit=` | staff | support/LostItems.tsx (every 30 s) |
| GET | `/api/support/lost-items/:id` | staff | lost item drawer (every 15 s) |
| POST | `/api/support/lost-items/:id/status` · `/messages` | staff | lost item drawer |
| GET | `/api/support/sos?cityId=&status=active\|resolved` | staff | safety/SosQueue.tsx (every 5 s) |
| GET | `/api/support/sos/:id` | staff | SOS alert panel (every 5 s) |
| POST | `/api/support/sos/:id/acknowledge` · `/notes` · `/resolve` | staff | SOS alert panel |
| GET | `/api/support/incidents?cityId=&status=&severity=&category=&cursor=&limit=` | staff | safety/Incidents.tsx (every 30 s) |
| POST | `/api/support/incidents` | staff, Idem | Incidents "Open incident", SOS "Open an incident" |
| GET | `/api/support/incidents/:id` | staff | `IncidentPage` (every 20 s) |
| PATCH | `/api/support/incidents/:id` | staff | `IncidentPage` triage (severity, category, status, owner) |
| POST | `/api/support/incidents/:id/notes` · `/actions` · `/resolve` | staff | `IncidentPage` |

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
| Rider/driver photos | `PartiesView` (TripDetail) `<img>` | `photo` from `/api/trips/:id/parties` (data URLs) |

## Prefixes in Kong that the web app does not call

`/api/webhooks/telegram-gateway` (notification-service) and `/api/payments/webhooks` (provider callbacks) are routed by Kong but never called from `src/`.
