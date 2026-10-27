# Testing

Run from the repo root with `dart run melos run test` (`melos exec --dir-exists=test -- flutter test`, root `pubspec.yaml`), or `flutter test` inside `apps/phone-app`. Run `dart run melos run gen` first if you only analyse; `flutter test` regenerates the localisations itself.

There is no `integration_test/` and no committed end-to-end suite against running services. `apps/phone-app/README.md` describes checking the contracts with a throwaway Dart script over `ride_app_core` and `socket_io_client`.

Core package tests (`packages/core/test/`) are listed in [packages/core/docs/README.md](../../../packages/core/docs/README.md#tests).

## Test files (`apps/phone-app/test/`)

| File | Kind | What it covers |
|---|---|---|
| `app_smoke_test.dart` | widget, the real `AnbessaApp` | signed out the app opens on Welcome; Amharic renders the same screen; the first launch shows the intro and Skip leads to Welcome; dark mode renders Welcome; Continue leads to the phone-number screen |
| `router_redirect_test.dart` | unit, `redirectFor` | intro before Welcome once (and a signed-in person on `/intro` goes to splash); offline at start with a stored session (session in error, no value) stays on the splash, never Welcome; signed out → Welcome while sign-in paths stay; a forced update wins; a rider-only account lands on rider home and is kept out of driver paths; both roles and no choice → `/mode`; driver mode with a `PENDING_REVIEW` profile → onboarding, `ACTIVE` stays, the driver account stays reachable for `APPLIED`; an active trip takes over home but not the trip, its pay page, SOS, help (new request, ticket, lost item) or account screens |
| `token_manager_test.dart` | unit | caches the JWT until 60 s before expiry; concurrent callers share one refresh; no session token → no request; a refused session clears the cache and ends the session; a network failure is not a sign-out; `refreshClaims` returns the new roles |
| `offer_controller_test.dart` | unit, fake hub | an offer shows with its fare and countdown (and one `offer` haptic); `trip:offer_expired` for this offer clears it with a notice; events for another offer are ignored; the rider cancelling clears it; a newer offer replaces the current one |
| `marker_animator_test.dart` | unit | the first sample shows at once; glides over the sample gap with the heading the short way; dead reckoning at the last speed when the next sample is late, then freezes; a big jump snaps |
| `navigation_controller_test.dart` | unit, fake route fetcher | next turn and distance to it as the car moves along an L-shaped route; a new route after 8 s off the road, at most every 20 s |
| `rider_trip_screen_test.dart` | widget | finding (radar, elapsed time, cancel, no share button); driver assigned (name, rating, plate, PIN, ETA); arrived and riding in dark mode; completed (total and pay button); completed with a promo (the payable total and "Promo code CODE · −X", dark) |
| `driver_screens_test.dart` | widget | offline home (car, today's numbers, slide to go online); online home in dark mode; trip on the way to the pickup (turn banner, arrival slide); waiting at the pickup, then the PIN sheet (with `tripPin` forced on in the config fixture); a completed cash trip with a promo asks to collect the payable amount, not the fare. Exports `pumpDriver` (with `incentives:` for `incentivesProvider`) for other tests |
| `earnings_onboarding_test.dart` | widget + unit | earnings: net hero, breakdown, balance (reference code), no chart for one day and a chart for a week; the chart painter scales bars and hangs negatives below the axis; the onboarding hub for an approved driver ("Go online") and for an applicant with missing documents ("Upload"); `OnboardingProgress` steps |
| `flagged_screens_test.dart` | widget | delete account renders in light and dark without exceptions |
| `booking_extras_test.dart` | widget, `FakeBackend`, GoRouter | quote screen: a promo code (sheet, `WELCOME50` sent upper-cased, the struck-through fare, the payable price on the button, then `POST /api/trips` with the discounted quote and the trip route; light and dark); a refused code shows its reason and a malformed one is never sent; no promo or pickup-time rows without the flags; booking for later (pickup time row, no ETA badges, `POST /api/trips/scheduled` with `scheduledFor`, then Activity; dark); a company ride whose policy requires a purpose (button disabled until typed, `purpose` and `billingOrgId` sent), a 422 `policy_violation` shown with "Pay personally instead", which switches to cash. Exports `FlagConfig`, `pumpWithBackend`, `settle`, `tapText` |
| `scheduled_realtime_test.dart` | widget + unit, `FakeBackend`, fake hub | Activity: "Upcoming" above past trips, cancelling with the dialog (`POST …/cancel`, toast; light and dark); flag off → no request. Realtime: `scheduled:status` DISPATCHED refreshes the list and loads the trip it created; `trip:reassigned` drops only the matching active trip and sets `tripReassignedProvider`; a new driver on `trip:status` refetches the parties, the same driver doesn't. Earnings: incentives with progress, reward, vehicle limit and payout (light, dark); none → no section. Notifications: the SMS switch PUTs `{sms: false}`; a refused change flips back with the server's message |
| `support_screens_test.dart` | widget, fake repositories | Help: the list of requests and lost items (light, dark), the empty state; a new request (category, message → `open` with the current city and `as=RIDER`, then the thread), from a receipt (the trip attached, no city), from driver mode (`as=DRIVER`); an answered ticket with its answer and thread, reopened with a reason; past the 7-day window (closed); replying to a ticket waiting for the requester. Lost items: the rider reports from a completed trip (light, dark), a trip older than 7 days can't be reported, the rider confirms a found item came back, the driver's list then "I found it" with a note (light, dark), the driver's empty state, the receipt's "I left something" leading to the form. SOS: a short press sends nothing, a 2 s hold sends the trip, the position and the city, then the 5 s poll shows the acknowledgement (light, dark); a driver 10 min after drop-off, a resolved alert stops polling; offline failure, then a retry with the same idempotency key; more than 30 min after drop-off only the police call works |

## Shared fakes (`test/support/fakes.dart`)

| Name | What it is |
|---|---|
| `FakeSocketLink` | a `SocketLink` that never dials: records handlers and emitted events, acks every emit with `{ok: true}` |
| `fakeHub([link])` | a `RealtimeHub` over a `FakeSocketLink` whose token is always `'jwt'`; tests push events with `hub.inject(...)` |
| `jwt({sub, roles, exp})` | an unsigned JWT with chosen claims (`aud: ride-app`, `pv: 1`, `amr: [otp]`) |
| `session({roles})` | a `Session` for user `u1` ("Abebe", `+251900000501`), roles default `RIDER`, 15 minutes left |
| `fixture(name)` | reads `../../packages/core/test/fixtures/<name>` (the core fixtures are shared) |
| `FixedSession`, `FixedMode`, `FixedActiveTrip`, `FixedDriverHome` | the app's controllers with a fixed `build()` value |
| `FakeSupportRepository` | `SupportRepository` in memory, seeded from the core `ticket.json` / `lost_item.json` fixtures; records every write in `calls` and can throw `fail` |
| `FakeSafetyRepository` | `SafetyRepository`: records each SOS (`sent`, with its key), throws `fail` when set, answers polls from `statuses` (the last one repeats), counts `polls` |
| `FakeBackend`, `FakeReply` | an `HttpClientAdapter` under the real `ApiClient`: `on(method, path, reply)` answers a route with JSON or a `FakeReply(status, body)`, unknown routes 404; `requests` records everything, `bodies(method, path)` gives the JSON sent; `apis()` builds the `Apis` to override `apisProvider` with (host mode, fixed JWT, no retries) |

Other doubles defined inside test files: `FixedConfig` (client config from `client_config.json`, in `app_smoke_test.dart` and the screen tests), `FixedShift`, `FixedBalance`, `FixedEarnings` (`driver_screens_test.dart`), `FixedIntroSeen` (`router_redirect_test.dart`), `FakeAuthApi` (`token_manager_test.dart`).

Overrides the screen tests apply (see `boot` in `app_smoke_test.dart` and `pumpDriver` in `driver_screens_test.dart`): `prefsProvider` (mock SharedPreferences), `secureStoreProvider` → `MemorySecureStore`, `localNotificationsProvider` → `NoLocalNotifications`, `realtimeHubProvider` → `fakeHub()`, `clientConfigProvider` → `FixedConfig`, `updateRequiredProvider` → false, `locationSourceProvider` → `FakeLocationSource` at Meskel Square, `routeFetcherProvider` → a canned `RouteSteps`, plus the fixed controllers and `tripPartiesProvider` / `driverLiveProvider` values. No test reaches the network.

## Conventions

- **Small phone, large text.** Screen tests set `tester.view.physicalSize = Size(360 * 3, 740 * 3)`, `devicePixelRatio = 3` (a 360 × 740 dp screen) and `platformDispatcher.textScaleFactorTestValue = 1.3`, and reset both in `addTearDown`.
- **Light and dark.** Screen tests run the same screen with `anbessaTheme(brightness: …)` in both brightnesses (or `theme_mode` in prefs for the full app) and assert `tester.takeException()` is null, which catches layout overflows.
- **Languages.** The smoke test also boots with `locale: am`.
- **No `pumpAndSettle` on screens with repeating animations.** The trip and driver screens contain `RadarPulse`, `Pulse`, `PulsingDot` and shimmers that never settle, so `pumpDriver` and the rider trip helper pump fixed frames instead: `pump()`, `pump(600 ms)`, `pump()`, `pump(1 s)` (the comment notes that the parties and ETA futures land a frame later). `pumpAndSettle` is used only in `app_smoke_test.dart`, on the welcome, intro and phone screens.
- **Override, don't sign in.** Start in a mode by overriding `sessionProvider` and `modeProvider` with the fixed controllers instead of tapping through OTP.
- **Haptics.** Unit tests set `Haptics.sink` to a list to assert which haptics fired.
- **Below the fold.** Lists build lazily, so a widget under the fold doesn't exist until scrolled to. `support_screens_test.dart` uses `_reveal`: at most 30 drags of the page's list, then `Scrollable.ensureVisible(alignment: 0.5)` so nothing pinned at the edges (app bar, reply box) covers the target.
- **Fixtures.** Models are built from the core fixtures (`trip.json`, `driver_home.json`, `balance.json`, `client_config.json`, `estimates_promo.json`, `scheduled_trip.json`), edited per test where needed. The config fixture leaves `scheduledRides` and `promos` off; tests turn them on with `FlagConfig`.
- **Keep providers listened in container tests.** Riverpod 3 pauses providers nobody listens to, so the realtime tests `container.listen` the controllers before injecting events, and wait 150 ms for the fake HTTP round trip.
