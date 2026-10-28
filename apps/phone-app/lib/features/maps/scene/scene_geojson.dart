// The GeoJSON the map scene sends to its native sources. Pure functions (no platform map), so
// they are unit tested: one FeatureCollection string per source, coordinates rounded to ~10 cm
// and bearings to a tenth of a degree to keep the strings short.

import 'dart:convert';
import 'dart:ui' show Color;

import 'package:flutter/foundation.dart';
import 'package:ride_app_core/ride_app_core.dart';

/// Source and layer ids, all prefixed so they never clash with the base style's.
abstract final class SceneIds {
  static const routes = 'anb-routes';
  static const pins = 'anb-pins';
  static const nearby = 'anb-nearby';
  static const driver = 'anb-driver';
  static const me = 'anb-me';
  static const pulse = 'anb-pulse';
  static const callouts = 'anb-callouts';
  static const sources = [routes, pins, nearby, driver, me, pulse, callouts];

  // layers, bottom to top
  static const routeSecondary = 'anb-route-secondary';
  static const routeTraversed = 'anb-route-traversed';
  static const routeCasing = 'anb-route-casing';
  static const routeFill = 'anb-route-fill';
  static const routeStraight = 'anb-route-straight';
  static const pulseLayer = 'anb-pulse';
  static const nearbyShadow = 'anb-nearby-shadow';
  static const nearbyCars = 'anb-nearby-cars';
  static const nearbyCar3d = 'anb-nearby-car3d';
  static const nearbyLabel = 'anb-nearby-label';
  static const pinLayer = 'anb-pin';
  static const meCone = 'anb-me-cone';
  static const meDot = 'anb-me-dot';
  static const meAvatar = 'anb-me-avatar';
  static const driverShadow = 'anb-driver-shadow';
  static const driverCar = 'anb-driver-car';
  static const driverCar3d = 'anb-driver-car3d';
  static const driverLabel = 'anb-driver-label';
  static const calloutLayer = 'anb-callout';

  // images
  static const imgCarDriver = 'anb-car-driver';
  static const imgCarStale = 'anb-car-stale';
  static const imgCarNearby = 'anb-car-nearby';
  static const imgCarShadow = 'anb-car-shadow';
  static const imgPinPickup = 'anb-pin-pickup';
  static const imgPinPickupPlain = 'anb-pin-pickup-plain';
  static const imgPinDropoff = 'anb-pin-dropoff';
  static const imgMeDot = 'anb-me-dot';
  static const imgMeCone = 'anb-me-cone';
  static const imgMeAvatar = 'anb-me-avatar';
  static const imgLabelDriver = 'anb-label-driver';
  static const imgLabelNearby = 'anb-label-nearby';
}

/// How a line is drawn; the layers filter on it.
enum SceneRouteKind { primary, traversed, secondary, straight }

@immutable
class SceneRoute {
  const SceneRoute(this.points, this.kind);
  final List<GeoPoint> points;
  final SceneRouteKind kind;
}

/// One anonymous car around the rider, as drawn this frame.
@immutable
class NearbyCarFrame {
  const NearbyCarFrame({required this.id, required this.lat, required this.lng, required this.bearing, this.opacity = 1});
  final int id;
  final double lat;
  final double lng;
  final double bearing;
  /// 0–1, fades a car in when it appears and out when it leaves
  final double opacity;
}

double _r6(double v) => (v * 1e6).roundToDouble() / 1e6;
double _r1(double v) => (v * 10).roundToDouble() / 10;
List<double> _coord(GeoPoint p) => [_r6(p.lng), _r6(p.lat)];
double _bearing(double b) => _r1(((b % 360) + 360) % 360);

String featureCollection(List<Map<String, Object?>> features) => jsonEncode({'type': 'FeatureCollection', 'features': features});

Map<String, Object?> pointFeature(GeoPoint p, [Map<String, Object?> props = const {}]) => {
      'type': 'Feature',
      'geometry': {'type': 'Point', 'coordinates': _coord(p)},
      'properties': props,
    };

Map<String, Object?> lineFeature(List<GeoPoint> points, [Map<String, Object?> props = const {}]) => {
      'type': 'Feature',
      'geometry': {'type': 'LineString', 'coordinates': [for (final p in points) _coord(p)]},
      'properties': props,
    };

const emptyFeatureCollection = '{"type":"FeatureCollection","features":[]}';

