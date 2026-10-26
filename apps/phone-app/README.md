# phone-app: the Anbessa phone app (rider + driver)

One Flutter app for both sides of a trip:

- **Rider mode**: pick a pickup and a drop-off, compare fares, request, follow the driver live, pay (cash, mobile money, card, company account), rate, see receipts.
- **Driver mode**: apply and upload documents, register a car, go online, take trip offers, drive the trip (arrival is geofenced, the PIN starts it), see the balance, top up, set the payout method.

Sign-in is phone OTP. The JWT's `roles` claim decides the modes: riders get rider mode, drivers get both and choose (switchable in Account). Android is the first target; iOS is configured but not built yet.

## Quick start

```bash
make setup-mobile                      # from the repo root: dart pub get for the workspace
make dev-services                      # the backend (ports 3000–3011)
make dev-mobile                        # flutter run --dart-define-from-file=env/dev-host.json
make dev-mobile ENV=dev-emulator       # Android emulator (backend at 10.0.2.2)
make dev-mobile ENV=dev-kong           # through Kong (`make dev-gateway`), as in production

# on this machine, without a phone: two windows, one rider and one driver
flutter run -d linux --dart-define-from-file=env/dev-host.json
```

Debug builds with `DEV_LOGIN=on` show the ready-made accounts on the welcome screen: rider `+251900000501`, approved driver `+251900000402`, applicant `+251900000401`, fleet driver `+251900000102`. Drivers need fleet data (`pnpm --filter @ride-app/fleet-service seed:dev`). On Linux, or with `FAKE_LOCATION=on`, location is simulated: the driver screens get a panel that moves the car or drives it to the pickup.

Checks, from the root: `dart run melos run analyze` and `dart run melos run test`. An installable build: `flutter build apk --debug --dart-define-from-file=env/dev-emulator.json`.

## Configuration (`env/*.json`, read by `lib/core/config/env.dart`)

| Define | Meaning |
|---|---|
| `API_MODE` | `host`: `/api/<prefix>` goes straight to the service's port (`make dev-services`, no Kong). `gateway`: everything through `API_BASE_URL` (Kong) |
| `API_BASE_URL`, `HOST_BASE` | Kong's URL, or the host for the per-service ports |
| `WS_URL` | realtime-gateway (Socket.io) |
| `TILE_URL`, `TILE_ATTRIBUTION` | raster tiles `{z}/{x}/{y}`; empty = OpenStreetMap's (development only) |
| `DEV_LOGIN` | `on`: the dev sign-in panel (debug builds only; the backend refuses it in production) |
| `FAKE_LOCATION` | `on`: simulated location (always on for Linux desktop) |
| `APP_LINK_HOST` | host of the `https://` app links (`app.anbessa.et`) |
| `FIREBASE_*` | push; without them push is off and nothing else changes |

## How it is built

```
packages/core (ride_app_core)        no Riverpod, no plugins: contracts and pure logic
  models/     Trip, TripOffer, Quote, Place, ClientConfig (+ feature flags), Claims, Payment,
              Balance, fleet (DriverHome, Vehicle, Checklist…): hand-written fromJson,
              unknown enum values map to `unknown` so a new backend status can't crash old apps
  api/        ApiClient (Dio): host-mode routing, bearer + one refresh-and-replay on 401,
              Idempotency-Key, retries for GETs and idempotent POSTs, every failure → AppError;
              one class per service (AuthApi, TripsApi, PaymentsApi, FleetApi…)
  realtime/   socket event names and the sealed RealtimeEvent
  domain/     trip stages, money (birr), Addis time, phone formats, semver, geo helpers
  ui/         the theme (the web app's tokens) and shared widgets

apps/phone-app
  lib/core/       env, session (secure store, TokenManager, SessionController, mode), network
                  providers, realtime hub, location sources, push and local notifications,
                  router (routes + guards), l10n
  lib/features/   auth, bootstrap (splash, forced update, banners), config, shell, maps,
                  rider/{home, booking, trip, payments, rating, history},
                  driver/{onboarding, shift, offers, trip, earnings}, profile, flagged
```

