# driver-app

Flutter app for drivers — go online, accept trip requests, navigate, track earnings.

## Quick start

```bash
# 1. Make sure Flutter is installed (3.24+)
flutter --version
#    Install: https://docs.flutter.dev/get-started/install

# 2. Install dependencies
flutter pub get

# 3. Run on a connected device or simulator
flutter run

# 4. Run tests
flutter test
```

> **GPS note:** The app sends live location pings via `lib/core/network/location_pinger.dart`.
> On a simulator, use the device's simulated location feature.
> On a real Android device, grant location permission when prompted.

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

---

## Project layout

```
lib/
├── main.dart
├── core/
│   ├── network/
│   │   ├── api_client.dart       Dio wrapper
│   │   └── location_pinger.dart  Emits GPS pings to realtime-gateway
│   └── theme/app_theme.dart
└── features/
    ├── auth/       Login, registration
    ├── map/        Navigation map during a trip
    ├── trip/       Accept/reject requests, trip lifecycle
    └── earnings/   Daily/weekly earnings summary
```

---

## Common commands

| Command | What it does |
|---------|-------------|
| `flutter run` | Run on device |
| `flutter test` | Run tests |
| `flutter analyze` | Static analysis |
| `flutter build apk` | Android release |
| `flutter pub get` | Sync dependencies |
