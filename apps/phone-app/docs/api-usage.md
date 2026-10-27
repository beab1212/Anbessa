# API usage

Every backend endpoint and socket event the phone app uses, from reading `lib/` and the API classes in `packages/core/lib/src/api/`. The request and response shapes are in [packages/core/docs/api-client.md](../../../packages/core/docs/api-client.md) and [models.md](../../../packages/core/docs/models.md).

The service column follows the host-mode port table (`ApiEndpoints.defaultHostPorts`); in gateway mode Kong routes the same prefixes. Bearer: **JWT** (access token), **session** (Better Auth session token), **none**.

## HTTP

### auth-service (`/api/auth`, `/api/dev`)

| Method and path | Bearer | Used by |
|---|---|---|
| `POST /api/auth/phone-number/send-otp` | none | PhoneScreen, OtpScreen (resend), DevSignInPanel |
| `POST /api/auth/phone-number/verify` | none | OtpScreen, DevSignInPanel |
| `GET /api/auth/token` | session | TokenManager (every JWT mint and refresh) |
| `GET /api/auth/get-session` | session | SessionController (profile at cold start) |
| `POST /api/auth/sign-out` | session | SessionController.signOut |
| `POST /api/auth/update-user` | session | ProfileScreen (name, photo) |
| `GET /api/auth/list-sessions` | session | SessionsScreen |
| `POST /api/auth/revoke-session` | session | SessionsScreen |
| `POST /api/auth/revoke-other-sessions` | session | SessionsScreen |
| `GET /api/auth/organization/list` | session | OrganizationsController (Account, Organisations screen) |
| `GET /api/auth/organization/list-user-invitations` | session | OrganizationsController |
| `POST /api/auth/organization/accept-invitation` | session | OrganizationsScreen |
| `POST /api/auth/organization/reject-invitation` | session | OrganizationsScreen |
| `GET /api/dev/accounts` | none | DevSignInPanel (debug + `DEV_LOGIN=on`) |
| `GET /api/dev/code?phone=` | none | DevSignInPanel |

### platform-service (`/api/platform`)

| Method and path | Bearer | Used by |
|---|---|---|
| `GET /api/platform/client-config?audience=rider|driver` | none | ClientConfigController: at build, every 60 s, on resume |

### trip-service (`/api/trips`)

| Method and path | Bearer | Used by |
|---|---|---|
| `POST /api/trips` (Idempotency-Key) `{quoteId, paymentMethod, billingOrgId?, purpose?}` | JWT | QuoteScreen → BookingController.request (422 `policy_violation` with `rule` for company rides) |
| `POST /api/trips/scheduled` (Idempotency-Key) `{quoteId, paymentMethod, scheduledFor, billingOrgId?, purpose?}` | JWT | QuoteScreen → BookingController.schedule (flag `scheduledRides`) |
| `GET /api/trips/scheduled?status=upcoming&limit=50` | JWT | ScheduledRidesController (Activity, `/scheduled`; on `scheduled:status`, reconnect, pull to refresh) |
| `POST /api/trips/scheduled/:id/cancel` | JWT | ScheduledRideTile "Cancel booking" |
| `GET /api/trips/corporate/:orgId/policy` | JWT | corporatePolicyProvider (quote screen, company method: is a purpose required) |
| `GET /api/trips/active` | JWT | ActiveTripController (build, reconnect, resume, after `active_trip_exists`) |
| `GET /api/trips?as=&before=&limit=` | JWT | TripHistory (Activity), paymentDueProvider (`as=rider&limit=1`), Account trip count |
| `GET /api/trips/:id` | JWT | tripProvider (receipts, trips not active), ActiveTripController (final state of a trip that ended while away) |
| `GET /api/trips/:id/parties` | JWT | RiderTripScreen, DriverTripScreen, RatingScreen, ReceiptScreen |
| `POST /api/trips/:id/accept` (key) | JWT | OfferController.accept |
| `POST /api/trips/:id/decline` | JWT | OfferController.decline |
| `POST /api/trips/:id/en-route` | JWT | DriverTripScreen |
| `POST /api/trips/:id/arrive` | JWT | DriverTripScreen |
| `POST /api/trips/:id/start` | JWT | DriverTripScreen (with `pin` when `tripPin` is on) |
| `POST /api/trips/:id/complete` (key) | JWT | DriverTripScreen |
| `POST /api/trips/:id/cancel` (key) | JWT | RiderTripScreen, DriverTripScreen (incl. no-show) |
| `GET /api/trips/places` | JWT | SavedPlacesController (home, route editor, saved places) |
| `PUT /api/trips/places/home`, `/work` | JWT | SavedPlacesScreen |
| `POST /api/trips/places` | JWT | SavedPlacesScreen (other places) |
| `DELETE /api/trips/places/:id` | JWT | SavedPlacesScreen |
| `POST /api/trips/:id/rating` | JWT | RatingScreen |
| `GET /api/trips/me/rating` | JWT | AccountScreen (`myRatingProvider`) |
| `POST /api/trips/:id/share` | JWT | RiderTripScreen share button |
| `DELETE /api/trips/:id/share` | JWT | RiderTripScreen stop sharing |