- **State**: Riverpod 3. The load-bearing providers: `sessionProvider`, `effectiveModeProvider`, `clientConfigProvider` / `featureProvider(flag)`, `realtimeHubProvider`, `activeTripProvider`, `tripProvider(id)`, `tripPartiesProvider(id)`, `driverLiveProvider(id)`, `shiftProvider`, `offerProvider`, `balanceProvider`, `routerProvider`.
- **Session** (`lib/core/session`): the session token from OTP sign-in lives in secure storage and is sent as a bearer to auth-service; `TokenManager` turns it into the 15-minute JWT (`GET /api/auth/token`), refreshes it 60 s before expiry or when a service answers `token_outdated` / `token_revoked`, and runs one refresh at a time. A refused session signs out with a reason.
- **Routing** (`lib/core/router/app_router.dart`): one go_router table, redirects in this order: still loading → splash; too old a version → update required; signed out → welcome; both roles and no choice → mode; driver mode without an approved profile → onboarding; an active trip takes over (SOS, support and account screens excepted). Deep links `anbessa://trip/<id>` and `https://app.anbessa.et/pay/<tripId>` resolve to the current mode.
- **Realtime** (`lib/core/realtime/realtime_hub.dart`): one Socket.io connection while signed in. A fresh JWT before every (re)connect (the gateway only checks it at the handshake), trip rooms re-joined after reconnects, three refusals sign out. Without the socket, the rider's view of the driver falls back to polling, and the active trip is refetched on reconnect and on resume.
- **Location** (`lib/core/location`): `GeolocatorSource` (on Android a foreground service keeps pings going while the driver is online) or `FakeLocationSource`. Online drivers ping every 4 s when moving and 10 s when still; the gateway's acks are counted on the home screen.
- **Maps** (`lib/features/maps`): flutter_map with raster tiles, pickup/drop-off pins, the driver's car (turned by heading, greyed when its position is older than 20 s), a dashed straight line (quotes carry no route geometry yet), and a place picker (search, common places, pick on the map, current location).
- **Money**: amounts are minor units (santim) everywhere; `birr()` formats them per locale. Mobile money and card are charged after the trip; the pay screen follows `payment:action_required` / `captured` / `failed` and opens the provider's page. The providers are simulated by payment-service until the real integrations land.
- **Languages**: English and Amharic (`lib/core/l10n/app_*.arb`, Noto Sans Ethiopic bundled under the OFL). The generated code in `lib/core/l10n/generated/` isn't committed: `flutter run/build/test` regenerate it, `melos run gen` before `flutter analyze`.
- **Push**: FCM through notification-service. Tokens are registered after sign-in and removed before sign-out; a tap routes by the payload's `type`. Trip offers that arrive while the app is in the background raise a local notification.

## Feature flags and modules built ahead of their services

Client-config (`GET /api/platform/client-config`) carries `features`. Admins switch them in the web app under Settings → Feature flags.

| Flag | What the app does with it | Backend |
|---|---|---|
| `corporateBooking` | company-account payment at the quote, for company employees | live |
| `tripPin` | the rider sees the PIN; the driver must enter it | live |
| `scheduledRides` | Scheduled rides (home, account) | not yet: screens, models and `ScheduledRidesRepository` exist |
| `sos` | SOS button on active trips (call 991, alert the safety team) | calling works; alerting needs the safety service |
| `support` | Support tickets (account) | not yet: `SupportRepository` |
| `promos` | Promo codes (home, account) | not yet: `PromosRepository` |
| `accountDeletion` | Delete account (account) | not yet: `AccountRepository` |

These modules live in `lib/features/flagged/flagged_modules.dart`. Each repository's stand-in answers `not_available`, so turning a flag on early shows "not available yet" rather than breaking. When a service lands, implement the repository against it and override its provider.

## Changing the contracts

The Dart models mirror `libs/shared-types` and the services' views by hand. A change to a response shape updates the model in `packages/core/lib/src/models/` and its fixture in `packages/core/test/fixtures/` in the same change.

## Tests

- `packages/core/test`: model fixtures, the API client against a fake HTTP adapter (auth refresh and replay, idempotency, error mapping), domain helpers.
- `apps/phone-app/test`: TokenManager, OfferController (fake socket), the router's guard order, and a smoke test that boots the app on a 360 dp screen at 1.3× text in English and Amharic.

## Platforms

- **Android**: location, foreground-service, notification and camera permissions; debug-only cleartext HTTP for the dev stack; `anbessa://` and `https://app.anbessa.et` links (the latter needs `assetlinks.json` served there); core library desugaring for local notifications.
- **iOS**: location (when in use and always), camera and photo descriptions, background modes `location` and `remote-notification`, the `anbessa` URL scheme. Not built yet (needs a Mac).
- **Linux desktop**: development only, with simulated location.
