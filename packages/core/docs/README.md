# ride_app_core (packages/core)

The Dart package the phone app is built on. It holds the contracts with the backend and the logic that does not need Flutter plugins or Riverpod:

- **models**: hand-written mirrors of the services' JSON (trips, offers, quotes, places, client config, sessions and claims, payments, balances, fleet).
- **api**: `ApiClient` (Dio with routing, auth, idempotency, retries and error mapping) and one typed wrapper class per service.
- **realtime**: the Socket.io event names and a sealed `RealtimeEvent` type. The socket itself lives in the app (`apps/phone-app/lib/core/realtime/realtime_hub.dart`).
- **domain** and **geo**: trip stages, money, Addis Ababa time, phone numbers, version compare, distances, polyline6, projection onto a route.
- **ui**: the design system (tokens, light and dark palettes, `anbessaTheme()`) and the shared widgets.

Rules the package keeps (from `lib/ride_app_core.dart` and `pubspec.yaml`):

- No Riverpod and no platform plugins. The app passes hooks in instead (for example `AccessTokenSource` for tokens, `Haptics.sink` for vibration, `AvatarImage.networkBuilder` for image caching).
- Widgets take their words as parameters. Localisation is owned by the app.
- Unknown enum values from the backend map to an `unknown` member, so a newer backend cannot crash an older app.

Dependencies (`packages/core/pubspec.yaml`): `dio`, `intl`, `crypto`, `meta`, `flutter_animate`, `shimmer`, `pinput` (kept below 7.x), `flutter_svg`. Assets: `assets/illustrations/*.svg`.

## Structure

```
packages/core/
  lib/ride_app_core.dart          the single export file
  lib/src/api/                    api_client.dart, app_error.dart, auth_api.dart, service_apis.dart
  lib/src/models/                 json.dart + one file per area (trip, trip_offer, quote, place, …)
  lib/src/realtime/               realtime_event.dart
  lib/src/domain/                 domain.dart
  lib/src/geo/                    polyline.dart
  lib/src/ui/theme/               tokens.dart, anbessa_theme.dart, dark_palette.dart
  lib/src/ui/widgets/             one file per widget family, re-exported by widgets.dart
  assets/illustrations/           8 two-tone SVGs used by Illustration / IllustratedEmpty
  test/                           api_client, models, polyline, theme, widgets tests
  test/fixtures/                  balance.json, client_config.json, driver_home.json, trip.json
```

## Index

| Document | What it covers |
|---|---|
| [models.md](models.md) | Every model class, its fields and JSON keys, the endpoint that returns it, enum fallbacks |
| [api-client.md](api-client.md) | `ApiClient` (host vs gateway routing, auth refresh and replay, idempotency, retries, `AppError`) and every API method with its path |
| [realtime.md](realtime.md) | Every socket event name, its payload and the `RealtimeEvent` class it becomes |
| [ui.md](ui.md) | Tokens, palettes, theme, every shared widget |
| [domain-and-geo.md](domain-and-geo.md) | Domain helpers and the geometry helpers |

## Tests

`flutter test` in `packages/core` (or `dart run melos run test` from the root) runs:

| File | Covers |
|---|---|
| `test/api_client_test.dart` | Host-mode routing and the bearer header; one refresh and replay on a token 401, a second 401 ends the session; idempotent POSTs get a key and are retried on a connection error while plain POSTs are not; error code, message and validation issues on `AppError` |
| `test/models_test.dart` | `trip.json` parses and gives the right rider and driver stages; every status literal maps and an unknown one becomes `unknown`; the free-cancel window; client config (cities by point, vehicle types per city, flag defaults, fallback); balance and driver home fixtures; JWT claims decode; every registered socket event parses and unknown names are ignored; phone, money, version, Addis time and geometry helpers |
| `test/polyline_test.dart` | polyline6 round trip, a known precision-5 polyline, distances and bearings in Addis, `lerpAngleDeg`, projection onto a polyline, `pointAlong` |
| `test/theme_test.dart` | Palette `lerp`, WCAG AA 4.5:1 contrast of the text colours on every surface in both palettes, both themes build with the extension and the font |
| `test/widgets_test.dart` | `AppSheet` snaps and reports its height, `SwipeToConfirm` fires past the threshold and springs back below it, `PinBoxes` completes, `AnimatedCounter` lands on its value, `Skeleton` has no shimmer with reduced motion, the other widgets render in dark mode, `showToast` appears and leaves |

The fixtures are real service responses. When a response shape changes, the model and its fixture change in the same commit (see "Changing the contracts" in `apps/phone-app/README.md`).
