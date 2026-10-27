// Route geometry helpers: OSRM polylines (precision 6), projecting a position onto a route,
// distances along it, and bearings. Pure Dart; the map layers and the navigation controller
// build on these.

import 'dart:math';

typedef GeoPoint = ({double lat, double lng});

/// Decode a Google-encoded polyline with 6 decimals (OSRM `geometries=polyline6`).
List<GeoPoint> decodePolyline6(String encoded) => _decode(encoded, 1e6);

/// Decode a 5-decimal polyline (Google Maps default), in case a provider sends one.
List<GeoPoint> decodePolyline5(String encoded) => _decode(encoded, 1e5);

List<GeoPoint> _decode(String encoded, double factor) {
  final out = <GeoPoint>[];
  var index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    int shift = 0, result = 0, b;
    do {
      b = encoded.codeUnitAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) != 0 ? ~(result >> 1) : (result >> 1);
    shift = 0;
    result = 0;
    do {
      b = encoded.codeUnitAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) != 0 ? ~(result >> 1) : (result >> 1);
    out.add((lat: lat / factor, lng: lng / factor));
  }
  return out;
}

String encodePolyline6(List<GeoPoint> points) {
  final sb = StringBuffer();
  var prevLat = 0, prevLng = 0;
  void write(int v) {
    var value = v < 0 ? ~(v << 1) : (v << 1);
    while (value >= 0x20) {
      sb.writeCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    sb.writeCharCode(value + 63);
  }

  for (final p in points) {
    final lat = (p.lat * 1e6).round(), lng = (p.lng * 1e6).round();
    write(lat - prevLat);
    write(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return sb.toString();
}

const _earthRadius = 6371000.0;
double _rad(double d) => d * pi / 180;
double _deg(double r) => r * 180 / pi;

double geoDistanceMeters(GeoPoint a, GeoPoint b) {
  final dLat = _rad(b.lat - a.lat), dLng = _rad(b.lng - a.lng);
  final h = sin(dLat / 2) * sin(dLat / 2) + cos(_rad(a.lat)) * cos(_rad(b.lat)) * sin(dLng / 2) * sin(dLng / 2);
  return 2 * _earthRadius * asin(sqrt(h));
}

/// Compass bearing from [a] to [b], 0–360.
double geoBearing(GeoPoint a, GeoPoint b) {
  final y = sin(_rad(b.lng - a.lng)) * cos(_rad(b.lat));
  final x = cos(_rad(a.lat)) * sin(_rad(b.lat)) - sin(_rad(a.lat)) * cos(_rad(b.lat)) * cos(_rad(b.lng - a.lng));
  return (_deg(atan2(y, x)) + 360) % 360;
}

/// The point [meters] away from [from] along [bearingDeg].
GeoPoint geoOffset(GeoPoint from, double bearingDeg, double meters) {
  final d = meters / _earthRadius, br = _rad(bearingDeg);
  final lat1 = _rad(from.lat), lng1 = _rad(from.lng);
  final lat2 = asin(sin(lat1) * cos(d) + cos(lat1) * sin(d) * cos(br));
  final lng2 = lng1 + atan2(sin(br) * sin(d) * cos(lat1), cos(d) - sin(lat1) * sin(lat2));
  return (lat: _deg(lat2), lng: _deg(lng2));
}

GeoPoint geoLerp(GeoPoint a, GeoPoint b, double t) => (lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t);

/// Interpolate an angle along the shortest arc (350° → 10° passes through 0°).
double lerpAngleDeg(double a, double b, double t) {
  var diff = (b - a) % 360;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return (a + diff * t + 360) % 360;
}

/// Cumulative distance to each vertex, metres; `[0, d01, d01+d12, …]`.
List<double> cumulativeMeters(List<GeoPoint> points) {
  final out = List<double>.filled(points.length, 0);
  for (var i = 1; i < points.length; i++) {
    out[i] = out[i - 1] + geoDistanceMeters(points[i - 1], points[i]);
  }
  return out;
}

double totalMeters(List<GeoPoint> points) => points.isEmpty ? 0 : cumulativeMeters(points).last;

/// Where [p] sits on the route: the segment index, the fraction along it, the perpendicular
/// distance to the route and the distance travelled from the start.
typedef RouteProjection = ({int segment, double t, double offMeters, double alongMeters, GeoPoint point});

RouteProjection projectOntoPolyline(List<GeoPoint> points, GeoPoint p, {List<double>? cumulative}) {
  if (points.isEmpty) return (segment: 0, t: 0, offMeters: double.infinity, alongMeters: 0, point: p);
  if (points.length == 1) return (segment: 0, t: 0, offMeters: geoDistanceMeters(points[0], p), alongMeters: 0, point: points[0]);
  final cum = cumulative ?? cumulativeMeters(points);
  // local equirectangular projection around p: good to well under a metre over route segments
  final cosLat = cos(_rad(p.lat));
  double x(GeoPoint q) => (q.lng - p.lng) * cosLat;
  double y(GeoPoint q) => q.lat - p.lat;
  var best = (segment: 0, t: 0.0, offMeters: double.infinity, alongMeters: 0.0, point: points[0]);
  for (var i = 0; i < points.length - 1; i++) {
    final ax = x(points[i]), ay = y(points[i]), bx = x(points[i + 1]), by = y(points[i + 1]);
    final dx = bx - ax, dy = by - ay;
    final len2 = dx * dx + dy * dy;
    final t = len2 == 0 ? 0.0 : ((-ax) * dx + (-ay) * dy) / len2;
    final tc = t.clamp(0.0, 1.0);
    final q = geoLerp(points[i], points[i + 1], tc);
    final off = geoDistanceMeters(p, q);
    if (off < best.offMeters) {
      best = (segment: i, t: tc, offMeters: off, alongMeters: cum[i] + (cum[i + 1] - cum[i]) * tc, point: q);
    }
  }
  return best;
}

/// Bearing of the route at vertex [index] (towards the next vertex).
double bearingAt(List<GeoPoint> points, int index) {
  if (points.length < 2) return 0;
  final i = index.clamp(0, points.length - 2);
  return geoBearing(points[i], points[i + 1]);
}

/// The part of the route from [alongMeters] to the end (the untravelled remainder).
List<GeoPoint> sliceFrom(List<GeoPoint> points, RouteProjection at) {
  if (points.length < 2) return points;
  return [at.point, ...points.sublist(at.segment + 1)];
}

/// The part of the route from the start to [at] (the travelled part).
List<GeoPoint> sliceTo(List<GeoPoint> points, RouteProjection at) {
  if (points.length < 2) return points;
  return [...points.sublist(0, at.segment + 1), at.point];
}

/// The point [meters] along the route.
GeoPoint pointAlong(List<GeoPoint> points, double meters, {List<double>? cumulative}) {
  if (points.isEmpty) return (lat: 0, lng: 0);
  final cum = cumulative ?? cumulativeMeters(points);
  if (meters <= 0) return points.first;
  if (meters >= cum.last) return points.last;
  var i = 1;
  while (i < cum.length && cum[i] < meters) {
    i++;
  }
  final segLen = cum[i] - cum[i - 1];
  final t = segLen == 0 ? 0.0 : (meters - cum[i - 1]) / segLen;
  return geoLerp(points[i - 1], points[i], t);
}
