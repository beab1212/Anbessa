# Testing

Run from the repo root with `dart run melos run test` (`melos exec --dir-exists=test -- flutter test`, root `pubspec.yaml`), or `flutter test` inside `apps/phone-app`. Run `dart run melos run gen` first if you only analyse; `flutter test` regenerates the localisations itself.

There is no `integration_test/` and no committed end-to-end suite against running services. `apps/phone-app/README.md` describes checking the contracts with a throwaway Dart script over `ride_app_core` and `socket_io_client`.

Core package tests (`packages/core/test/`) are listed in [packages/core/docs/README.md](../../../packages/core/docs/README.md#tests).

## Test files (`apps/phone-app/test/`)

| File | Kind | What it covers |
|---|---|---|
| `app_smoke_test.dart` | widget, the real `AnbessaApp` | signed out the app opens on Welcome; Amharic renders the same screen; the first launch shows the intro and Skip leads to Welcome; dark mode renders Welcome; Continue leads to the phone-number screen |
| `router_redirect_test.dart` | unit, `redirectFor` | intro before Welcome once (and a signed-in person on `/intro` goes to splash); offline at start with a stored session (session in error, no value) stays on the splash, never Welcome; signed out → Welcome while sign-in paths stay; a forced update wins; a rider-only account lands on rider home and is kept out of driver paths; both roles and no choice → `/mode`; driver mode with a `PENDING_REVIEW` profile → onboarding, `ACTIVE` stays, the driver account stays reachable for `APPLIED`; an active trip takes over home but not the trip, its pay page, SOS or account screens |
| `token_manager_test.dart` | unit | caches the JWT until 60 s before expiry; concurrent callers share one refresh; no session token → no request; a refused session clears the cache and ends the session; a network failure is not a sign-out; `refreshClaims` returns the new roles |
| `offer_controller_test.dart` | unit, fake hub | an offer shows with its fare and countdown (and one `offer` haptic); `trip:offer_expired` for this offer clears it with a notice; events for another offer are ignored; the rider cancelling clears it; a newer offer replaces the current one |
| `marker_animator_test.dart` | unit | the first sample shows at once; glides over the sample gap with the heading the short way; dead reckoning at the last speed when the next sample is late, then freezes; a big jump snaps |
| `navigation_controller_test.dart` | unit, fake route fetcher | next turn and distance to it as the car moves along an L-shaped route; a new route after 8 s off the road, at most every 20 s |
| `rider_trip_screen_test.dart` | widget | finding (radar, elapsed time, cancel, no share button); driver assigned (name, rating, plate, PIN, ETA); arrived and riding in dark mode; completed (total and pay button) |
| `driver_screens_test.dart` | widget | offline home (car, today's numbers, slide to go online); online home in dark mode; trip on the way to the pickup (turn banner, arrival slide); waiting at the pickup, then the PIN sheet (with `tripPin` forced on in the config fixture). Exports `pumpDriver` for other tests |
| `earnings_onboarding_test.dart` | widget + unit | earnings: net hero, breakdown, balance (reference code), no chart for one day and a chart for a week; the chart painter scales bars and hangs negatives below the axis; the onboarding hub for an approved driver ("Go online") and for an applicant with missing documents ("Upload"); `OnboardingProgress` steps |
| `flagged_screens_test.dart` | widget | scheduled rides, support, promos, new ticket, SOS and delete account render in light and dark without exceptions; all but SOS and delete account show "Coming soon" |

## Shared fakes (`test/support/fakes.dart`)

| Name | What it is |
|---|---|
| `FakeSocketLink` | a `SocketLink` that never dials: records handlers and emitted events, acks every emit with `{ok: true}` |
| `fakeHub([link])` | a `RealtimeHub` over a `FakeSocketLink` whose token is always `'jwt'`; tests push events with `hub.inject(...)` |
| `jwt({sub, roles, exp})` | an unsigned JWT with chosen claims (`aud: ride-app`, `pv: 1`, `amr: [otp]`) |
| `session({roles})` | a `Session` for user `u1` ("Abebe", `+251900000501`), roles default `RIDER`, 15 minutes left |
| `fixture(name)` | reads `../../packages/core/test/fixtures/<name>` (the core fixtures are shared) |
| `FixedSession`, `FixedMode`, `FixedActiveTrip`, `FixedDriverHome` | the app's controllers with a fixed `build()` value |

Other doubles defined inside test files: `FixedConfig` (client config from `client_config.json`, in `app_smoke_test.dart` and the screen tests), `FixedShift`, `FixedBalance`, `FixedEarnings` (`driver_screens_test.dart`), `FixedIntroSeen` (`router_redirect_test.dart`), `FakeAuthApi` (`token_manager_test.dart`).

Overrides the screen tests apply (see `boot` in `app_smoke_test.dart` and `pumpDriver` in `driver_screens_test.dart`): `prefsProvider` (mock SharedPreferences), `secureStoreProvider` → `MemorySecureStore`, `localNotificationsProvider` → `NoLocalNotifications`, `realtimeHubProvider` → `fakeHub()`, `clientConfigProvider` → `FixedConfig`, `updateRequiredProvider` → false, `locationSourceProvider` → `FakeLocationSource` at Meskel Square, `routeFetcherProvider` → a canned `RouteSteps`, plus the fixed controllers and `tripPartiesProvider` / `driverLiveProvider` values. No test reaches the network.

## Conventions

- **Small phone, large text.** Screen tests set `tester.view.physicalSize = Size(360 * 3, 740 * 3)`, `devicePixelRatio = 3` (a 360 × 740 dp screen) and `platformDispatcher.textScaleFactorTestValue = 1.3`, and reset both in `addTearDown`.
- **Light and dark.** Screen tests run the same screen with `anbessaTheme(brightness: …)` in both brightnesses (or `theme_mode` in prefs for the full app) and assert `tester.takeException()` is null, which catches layout overflows.
- **Languages.** The smoke test also boots with `locale: am`.
- **No `pumpAndSettle` on screens with repeating animations.** The trip and driver screens contain `RadarPulse`, `Pulse`, `PulsingDot` and shimmers that never settle, so `pumpDriver` and the rider trip helper pump fixed frames instead: `pump()`, `pump(600 ms)`, `pump()`, `pump(1 s)` (the comment notes that the parties and ETA futures land a frame later). `pumpAndSettle` is used only in `app_smoke_test.dart`, on the welcome, intro and phone screens.
- **Override, don't sign in.** Start in a mode by overriding `sessionProvider` and `modeProvider` with the fixed controllers instead of tapping through OTP.
- **Haptics.** Unit tests set `Haptics.sink` to a list to assert which haptics fired.
- **Fixtures.** Models are built from the core fixtures (`trip.json`, `driver_home.json`, `balance.json`, `client_config.json`), edited per test where needed.