### location-service (`/api/locations`)

| Method and path | Bearer | Used by |
|---|---|---|
| `GET /api/locations/nearby?lat=&lng=` | JWT | NearbyCarsController (rider home, every 10 s) |
| `GET /api/locations/trips/:tripId/driver` | JWT | driverLiveProvider (first fix, then every 5 s while the socket room is not joined) |

### pricing-service (`/api/pricing`)

| Method and path | Bearer | Used by |
|---|---|---|
| `POST /api/pricing/estimates` (`promoCode?`) | JWT | BookingController.quote (route editor, quote screen, swap, expired quote, promo applied / removed). The answer's `promo` outcome and each quote's `discountMinor` / `payableMinor` drive the promo row, the cards and the button |

### mapping-service (`/api/maps`)

| Method and path | Bearer | Used by |
|---|---|---|
| `GET /api/maps/search` | JWT | RouteEditorScreen (debounced 300 ms) |
| `GET /api/maps/reverse` | JWT | RouteEditorScreen (use my location, choose on map) |
| `GET /api/maps/snap` | JWT | RouteEditorScreen (pickups only) |
| `GET /api/maps/route?steps=0` | JWT | TripEtaController (rider ETA, every 30 s or on target change), offerRouteProvider (offer preview) |
| `GET /api/maps/route?steps=1` | JWT | NavigationController (driver trip, and reroutes) |

### payment-service (`/api/payments`)

| Method and path | Bearer | Used by |
|---|---|---|
| `GET /api/payments/methods?cityId=` | none | paymentMethodsProvider (quote, payment preferences, top-up) |
| `GET /api/payments/trips/:tripId` | JWT | PayScreen (and every 5 s while open), ReceiptScreen (drivers), paymentDueProvider |
| `POST /api/payments/payments/:id/pay` (key) | JWT | PayScreen "Pay now" |
| `GET /api/payments/me/preferences` | JWT | PaymentPreferencesScreen |
| `PUT /api/payments/me/preferences` | JWT | PaymentPreferencesScreen |
| `GET /api/payments/balances/me?cityId=&open=` | JWT | BalanceController (driver shell, earnings, home banner; `open=true` before a first top-up) |
| `GET /api/payments/balances/:accountId/statement` | JWT | StatementScreen |
| `GET /api/payments/balances/:accountId/top-ups` | JWT | TopUpsScreen |
| `POST /api/payments/balances/:accountId/top-ups` (key) | JWT | TopUpScreen |
| `GET /api/payments/top-ups/:id` | JWT | TopUpScreen (every 5 s until settled) |
| `PUT /api/payments/balances/:accountId/payout-method` | JWT | PayoutMethodScreen |
| `GET /api/payments/earnings/me?period=` | JWT | EarningsSummaryController (driver home `today`, earnings screen) |
| `GET /api/payments/incentives/me?cityId=` | JWT | incentivesProvider (earnings screen) |

### fleet-service (`/api/fleet`)

| Method and path | Bearer | Used by |
|---|---|---|
| `GET /api/fleet/drivers/me` | JWT | DriverHomeController: built for every signed-in person (the router listens to it), refreshed every 60 s while online and after onboarding actions |
| `POST /api/fleet/drivers/apply` | JWT | ApplyScreen |
| `POST /api/fleet/drivers/me/submit` | JWT | OnboardingHubScreen |
| `GET /api/fleet/drivers/me/vehicles` | JWT | drivableVehiclesProvider (driver home, vehicle picker) |
| `POST /api/fleet/vehicles` | JWT | VehicleFormScreen |
| `GET /api/fleet/vehicles/:id` | JWT | VehicleScreen (twice: vehicle, checklist) |
| `POST /api/fleet/vehicles/:id/submit` | JWT | VehicleScreen |
| `POST /api/fleet/documents/upload-url` | JWT | DocumentsScreen |
| `PUT <uploadUrl>` (absolute, ticket headers) | none | DocumentsScreen (local storage or S3, per the code comment) |
| `POST /api/fleet/documents` | JWT | DocumentsScreen (confirm) |
| `GET /api/fleet/documents?subjectType=&subjectId=` | JWT | DocumentsScreen |
| `GET /api/fleet/documents/:id/url` | JWT | DocumentThumb |
| `POST /api/fleet/sessions` (key) | JWT | ShiftController.goOnline |
| `DELETE /api/fleet/sessions/current` | JWT | ShiftController.goOffline |

### notification-service (`/api/notifications`)

| Method and path | Bearer | Used by |
|---|---|---|
| `POST /api/notifications/devices` | JWT | PushService (after sign-in, on token refresh; only with Firebase configured) |
| `POST /api/notifications/devices/remove` | JWT | PushService.unregister (before sign-out) |
| `GET /api/notifications/me/marketing` | JWT | MarketingPrefsController (Notifications screen) |
| `PUT /api/notifications/me/marketing` `{push?, sms?}` | JWT | Notifications screen switches |