/// Every route line in one source; lines with fewer than two points are left out.
String routesGeoJson(List<SceneRoute> routes) => featureCollection([
      for (final r in routes)
        if (r.points.length >= 2) lineFeature(r.points, {'kind': r.kind.name}),
    ]);

/// The pickup and drop-off pins (`pin`: the image to draw). The pickup is the person's avatar
/// pin, or with [plainPickup] a plain pickup pin without their photo (once a ride is booked).
String pinsGeoJson({GeoPoint? pickup, GeoPoint? dropoff, bool plainPickup = false}) => featureCollection([
      if (pickup != null) pointFeature(pickup, {'pin': plainPickup ? SceneIds.imgPinPickupPlain : SceneIds.imgPinPickup, 'kind': 'pickup'}),
      if (dropoff != null) pointFeature(dropoff, {'pin': SceneIds.imgPinDropoff, 'kind': 'dropoff'}),
    ]);

/// The 3D car frame for a car (see car3d.dart), when the map is in 3D: null keeps the flat car.
typedef Car3dFrame = String Function(double bearing);

/// The followed car: its image (stale is grey), bearing, and whether the label above it shows.
/// With [frame3d] it is drawn as the standing 3D car instead (`car3d`, its frame image in
/// `icon3`, see-through when stale).
String driverGeoJson({GeoPoint? at, double bearing = 0, bool stale = false, bool label = false, Car3dFrame? frame3d}) => featureCollection([
      if (at != null)
        pointFeature(at, {
          'icon': stale ? SceneIds.imgCarStale : SceneIds.imgCarDriver,
          'bearing': _bearing(bearing),
          'label': label,
          if (frame3d != null) ...{'car3d': true, 'icon3': frame3d(bearing), 'opacity': stale ? 0.55 : 1.0},
        }),
    ]);

/// The cars around the rider; the first one ([leadLabel]) carries the "N min" label.
String nearbyGeoJson(List<NearbyCarFrame> cars, {bool leadLabel = false, Car3dFrame? frame3d}) => featureCollection([
      for (final (i, c) in cars.indexed)
        pointFeature((lat: c.lat, lng: c.lng), {
          'id': c.id,
          'bearing': _bearing(c.bearing),
          'opacity': _r2(c.opacity.clamp(0.0, 1.0)),
          'lead': leadLabel && i == 0,
          if (frame3d != null) ...{'car3d': true, 'icon3': frame3d(c.bearing)},
        }),
    ]);

/// The search pulse around a point, as circles on the ground: two still rings and two waves
/// half a period apart, at phase [t] (0–1) of a wave. `r` is a fraction of the pulse's radius,
/// `o` the opacity.
String pulseGeoJson(GeoPoint? at, double t) {
  if (at == null) return emptyFeatureCollection;
  double easeOut(double v) => 1 - (1 - v) * (1 - v) * (1 - v);
  return featureCollection([
    pointFeature(at, {'r': 0.72, 'o': 0.16}),
    pointFeature(at, {'r': 0.44, 'o': 0.28}),
    for (final phase in const [0.0, 0.5])
      () {
        final v = (t + phase) % 1.0;
        return pointFeature(at, {'r': _r2(0.3 + 0.7 * easeOut(v)), 'o': _r2(0.22 * (1 - v))});
      }(),
  ]);
}

/// Labels at points ("Arrive 14:32" over the drop-off): each its own image (`img`), its tail
/// [SceneCallout.lift] logical pixels above the point.
@immutable
class SceneCallout {
  const SceneCallout({required this.point, required this.image, this.lift = 0});
  final GeoPoint point;
  final String image;
  final double lift;
}

String calloutsGeoJson(List<SceneCallout> callouts) => featureCollection([
      for (final c in callouts) pointFeature(c.point, {'img': c.image, 'lift': _r1(c.lift)}),
    ]);

double _r2(double v) => (v * 100).roundToDouble() / 100;

/// The person's dot; `cone` when a heading is known; `avatar` when they are drawn as their
/// avatar pin instead (the home map).
String meGeoJson({GeoPoint? at, double? heading, bool avatar = false}) => featureCollection([
      if (at != null) pointFeature(at, {'bearing': _bearing(heading ?? 0), 'cone': heading != null && !avatar, if (avatar) 'avatar': true}),
    ]);

/// A colour as MapLibre reads it (`rgba(r, g, b, a)`).
String cssColor(Color c) {
  int ch(double v) => (v * 255).round().clamp(0, 255);
  return 'rgba(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)}, ${_r2(c.a)})';
}
