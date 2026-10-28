// The native layers of the map scene: what each one draws and how (MapLibre style-spec layout
// and paint). Fixed per style load; only their GeoJSON sources change afterwards.

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart' show Color;
import 'package:maplibre/maplibre.dart' as ml;
import 'package:ride_app_core/ride_app_core.dart';
import 'scene_geojson.dart';
import 'scene_images.dart' show carImageWidth;

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

  /// The 3D car frames are painted at most twice their size: 36 of them at 3× would take a lot of
  /// texture memory for little gain at the sizes cars are shown.
  double get car3dScale => imageScale > 2 ? 2 : imageScale;

  /// Same images and paints (buildings are toggled separately).
  bool samePaint(SceneLook o) => o.colors.isDark == colors.isDark && o.colors.accent == colors.accent && o.colors.text == colors.text && o.imagery == imagery && o.imageScale == imageScale;
}

/// Colours of the route lines: an amber line with a deeper amber edge (ink on dark and satellite
/// maps); grey behind the car; dashed for
/// the leg that isn't the current one, dotted for a straight line without road geometry.
({Color casing, Color fill, Color traversed, Color secondary}) routeColors(SceneLook look) {
  final c = look.colors;
  return (
    casing: look.bright ? const Color(0xFF111214) : const Color(0xFFC98A00),
    fill: c.accent,
    traversed: look.bright ? const Color(0xFF7A7F87) : c.faint,
    secondary: look.bright ? const Color(0xFFFFFFFF) : c.text2,
  );
}

List<Object> _byZoom(List<num> stops) => ['interpolate', ['linear'], ['zoom'], for (final s in stops) s.toDouble()];

/// Width stops (zoom, px) for the main line; the casing adds a thin edge.
const _fillStops = [10, 3.0, 14, 5.0, 18, 9.0];
const _casingStops = [10, 4.5, 14, 7.5, 18, 12.0];
const _secondaryStops = [10, 2.0, 14, 3.5, 18, 6.0];
const _straightStops = [10, 2.0, 14, 3.0, 18, 4.5];

const _roundLine = {'line-cap': 'round', 'line-join': 'round'};

List<Object> _kind(SceneRouteKind k) => ['==', ['get', 'kind'], k.name];

/// How wide a car is shown by zoom (logical pixels; its length is about twice that). Real
/// cars would be a pixel or two wide at city zooms, so they are drawn larger, but they grow with
/// the map like the streets do, from a readable minimum to about a lane's width up close, and
/// never past [carImageWidth] (the images are only scaled down).
const driverCarWidthStops = <(double, double)>[(12, 15), (15, 16), (17, 19), (18, 24), (19, 32)];
const nearbyCarWidthStops = <(double, double)>[(12, 13), (15, 14), (17, 17), (18, 21), (19, 28)];

/// `icon-size` for a car image: [stops] of shown widths, as a fraction of the image (painted
/// [SceneLook.imageScale] times larger), interpolated a little faster than linear between them,
/// as map distances grow.
List<Object> carIconSize(SceneLook look, List<(double, double)> stops) => [
      'interpolate',
      ['exponential', 1.5],
      ['zoom'],
      for (final (z, w) in stops) ...[z, w / carImageWidth / look.imageScale],
    ];

/// `icon-size` for a 3D car frame: the same shown car widths as the flat car (a frame is painted
/// so its car is [carImageWidth] wide at [SceneLook.car3dScale]).
List<Object> car3dIconSize(SceneLook look, List<(double, double)> stops) => [
      'interpolate',
      ['exponential', 1.5],
      ['zoom'],
      for (final (z, w) in stops) ...[z, w / carImageWidth / look.car3dScale],
    ];

/// The pulse's radius on screen, in logical pixels (the old 220 px rings).
const pulseRadius = 110.0;

/// The offset of a label over a car, growing with the car: (zoom, logical pixels above).
List<Object> _labelOffset(SceneLook look, List<(double, double)> stops) => [
      'interpolate',
      ['linear'],
      ['zoom'],
      for (final (z, dy) in stops) ...[z, ['literal', [0.0, -dy * look.imageScale]]],
    ];

/// The flat car (2D and satellite) and its shadow; the 3D map uses the standing frames instead.
const _flatCar = ['!=', ['get', 'car3d'], true];
const _car3d = ['==', ['get', 'car3d'], true];

