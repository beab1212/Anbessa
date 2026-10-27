// Which raster tiles to show: the configured light or dark style, following the theme.
// Light: TILE_URL, or public OSM tiles in development. Dark: TILE_URL_DARK when set; otherwise the
// light tiles drawn through a dark filter (no second provider, no API key; CARTO's public dark
// tiles now answer "API key required").

import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/config/env.dart';
import '../profile/appearance_controller.dart';

const _osmTiles = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/// `darken`: draw the tiles through flutter_map's dark-mode filter.
typedef TileStyle = ({String url, List<String> subdomains, String attribution, bool retina, bool darken});

final tileStyleProvider = Provider<TileStyle>((ref) {
  final dark = ref.watch(isDarkProvider);
  final lightUrl = Env.tileUrl.isEmpty ? _osmTiles : Env.tileUrl;
  final light = (url: lightUrl, subdomains: const <String>[], attribution: Env.tileAttribution, retina: lightUrl.contains('{r}'), darken: false);
  if (!dark) return light;
  if (Env.tileUrlDark.isEmpty) return (url: light.url, subdomains: light.subdomains, attribution: light.attribution, retina: light.retina, darken: true);
  return (
    url: Env.tileUrlDark,
    subdomains: const <String>[],
    attribution: Env.tileAttributionDark.isEmpty ? Env.tileAttribution : Env.tileAttributionDark,
    retina: Env.tileUrlDark.contains('{r}'),
    darken: false,
  );
});
