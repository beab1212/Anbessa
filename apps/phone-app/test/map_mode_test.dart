// Map modes: remembered, 3D only where the vector engine runs, and keyless default styles.

import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/core/network/providers.dart';
import 'package:phone_app/features/maps/map_mode.dart';
import 'package:phone_app/features/maps/map_styles.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<ProviderContainer> container({required bool vector, Map<String, Object> prefs = const {}}) async {
  SharedPreferences.setMockInitialValues(prefs);
  final p = await SharedPreferences.getInstance();
  final c = ProviderContainer(overrides: [prefsProvider.overrideWithValue(p), vectorMapsProvider.overrideWithValue(vector)]);
  addTearDown(c.dispose);
  return c;
}

void main() {
  test('the chosen mode is remembered', () async {
    final c = await container(vector: true);
    expect(c.read(mapModeProvider), MapMode.flat);
    await c.read(mapModeProvider.notifier).set(MapMode.satellite);
    final again = await container(vector: true, prefs: {'map_mode': 'satellite'});
    expect(again.read(mapModeProvider), MapMode.satellite);
  });

  test('3D needs the vector engine; elsewhere the map stays flat', () async {
    final phone = await container(vector: true, prefs: {'map_mode': 'threeD'});
    expect(phone.read(effectiveMapModeProvider), MapMode.threeD);
    final desktop = await container(vector: false, prefs: {'map_mode': 'threeD'});
    expect(desktop.read(effectiveMapModeProvider), MapMode.flat);
    final sat = await container(vector: false, prefs: {'map_mode': 'satellite'});
    expect(sat.read(effectiveMapModeProvider), MapMode.satellite);
  });

  test('default styles need no API key; 3D tilts; satellite is an inline raster style', () {
    expect(vectorStyleFor(MapMode.flat, dark: false), 'https://tiles.openfreemap.org/styles/positron');
    expect(vectorStyleFor(MapMode.flat, dark: true), 'https://tiles.openfreemap.org/styles/dark');
    expect(vectorStyleFor(MapMode.threeD, dark: false), vectorStyleFor(MapMode.flat, dark: false));
    expect(pitchFor(MapMode.threeD), greaterThan(0));
    expect(pitchFor(MapMode.flat), 0);
    final sat = jsonDecode(vectorStyleFor(MapMode.satellite, dark: false)) as Map<String, dynamic>;
    expect(sat['version'], 8);
    final tiles = ((sat['sources'] as Map)['imagery'] as Map)['tiles'] as List;
    expect(tiles.single, contains('World_Imagery'));
    for (final s in [vectorStyleFor(MapMode.flat, dark: false), vectorStyleFor(MapMode.flat, dark: true), tiles.single as String]) {
      expect(s, isNot(contains('key=')));
      expect(s, isNot(contains('cartocdn')));
    }
  });
}
