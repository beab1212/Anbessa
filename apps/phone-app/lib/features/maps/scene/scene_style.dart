// The native layers of the map scene: what each one draws and how (MapLibre style-spec layout
// and paint). Fixed per style load; only their GeoJSON sources change afterwards.

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart' show Color;
import 'package:maplibre/maplibre.dart' as ml;
import 'package:ride_app_core/ride_app_core.dart';
import 'scene_geojson.dart';

/// What the scene's layers depend on: the theme, imagery under them, 3D, and the image scale.
@immutable
class SceneLook {
  const SceneLook({required this.colors, this.imagery = false, this.buildings = false, this.imageScale = 2});
  final AnbessaColors colors;
  /// satellite: lines need light colours
  final bool imagery;
  /// 3D: extruded buildings under the routes
  final bool buildings;
  /// images are drawn this many times larger than shown, then scaled down by `icon-size`
  final double imageScale;

  bool get bright => colors.isDark || imagery;

  /// Same images and paints (buildings are toggled separately).
  bool samePaint(SceneLook o) => o.colors.isDark == colors.isDark && o.colors.accent == colors.accent && o.colors.text == colors.text && o.imagery == imagery && o.imageScale == imageScale;
}

/// Colours of the route lines: an amber line with an ink casing; grey behind the car; dashed for
/// the leg that isn't the current one, dotted for a straight line without road geometry.
({Color casing, Color fill, Color traversed, Color secondary}) routeColors(SceneLook look) {
  final c = look.colors;
  return (
    casing: look.bright ? const Color(0xFF111214) : c.text,
    fill: c.accent,
    traversed: look.bright ? const Color(0xFF7A7F87) : c.faint,
    secondary: look.bright ? const Color(0xFFFFFFFF) : c.text2,
  );
}

List<Object> _byZoom(List<num> stops) => ['interpolate', ['linear'], ['zoom'], for (final s in stops) s.toDouble()];

/// Width stops (zoom, px) for the main line; the casing adds 4 px.
const _fillStops = [10, 3.0, 14, 5.0, 18, 9.0];
const _casingStops = [10, 6.0, 14, 9.0, 18, 14.0];
const _secondaryStops = [10, 2.0, 14, 3.5, 18, 6.0];
const _straightStops = [10, 2.0, 14, 3.0, 18, 4.5];

const _roundLine = {'line-cap': 'round', 'line-join': 'round'};

List<Object> _kind(SceneRouteKind k) => ['==', ['get', 'kind'], k.name];

/// Size of the symbols by zoom (images are drawn [SceneLook.imageScale] times larger).
List<Object> _iconSize(SceneLook look, {double far = 0.6, double near = 1.0, double close = 1.2}) {
  final s = 1 / look.imageScale;
  return _byZoom([10, far * s, 16, near * s, 19, close * s]);
}

/// The scene's layers, bottom to top.
List<ml.StyleLayer> sceneLayers(SceneLook look) {
  final rc = routeColors(look);
  final k = look.imageScale;
  return [
    ml.LineStyleLayer(
      id: SceneIds.routeSecondary,
      sourceId: SceneIds.routes,
      filter: _kind(SceneRouteKind.secondary),
      layout: _roundLine,
      paint: {'line-color': cssColor(rc.secondary), 'line-width': _byZoom(_secondaryStops), 'line-dasharray': [1.5, 1.5]},
    ),
    ml.LineStyleLayer(
      id: SceneIds.routeTraversed,
      sourceId: SceneIds.routes,
      filter: _kind(SceneRouteKind.traversed),
      layout: _roundLine,
      paint: {'line-color': cssColor(rc.traversed), 'line-width': _byZoom(_fillStops), 'line-opacity': 0.9},
    ),
    ml.LineStyleLayer(
      id: SceneIds.routeCasing,
      sourceId: SceneIds.routes,
      filter: _kind(SceneRouteKind.primary),
      layout: _roundLine,
      paint: {'line-color': cssColor(rc.casing), 'line-width': _byZoom(_casingStops)},
    ),
    ml.LineStyleLayer(
      id: SceneIds.routeFill,
      sourceId: SceneIds.routes,
      filter: _kind(SceneRouteKind.primary),
      layout: _roundLine,
      paint: {'line-color': cssColor(rc.fill), 'line-width': _byZoom(_fillStops)},
    ),
    ml.LineStyleLayer(
      id: SceneIds.routeStraight,
      sourceId: SceneIds.routes,
      filter: _kind(SceneRouteKind.straight),
      layout: _roundLine,
      paint: {'line-color': cssColor(rc.secondary), 'line-width': _byZoom(_straightStops), 'line-dasharray': [0.1, 2.0]},
    ),
    ml.SymbolStyleLayer(
      id: SceneIds.nearbyCars,
      sourceId: SceneIds.nearby,
      layout: {
        'icon-image': SceneIds.imgCarNearby,
        'icon-size': _iconSize(look, far: 0.55),
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {'icon-opacity': ['get', 'opacity']},
    ),
    ml.SymbolStyleLayer(
      id: SceneIds.nearbyLabel,
      sourceId: SceneIds.nearby,
      filter: ['==', ['get', 'lead'], true],
      layout: {
        'icon-image': SceneIds.imgLabelNearby,
        'icon-size': 1 / k,
        'icon-anchor': 'bottom',
        'icon-offset': [0.0, -16.0 * k],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {'icon-opacity': ['get', 'opacity']},
    ),
    ml.SymbolStyleLayer(
      id: SceneIds.pinLayer,
      sourceId: SceneIds.pins,
      layout: {
        'icon-image': ['get', 'pin'],
        'icon-size': 1 / k,
        'icon-anchor': 'bottom',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    ),
    ml.SymbolStyleLayer(
      id: SceneIds.meCone,
      sourceId: SceneIds.me,
      filter: ['==', ['get', 'cone'], true],
      layout: {
        'icon-image': SceneIds.imgMeCone,
        'icon-size': 1 / k,
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    ),
    ml.SymbolStyleLayer(
      id: SceneIds.meDot,
      sourceId: SceneIds.me,
      layout: {
        'icon-image': SceneIds.imgMeDot,
        'icon-size': 1 / k,
        'icon-pitch-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    ),
    ml.SymbolStyleLayer(
      id: SceneIds.driverCar,
      sourceId: SceneIds.driver,
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': _iconSize(look),
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    ),
    ml.SymbolStyleLayer(
      id: SceneIds.driverLabel,
      sourceId: SceneIds.driver,
      filter: ['==', ['get', 'label'], true],
      layout: {
        'icon-image': SceneIds.imgLabelDriver,
        'icon-size': 1 / k,
        'icon-anchor': 'bottom',
        'icon-offset': [0.0, -26.0 * k],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    ),
  ];
}
