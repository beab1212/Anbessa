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
  static const sources = [routes, pins, nearby, driver, me];

  // layers, bottom to top
  static const routeSecondary = 'anb-route-secondary';
  static const routeTraversed = 'anb-route-traversed';
  static const routeCasing = 'anb-route-casing';
  static const routeFill = 'anb-route-fill';
  static const routeStraight = 'anb-route-straight';
  static const nearbyCars = 'anb-nearby-cars';
  static const nearbyLabel = 'anb-nearby-label';
  static const pinLayer = 'anb-pin';
  static const meCone = 'anb-me-cone';
  static const meDot = 'anb-me-dot';
  static const meAvatar = 'anb-me-avatar';
  static const driverCar = 'anb-driver-car';
  static const driverLabel = 'anb-driver-label';

  // images
  static const imgCarDriver = 'anb-car-driver';
  static const imgCarStale = 'anb-car-stale';
  static const imgCarNearby = 'anb-car-nearby';
  static const imgPinPickup = 'anb-pin-pickup';
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

/// The pickup and drop-off pins (`pin`: the image to draw).
String pinsGeoJson({GeoPoint? pickup, GeoPoint? dropoff}) => featureCollection([
      if (pickup != null) pointFeature(pickup, {'pin': SceneIds.imgPinPickup, 'kind': 'pickup'}),
      if (dropoff != null) pointFeature(dropoff, {'pin': SceneIds.imgPinDropoff, 'kind': 'dropoff'}),
    ]);

/// The followed car: its image (stale is grey), bearing, and whether the label above it shows.
String driverGeoJson({GeoPoint? at, double bearing = 0, bool stale = false, bool label = false}) => featureCollection([
      if (at != null) pointFeature(at, {'icon': stale ? SceneIds.imgCarStale : SceneIds.imgCarDriver, 'bearing': _bearing(bearing), 'label': label}),
    ]);

/// The cars around the rider; the first one ([leadLabel]) carries the "N min" label.
String nearbyGeoJson(List<NearbyCarFrame> cars, {bool leadLabel = false}) => featureCollection([
      for (final (i, c) in cars.indexed)
        pointFeature((lat: c.lat, lng: c.lng), {'id': c.id, 'bearing': _bearing(c.bearing), 'opacity': _r2(c.opacity.clamp(0.0, 1.0)), 'lead': leadLabel && i == 0}),
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
