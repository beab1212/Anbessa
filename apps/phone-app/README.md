# phone-app — the Anbessa phone app (rider + driver)

One Flutter app for **both** sides of a trip:

- **Rider mode**: book trips, track the driver live, pay.
- **Driver mode**: go online, accept trip requests, navigate, send live GPS, track earnings.

The signed-in user's roles decide the mode. auth-service puts a `roles` claim
(`[{ "r": "RIDER" }, { "r": "DRIVER" }]`) in the JWT; after login it is stored in
`sessionRoleProvider` (`lib/core/session/session.dart`), and `RideApp` in
`lib/main.dart` shows the matching home screen and theme (indigo for rider,
teal for driver). Until login is wired to the API, the login screen has
**Continue as rider** / **Continue as driver** buttons so you can work on either side.

## Quick start

```bash
# 1. Make sure Flutter is installed
flutter --version   # needs 3.44+ (Dart 3.12+)
#    Install: https://docs.flutter.dev/get-started/install

# 2. Install dependencies — from the repo root (Dart pub workspace)
dart pub get        # or: make setup-mobile

# 3. Run on a connected device or emulator
flutter run         # or, from the root: make dev-mobile
#    List available devices first: flutter devices

# 4. Run tests
flutter test
```

Platforms: **Android** and **iOS** (`android/`, `ios/`). iOS builds need macOS.
Before the first Android build, accept the SDK licenses once with `flutter doctor --android-licenses`.

> **No backend needed for initial UI development.**
> The API and WebSocket URLs are compile-time constants in
> `lib/core/config/env.dart`, set with `--dart-define`. They default to the
> local docker-compose stack (`http://localhost:8000`, `ws://localhost:3000`).

> **GPS note (driver mode):** live location pings go through
> `lib/core/network/location_pinger.dart`. Location permissions are declared in
> `android/app/src/main/AndroidManifest.xml` and `ios/Runner/Info.plist`.
> On an emulator, use its simulated-location feature.

---

## Running against a specific backend

```bash
# Local stack (after `make dev-services` from root)
flutter run \
  --dart-define=API_BASE_URL=http://localhost:8000 \
  --dart-define=WS_URL=ws://localhost:3000

# Staging
flutter run \
  --dart-define=API_BASE_URL=https://api.staging.ride-app.example \
  --dart-define=WS_URL=wss://ws.staging.ride-app.example
```

On the Android emulator, `localhost` is the emulator itself. Use `10.0.2.2` to reach your machine.

---

## Project layout

```
lib/
├── main.dart                    RideApp: picks rider/driver home + theme from the session role
├── core/                        shared by both modes
│   ├── config/env.dart          API_BASE_URL / WS_URL (--dart-define)
│   ├── network/
│   │   ├── api_client.dart      Dio wrapper, attaches the JWT
│   │   ├── socket_client.dart   Socket.io: subscribe to live trip updates
│   │   └── location_pinger.dart Socket.io: driver GPS pings → realtime-gateway
│   ├── session/session.dart     AppRole + sessionRoleProvider (Riverpod Notifier)
│   └── theme/app_theme.dart     riderTheme / driverTheme
└── features/
    ├── auth/                    shared login (data / domain / presentation)
    ├── rider/
    │   ├── presentation/        RiderHomeScreen
    │   ├── map/                 Live map (flutter_map + OSM tiles)
    │   ├── trip/                Request ride, trip status, trip history
    │   └── payment/             Payment methods, receipt
    └── driver/
        ├── presentation/        DriverHomeScreen
        ├── map/                 Navigation map during a trip
        ├── trip/                Accept/reject requests, trip lifecycle
        └── earnings/            Daily/weekly earnings summary
```

Each feature follows the same **data / domain / presentation** split, with
`features/auth` as the worked example. `domain/` defines the abstract repository
contract, `data/` implements it, and `presentation/` holds screens and Riverpod
providers that call `domain/`. You can build and test the UI with a mock
repository and no backend running.

Code that both modes need (networking, session, theme, shared widgets from
`packages/core`) lives in `core/`. Mode-specific code stays under
`features/rider` or `features/driver`.

---

## Common commands

| Command | What it does |
|---------|-------------|
| `flutter run` | Run on connected device |
| `flutter test` | Run unit + widget tests |
| `flutter analyze` | Static analysis (flutter_lints 6) |
| `flutter build apk` | Build Android release APK |
| `flutter build ios` | Build iOS release (macOS only) |
| `dart pub get` (repo root) | Install / sync the whole workspace |
| `dart pub upgrade` (repo root) | Upgrade dependencies |
| `dart run melos run analyze` / `test` (repo root) | Analyze / test every Flutter package |

---

## Key dependencies

| Package | Purpose |
|---------|---------|
| `flutter_riverpod` 3 | State management (session role, feature providers) |
| `flutter_map` 8 + `latlong2` | OSM map rendering (no API key) |
| `dio` 5 | HTTP client |
| `socket_io_client` 3 | Live trip/location WebSocket |
| `flutter_secure_storage` 11 | Token storage |
| `geolocator` 14 | Driver-mode GPS |
| `ride_app_core` | Shared models + widgets (`packages/core`) |
