// What each map mode draws, for both engines.
//
// Vector (MapLibre): OpenFreeMap's styles by default (free, no API key): "positron" in light,
// "dark" in dark, both quiet so routes and cars stand out. 3D is the same style tilted, with the
// buildings extruded. Satellite is raster imagery (Esri World Imagery by default) in a small
// inline style. Production points MAP_STYLE_URL(_DARK) / SATELLITE_TILE_URL at its own servers.
//
// Raster (flutter_map, desktop and tests): see map_tiles.dart; satellite uses the same imagery.

import 'dart:convert';

import 'package:ride_app_core/ride_app_core.dart';
import '../../core/config/env.dart';
import 'map_mode.dart';

const _openFreeMapLight = 'https://tiles.openfreemap.org/styles/positron';
const _openFreeMapDark = 'https://tiles.openfreemap.org/styles/dark';
const _esriImagery = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

const openFreeMapAttribution = '© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors';

String get satelliteTiles => Env.satelliteTileUrl.isEmpty ? _esriImagery : Env.satelliteTileUrl;
String get satelliteAttribution => Env.satelliteAttribution.isNotEmpty ? Env.satelliteAttribution : 'Esri, Maxar, Earthstar Geographics';

/// The vector style for a mode: a URL, or an inline JSON style (satellite).
String vectorStyleFor(MapMode mode, {required bool dark}) {
  if (mode == MapMode.satellite) return _satelliteStyle;
  if (dark) return Env.mapStyleUrlDark.isNotEmpty ? Env.mapStyleUrlDark : (Env.mapStyleUrl.isNotEmpty ? Env.mapStyleUrl : _openFreeMapDark);
  return Env.mapStyleUrl.isNotEmpty ? Env.mapStyleUrl : _openFreeMapLight;
}

String vectorAttributionFor(MapMode mode) => mode == MapMode.satellite ? satelliteAttribution : openFreeMapAttribution;

final String _satelliteStyle = jsonEncode({
  'version': 8,
  'sources': {
    'imagery': {'type': 'raster', 'tiles': [satelliteTiles], 'tileSize': 256, 'maxzoom': 19, 'attribution': satelliteAttribution},
  },
  'layers': [
    {'id': 'background', 'type': 'background', 'paint': {'background-color': '#1b1d1f'}},
    {'id': 'imagery', 'type': 'raster', 'source': 'imagery'},
  ],
});

/// The camera tilt per mode.
double pitchFor(MapMode mode) => mode == MapMode.threeD ? 55 : 0;

/// Extruded buildings for 3D: OpenMapTiles' `building` layer (render_height), in the theme's tones.
/// Added on top of the base style once it has loaded; the source id is OpenFreeMap's.
const buildingsLayerId = 'anbessa-buildings-3d';
const buildingsSourceId = 'openmaptiles';

Map<String, Object> buildingsPaint(AnbessaColors c) => {
      'fill-extrusion-color': c.isDark ? '#2a2d33' : '#e4e1da',
      'fill-extrusion-height': ['get', 'render_height'],
      'fill-extrusion-base': ['get', 'render_min_height'],
      'fill-extrusion-opacity': 0.85,
    };
