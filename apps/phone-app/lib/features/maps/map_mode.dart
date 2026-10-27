// How the map looks: flat (2D), tilted with buildings (3D), or satellite imagery. Remembered on the
// device. 3D needs the vector engine (MapLibre, Android and iOS); elsewhere the map stays flat.

import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/network/providers.dart';
import '../../core/prefs_keys.dart';

enum MapMode { flat, threeD, satellite }

class MapModeController extends Notifier<MapMode> {
  @override
  MapMode build() {
    final saved = ref.watch(prefsProvider).getString(PrefsKeys.mapMode);
    return MapMode.values.where((m) => m.name == saved).firstOrNull ?? MapMode.flat;
  }

  Future<void> set(MapMode mode) async {
    state = mode;
    await ref.read(prefsProvider).setString(PrefsKeys.mapMode, mode.name);
  }
}

final mapModeProvider = NotifierProvider<MapModeController, MapMode>(MapModeController.new);

/// MapLibre (vector tiles, 3D) on Android and iOS; flutter_map (raster tiles) on the desktop and in
/// tests, where MapLibre has no implementation.
final vectorMapsProvider = Provider<bool>((ref) => !kIsWeb && (Platform.isAndroid || Platform.isIOS));

/// The mode the map can actually show here (3D falls back to flat without the vector engine).
final effectiveMapModeProvider = Provider<MapMode>((ref) {
  final mode = ref.watch(mapModeProvider);
  return mode == MapMode.threeD && !ref.watch(vectorMapsProvider) ? MapMode.flat : mode;
});
