/// Build-time config, set with `flutter run --dart-define=KEY=value`.
/// Defaults point at the local docker-compose stack.
const apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://localhost:8000');
const wsUrl = String.fromEnvironment('WS_URL', defaultValue: 'ws://localhost:3000');
