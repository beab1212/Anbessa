# rider-app

Flutter app for riders — book trips, track the driver live, pay.

## Quick start

```bash
# 1. Make sure Flutter is installed
flutter --version   # needs 3.24+
#    Install: https://docs.flutter.dev/get-started/install

# 2. Install dependencies
flutter pub get

# 3. Run on a connected device or simulator
flutter run
#    List available devices first: flutter devices

# 4. Run tests
flutter test
```

> **No backend needed for initial UI development.**
> The `lib/core/network/api_client.dart` base URL is read from
> `--dart-define=API_BASE_URL=...` at run time; it defaults to the local
> docker-compose stack (`http://localhost:8000`).

---

## Running against a specific backend

```bash
# Local stack (after `make dev-services` from root)
flutter run --dart-define=API_BASE_URL=http://localhost:8000

# Staging
flutter run --dart-define=API_BASE_URL=https://api.staging.ride-app.example
```

---

## Project layout

```
lib/
├── main.dart
├── core/
│   ├── network/
│   │   ├── api_client.dart      Dio wrapper — attaches JWT, retries on 401
│   │   └── socket_client.dart   Socket.io wrapper — live driver location
│   └── theme/
│       └── app_theme.dart
└── features/
    ├── auth/
    │   ├── data/                AuthRepositoryImpl (calls API)
    │   ├── domain/              AuthRepository interface + models
    │   └── presentation/        Screens & Riverpod providers
    ├── map/                     Live map screen (flutter_map + OSM tiles)
    ├── trip/                    Request ride, trip status, trip history
    └── payment/                 Payment methods, receipt
```

Each feature follows the same **data / domain / presentation** split.
`domain/` defines the abstract repository contract; `data/` implements it;
`presentation/` contains screens and Riverpod providers that call `domain/`.
This means you can develop and test the UI with a mock repository without any
backend running at all.

---

## Common commands

| Command | What it does |
|---------|-------------|
| `flutter run` | Run on connected device |
| `flutter test` | Run unit + widget tests |
| `flutter analyze` | Static analysis |
| `flutter build apk` | Build Android release APK |
| `flutter build ios` | Build iOS release (macOS only) |
| `flutter pub get` | Install / sync dependencies |
| `flutter pub upgrade` | Upgrade dependencies |

---

## Key dependencies

| Package | Purpose |
|---------|---------|
| `flutter_riverpod` | State management |
| `flutter_map` | OSM map rendering (no API key) |
| `dio` | HTTP client |
| `socket_io_client` | Live location WebSocket |
| `flutter_secure_storage` | Token storage |
| `ride_app_core` | Shared models + widgets (local package) |
