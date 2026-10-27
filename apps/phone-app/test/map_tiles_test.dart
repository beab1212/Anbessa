// Which tiles the map asks for. The development defaults must need no API key: CARTO's public
// dark tiles started answering "API key required", so dark mode darkens the light tiles instead.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/features/maps/map_tiles.dart';
import 'package:phone_app/features/profile/appearance_controller.dart';

TileStyle styleFor({required bool dark}) {
  final c = ProviderContainer(overrides: [isDarkProvider.overrideWithValue(dark)]);
  addTearDown(c.dispose);
  return c.read(tileStyleProvider);
}

void main() {
  test('light: OpenStreetMap as is', () {
    final s = styleFor(dark: false);
    expect(s.url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(s.darken, isFalse);
  });

  test('dark without TILE_URL_DARK: the same keyless tiles, darkened', () {
    final s = styleFor(dark: true);
    expect(s.url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(s.darken, isTrue);
    expect(s.url, isNot(contains('cartocdn')));
    expect(s.attribution, isNot(contains('CARTO')));
  });
}
