// platform-service's client configuration (cities, vehicle types, feature flags, maintenance,
// minimum versions, announcements): fetched at boot, every minute, and when the app resumes. The
// last good copy is kept in preferences so the app starts with real cities offline.

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/network/providers.dart';
import '../../core/session/session_controller.dart';

const _cacheKey = 'client_config';

class ClientConfigController extends AsyncNotifier<ClientConfig> {
  @override
  Future<ClientConfig> build() async {
    final prefs = ref.watch(prefsProvider);
    final mode = ref.watch(effectiveModeProvider);
    final cached = prefs.getString(_cacheKey);
    ClientConfig? last;
    if (cached != null) {
      try {
        last = ClientConfig.fromJson(jsonDecode(cached) as Map<String, dynamic>);
      } catch (_) {}
    }
    final timer = Stream<void>.periodic(const Duration(seconds: 60)).listen((_) => refresh());
    ref.onDispose(timer.cancel);
    try {
      return await _fetch(mode?.name ?? 'rider');
    } catch (_) {
      return last ?? ClientConfig.fallback;
    }
  }

  Future<ClientConfig> _fetch(String audience) async {
    final raw = asJson(await ref.read(apiClientProvider).getJson('/api/platform/client-config', query: {'audience': audience}, auth: false));
    final cfg = ClientConfig.fromJson(raw);
    // the raw copy serves the next cold start when the network doesn't
    await ref.read(prefsProvider).setString(_cacheKey, jsonEncode(raw));
    return cfg;
  }

  Future<void> refresh() async {
    final mode = ref.read(effectiveModeProvider);
    try {
      final next = await _fetch(mode?.name ?? 'rider');
      final current = state.value;
      // announcements start and end on their own schedule without a settings version bump, so
      // compare them too (a new one used to wait for the next app start)
      if (current == null || next.version != current.version || !_sameAnnouncements(next, current)) state = AsyncData(next);
    } catch (_) {
      // keep what we have
    }
  }
}

bool _sameAnnouncements(ClientConfig a, ClientConfig b) =>
    listEquals(a.announcements.map((x) => '${x.id}|${x.title}|${x.body}').toList(), b.announcements.map((x) => '${x.id}|${x.title}|${x.body}').toList());

final clientConfigProvider = AsyncNotifierProvider<ClientConfigController, ClientConfig>(ClientConfigController.new);

/// Always a config: the live one, the cached one, or the built-in fallback.
final configProvider = Provider<ClientConfig>((ref) => ref.watch(clientConfigProvider).value ?? ClientConfig.fallback);

final featureProvider = Provider.family<bool, Feature>((ref, f) => ref.watch(configProvider).features[f]);

/// The city the app works in: the first served city (a later version picks by location).
final currentCityProvider = Provider<City>((ref) {
  final cfg = ref.watch(configProvider);
  return cfg.cities.isEmpty ? City.builtIn.first : cfg.cities.first;
});

@immutable
class AppVersion {
  const AppVersion({required this.version, required this.build, required this.platform});
  final String version;
  final String build;
  /// android | ios | web | linux | …
  final String platform;
}

final appVersionProvider = FutureProvider<AppVersion>((ref) async {
  final info = await PackageInfo.fromPlatform();
  final platform = kIsWeb ? 'web' : defaultTargetPlatform.name.toLowerCase();
  return AppVersion(version: info.version, build: info.buildNumber, platform: platform);
});

/// The store's minimum version for this mode and platform says this build is too old.
final updateRequiredProvider = Provider<bool>((ref) {
  final v = ref.watch(appVersionProvider).value;
  if (v == null || (v.platform != 'android' && v.platform != 'ios')) return false;
  final mode = ref.watch(effectiveModeProvider) ?? AppMode.rider;
  final min = ref.watch(configProvider).minAppVersions[mode.name]?[v.platform];
  return isBelowMinimum(v.version, min);
});