/// How the 3D car stands: upright facing the screen, its frame already chosen for the heading
/// and the camera's bearing, the car's ground centre on the point.
const _car3dLayout = {
  'icon-image': ['get', 'icon3'],
  'icon-rotation-alignment': 'viewport',
  'icon-pitch-alignment': 'viewport',
  'icon-anchor': 'center',
  'icon-allow-overlap': true,
  'icon-ignore-placement': true,
};

/// How every car lies on the map: flat on the road (pitch-aligned), turned by the bearing the
/// heading filter settled on, never hidden by collisions.
const _carLayout = {
  'icon-rotate': ['get', 'bearing'],
  'icon-rotation-alignment': 'map',
  'icon-pitch-alignment': 'map',
  'icon-anchor': 'center',
  'icon-allow-overlap': true,
  'icon-ignore-placement': true,
};

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
    // the search pulse: rings on the ground, drawn natively so they never trail the map
    ml.CircleStyleLayer(
      id: SceneIds.pulseLayer,
      sourceId: SceneIds.pulse,
      paint: {
        'circle-radius': ['*', ['get', 'r'], pulseRadius],
        'circle-color': cssColor(look.colors.accent),
        'circle-opacity': ['get', 'o'],
        'circle-pitch-alignment': 'map',
      },
    ),
    // each car's contact shadow right under it, then the car
    ml.SymbolStyleLayer(
      id: SceneIds.nearbyShadow,
      sourceId: SceneIds.nearby,
      filter: _flatCar,
      layout: {'icon-image': SceneIds.imgCarShadow, 'icon-size': carIconSize(look, nearbyCarWidthStops), ..._carLayout},
      paint: {'icon-opacity': ['get', 'opacity']},
    ),
    ml.SymbolStyleLayer(
      id: SceneIds.nearbyCars,
      sourceId: SceneIds.nearby,
      filter: _flatCar,
      layout: {'icon-image': SceneIds.imgCarNearby, 'icon-size': carIconSize(look, nearbyCarWidthStops), ..._carLayout},
      paint: {'icon-opacity': ['get', 'opacity']},
    ),
    ml.SymbolStyleLayer(
      id: SceneIds.nearbyCar3d,
      sourceId: SceneIds.nearby,
      filter: _car3d,
      layout: {'icon-size': car3dIconSize(look, nearbyCarWidthStops), ..._car3dLayout},
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
        'icon-offset': _labelOffset(look, const [(15, 18), (18, 26), (19, 33)]),
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
      filter: ['!=', ['get', 'avatar'], true],
      layout: {
        'icon-image': SceneIds.imgMeDot,
        'icon-size': 1 / k,
        'icon-pitch-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    ),
    ml.SymbolStyleLayer(
      id: SceneIds.meAvatar,
      sourceId: SceneIds.me,
      filter: ['==', ['get', 'avatar'], true],
      layout: {
        'icon-image': SceneIds.imgMeAvatar,
        'icon-size': 1 / k,
        'icon-anchor': 'bottom',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    ),
    ml.SymbolStyleLayer(
      id: SceneIds.driverShadow,
      sourceId: SceneIds.driver,
      filter: _flatCar,
      layout: {'icon-image': SceneIds.imgCarShadow, 'icon-size': carIconSize(look, driverCarWidthStops), ..._carLayout},
    ),
    ml.SymbolStyleLayer(
      id: SceneIds.driverCar,
      sourceId: SceneIds.driver,
      filter: _flatCar,
      layout: {'icon-image': ['get', 'icon'], 'icon-size': carIconSize(look, driverCarWidthStops), ..._carLayout},
    ),
    ml.SymbolStyleLayer(
      id: SceneIds.driverCar3d,
      sourceId: SceneIds.driver,
      filter: _car3d,
      layout: {'icon-size': car3dIconSize(look, driverCarWidthStops), ..._car3dLayout},
      paint: {'icon-opacity': ['get', 'opacity']},
    ),
    ml.SymbolStyleLayer(
      id: SceneIds.driverLabel,
      sourceId: SceneIds.driver,
      filter: ['==', ['get', 'label'], true],
      layout: {
        'icon-image': SceneIds.imgLabelDriver,
        'icon-size': 1 / k,
        'icon-anchor': 'bottom',
        'icon-offset': _labelOffset(look, const [(15, 22), (17, 26), (18, 30), (19, 38)]),
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    ),
    // labels at points; the room under each label's tail is part of its image
    ml.SymbolStyleLayer(
      id: SceneIds.calloutLayer,
      sourceId: SceneIds.callouts,
      layout: {
        'icon-image': ['get', 'img'],
        'icon-size': 1 / k,
        'icon-anchor': 'bottom',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    ),
  ];
}
