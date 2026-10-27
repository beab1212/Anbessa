// Build-time configuration (`--dart-define` / `--dart-define-from-file=env/<name>.json`).
// Defaults point at the local stack. See env/README in apps/phone-app/README.md.

import 'package:flutter/foundation.dart';
import 'package:ride_app_core/ride_app_core.dart';

abstract final class Env {
  /// Kong (or production) base URL, used in `gateway` mode.
  static const apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://localhost:8000');

  /// `gateway`: everything to API_BASE_URL. `host`: each /api prefix to its service's own port on
  /// HOST_BASE, which is how `make dev-services` runs (there's no Kong on the host).
  static const apiMode = String.fromEnvironment('API_MODE', defaultValue: 'gateway');
  static const hostBase = String.fromEnvironment('HOST_BASE', defaultValue: 'http://localhost');

  /// realtime-gateway (Socket.io), never behind Kong.
  static const wsUrl = String.fromEnvironment('WS_URL', defaultValue: 'ws://localhost:3000');

  /// Raster tile template. Empty: OpenStreetMap's tiles (development only; respect their policy).
  static const tileUrl = String.fromEnvironment('TILE_URL', defaultValue: '');
  static const tileAttribution = String.fromEnvironment('TILE_ATTRIBUTION', defaultValue: '© OpenStreetMap contributors');

  /// Raster tiles for dark mode. Empty: the light tiles drawn through a dark filter.
  static const tileUrlDark = String.fromEnvironment('TILE_URL_DARK', defaultValue: '');
  static const tileAttributionDark = String.fromEnvironment('TILE_ATTRIBUTION_DARK', defaultValue: ''); // empty: same as TILE_ATTRIBUTION

  /// Vector map styles (MapLibre, Android and iOS). Empty: OpenFreeMap's free styles (no key).
  static const mapStyleUrl = String.fromEnvironment('MAP_STYLE_URL', defaultValue: '');
  static const mapStyleUrlDark = String.fromEnvironment('MAP_STYLE_URL_DARK', defaultValue: '');

  /// Satellite imagery tiles ({z}/{y}/{x} or {z}/{x}/{y}). Empty: Esri World Imagery.
  static const satelliteTileUrl = String.fromEnvironment('SATELLITE_TILE_URL', defaultValue: '');
  static const satelliteAttribution = String.fromEnvironment('SATELLITE_ATTRIBUTION', defaultValue: '');

  /// `on`: the sign-in page lists the seed accounts (auth-service DEV_LOGIN=on; debug builds only).
  static const devLogin = String.fromEnvironment('DEV_LOGIN', defaultValue: 'off');

  /// `on`: positions come from a fake source you steer from a debug panel (Linux has no GPS).
  static const fakeLocation = String.fromEnvironment('FAKE_LOCATION', defaultValue: 'off');

  /// Public host for https app links.
  static const appLinkHost = String.fromEnvironment('APP_LINK_HOST', defaultValue: 'app.anbessa.et');

  /// Firebase (push). All four set → push is initialised; otherwise the app runs without push.
  static const firebaseApiKey = String.fromEnvironment('FIREBASE_API_KEY', defaultValue: '');
  static const firebaseAppId = String.fromEnvironment('FIREBASE_APP_ID', defaultValue: '');
  static const firebaseProjectId = String.fromEnvironment('FIREBASE_PROJECT_ID', defaultValue: '');
  static const firebaseSenderId = String.fromEnvironment('FIREBASE_SENDER_ID', defaultValue: '');

  static bool get isHostMode => apiMode == 'host';
  static bool get devLoginOn => kDebugMode && devLogin == 'on';
  static bool get fakeLocationOn => fakeLocation == 'on' || (!kIsWeb && defaultTargetPlatform == TargetPlatform.linux);
  static bool get firebaseConfigured => firebaseApiKey.isNotEmpty && firebaseAppId.isNotEmpty && firebaseProjectId.isNotEmpty && firebaseSenderId.isNotEmpty;

  static ApiEndpoints get endpoints => isHostMode ? ApiEndpoints.host(hostBase: hostBase) : ApiEndpoints.gateway(apiBaseUrl);

  /// Where the dev sign-in routes live (never behind Kong): host mode's auth port, else the base URL.
  static String get devApiBase => isHostMode ? '$hostBase:3001' : apiBaseUrl;
}