### support-service (`/api/support`)

Through `SupportRepository` / `SafetyRepository` (`lib/features/support/support_repository.dart`) over `SupportApi`. Port 3009 in host mode; Kong routes `/api/support` in gateway mode.

| Method and path | Bearer | Used by |
|---|---|---|
| `POST /api/support/tickets` (Idempotency-Key) | JWT | NewTicketScreen |
| `GET /api/support/me/tickets?limit=50` | JWT | myTicketsProvider (SupportScreen) |
| `GET /api/support/tickets/:id` | JWT | TicketThreadController (TicketScreen; again after a reply or reopen) |
| `POST /api/support/tickets/:id/messages` | JWT | TicketScreen reply box |
| `POST /api/support/tickets/:id/reopen` | JWT | TicketScreen "Reopen" |
| `POST /api/support/lost-items` (Idempotency-Key) | JWT | ReportLostItemScreen |
| `GET /api/support/me/lost-items?limit=50` | JWT | myLostItemsProvider (SupportScreen, ReceiptScreen for riders, DriverLostItemsScreen) |
| `GET /api/support/lost-items/:id` | JWT | LostItemThreadController (LostItemScreen) |
| `POST /api/support/lost-items/:id/messages` | JWT | LostItemScreen reply box |
| `POST /api/support/lost-items/:id/status` `{status: RETURNED}` | JWT | LostItemScreen "I got it back" (rider) |
| `POST /api/support/lost-items/:id/respond` | JWT | LostItemScreen "I found it" / "It's not in the car" (driver or fleet) |
| `POST /api/support/sos` (Idempotency-Key) | JWT | SosScreen, after the 2 s hold (one key per screen, reused on retry) |
| `GET /api/support/sos/:id` | JWT | SosScreen, every 5 s until the alert is resolved |
| `POST /api/support/sos/:id/location` | JWT | SosScreen, when a newer position is > 30 m from the last one sent |

The `support:*` socket pushes (ticket messages, lost items, SOS) are not listened to; the screens poll or refresh instead.

### Wrappers with no caller in the app

`IdentityApi.me()` / `cities()`, `PlatformApi.clientConfig()` (the controller calls the path directly), `PricingApi.estimates()` / `fares()`, `TripsApi.ratingOf()` / `scheduledTrip()`, `AuthApi.updateName()`, `PaymentsApi.orgBalance()` / `balance()`, `FleetApi.retireVehicle()` / `currentSession()`. audit-service is never called.

## Socket.io (realtime-gateway, `WS_URL`)

Connected while signed in, with `auth: {token: <JWT>}`. Details in [architecture.md](architecture.md#realtime-hub) and [packages/core/docs/realtime.md](../../../packages/core/docs/realtime.md).

### Received

| Event | Produced by (per `realtime_event.dart`) | Used by |
|---|---|---|
| `trip:status` | trip-service | ActiveTripController (both modes), BalanceController |
| `trip:offer` | trip-service | OfferController |
| `trip:offer_expired` | trip-service | OfferController |
| `trip:offer_cancelled` | trip-service | OfferController |
| `trip:reassigned` | trip-service (to the driver a dispatcher took the trip from) | ActiveTripController: drops the trip, sets `tripReassignedProvider`; DriverTripScreen leaves with a notice. The rider gets a `trip:status` with the new driver instead, which refetches the parties |
| `scheduled:status` | trip-service (booked, edited, cancelled, failed, dispatched) | ScheduledRidesController: refreshes; DISPATCHED with `tripId` also refreshes the active trip |
| `driver:location` | realtime-gateway | driverLiveProvider (rider trip) |
| `payment:action_required` | payment-service | TripPaymentsController (pay screen) |
| `payment:captured` | payment-service | TripPaymentsController |
| `payment:failed` | payment-service | TripPaymentsController |
| `balance:topped_up` | payment-service | BalanceController |

### Sent

| Event | Payload | Used by |
|---|---|---|
| `trip:subscribe` | trip id | driverLiveProvider; re-sent after reconnects |
| `trip:unsubscribe` | trip id | driverLiveProvider on dispose |
| `location:update` | `{lat, lng, heading?, speed?, accuracy?, at}` | ShiftController while online |

## Outside the backend

| Target | Used by |
|---|---|
| Tile servers: `TILE_URL` / `TILE_URL_DARK`, or `https://tile.openstreetmap.org/{z}/{x}/{y}.png` (also used, darkened, for dark mode) | AnbessaMap |
| FCM | PushService |
| Payment provider pages (`checkoutUrl`) | PayScreen, TopUpScreen (in-app browser view) |
| `google.navigation:`, `comgooglemaps://`, `waze://`, `geo:`, `maps://`, Google Maps web | DriverTripScreen directions |
| `tel:991`, `tel:<emergency contact>` | SosScreen |
| Play Store / App Store pages | UpdateRequiredScreen |
