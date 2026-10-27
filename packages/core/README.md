# ride_app_core

The shared Dart package of the Anbessa phone app (`apps/phone-app`): API models mirrored from the services, the typed `ApiClient` and per-service API classes, realtime event parsing, money / time / phone / geometry helpers, and the design system (theme and widgets).
It has no Riverpod and no platform plugins; the app passes in hooks for tokens, haptics and images.
Everything is exported from `lib/ride_app_core.dart`; tests and real-response fixtures are in `test/`.
Run the tests with `flutter test` here, or `dart run melos run test` from the repo root.
Full documentation: [docs/README.md](docs/README.md).
