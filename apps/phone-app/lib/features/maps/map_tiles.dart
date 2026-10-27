// Which raster tiles to show: the configured light or dark style, following the theme.
// Development falls back to public OSM (light) and CARTO (dark) tiles; production sets TILE_URL
// and TILE_URL_DARK to the self-hosted tile server.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/config/env.dart';
import '../profile/appearance_controller.dart';

const _osmTiles = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const _cartoDark = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

typedef TileStyle = ({String url, List<String> subdomains, String attribution, bool retina});

final tileStyleProvider = Provider<TileStyle>((ref) {
  final dark = ref.watch(isDarkProvider);
  if (dark) {
    return Env.tileUrlDark.isEmpty
        ? (url: _cartoDark, subdomains: const ['a', 'b', 'c', 'd'], attribution: Env.tileAttributionDark, retina: true)
        : (url: Env.tileUrlDark, subdomains: const [], attribution: Env.tileAttributionDark, retina: Env.tileUrlDark.contains('{r}'));
  }
  return Env.tileUrl.isEmpty
      ? (url: _osmTiles, subdomains: const [], attribution: Env.tileAttribution, retina: false)
      : (url: Env.tileUrl, subdomains: const [], attribution: Env.tileAttribution, retina: Env.tileUrl.contains('{r}'));
});
