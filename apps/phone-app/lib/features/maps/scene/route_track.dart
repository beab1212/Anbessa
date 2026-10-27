// A route a car is known to drive along: its vertices with cumulative metres, the point and the
// bearing at a distance along it, and projection of a position onto a window of it (so a car
// keeps moving forward along its own road instead of jumping to a parallel or crossing street).
// Pure Dart: the marker animator and the camera build on it, and it is unit tested.

import 'dart:math';

import 'package:ride_app_core/ride_app_core.dart';

class RouteTrack {
  RouteTrack(List<GeoPoint> points)
      : points = List.unmodifiable(points),
        cumulative = List.unmodifiable(cumulativeMeters(points));

  final List<GeoPoint> points;
  final List<double> cumulative;

  double get length => cumulative.isEmpty ? 0 : cumulative.last;
  bool get isUsable => points.length >= 2 && length > 0;

  /// Same geometry (the same list, or the same vertices).
  bool sameAs(List<GeoPoint> other) {
    if (identical(points, other)) return true;
    if (points.length != other.length) return false;
    if (points.isEmpty) return true;
    bool eq(GeoPoint a, GeoPoint b) => (a.lat - b.lat).abs() < 1e-7 && (a.lng - b.lng).abs() < 1e-7;
    return eq(points.first, other.first) && eq(points.last, other.last) && eq(points[points.length ~/ 2], other[other.length ~/ 2]);
  }

  /// The index of the segment holding [meters] (binary search on the cumulative distances).
  int segmentAt(double meters) {
    if (points.length < 2) return 0;
    if (meters <= 0) return 0;
    if (meters >= length) return points.length - 2;
    var lo = 0, hi = cumulative.length - 1;
    while (hi - lo > 1) {
      final mid = (lo + hi) >> 1;
      if (cumulative[mid] <= meters) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return lo.clamp(0, points.length - 2);
  }

  /// The point [meters] along the route (clamped to its ends).
  GeoPoint pointAt(double meters) {
    if (points.isEmpty) return (lat: 0, lng: 0);
    if (points.length == 1 || meters <= 0) return points.first;
    if (meters >= length) return points.last;
    final i = segmentAt(meters);
    final segLen = cumulative[i + 1] - cumulative[i];
    final t = segLen <= 0 ? 0.0 : (meters - cumulative[i]) / segLen;
    return geoLerp(points[i], points[i + 1], t);
  }

  /// The direction of travel at [meters]: the bearing across a short span around it, so the car
  /// turns through a corner instead of snapping at the vertex.
  double bearingAt(double meters, {double span = 6}) {
    if (!isUsable) return 0;
    var a = meters - span, b = meters + span;
    if (a < 0) {
      b -= a;
      a = 0;
    }
    if (b > length) {
      a = max(0, a - (b - length));
      b = length;
    }
    final pa = pointAt(a), pb = pointAt(b);
    if (geoDistanceMeters(pa, pb) < 0.5) {
      final i = segmentAt(meters);
      return geoBearing(points[i], points[i + 1]);
    }
    return geoBearing(pa, pb);
  }

  /// Where [p] falls on the route between [from] and [to] metres along it (the whole route by
  /// default): the closest point in that window, its distance along and how far [p] is from it.
  RouteProjection project(GeoPoint p, {double from = double.negativeInfinity, double to = double.infinity}) {
    if (points.isEmpty) return (segment: 0, t: 0, offMeters: double.infinity, alongMeters: 0, point: p);
    if (points.length == 1) return (segment: 0, t: 0, offMeters: geoDistanceMeters(points[0], p), alongMeters: 0, point: points[0]);
    final lo = max(0.0, from), hi = min(length, to);
    final cosLat = cos(p.lat * pi / 180);
    double x(GeoPoint q) => (q.lng - p.lng) * cosLat;
    double y(GeoPoint q) => q.lat - p.lat;
    RouteProjection? best;
    final first = segmentAt(lo), last = segmentAt(hi);
    for (var i = first; i <= last; i++) {
      final segStart = cumulative[i], segEnd = cumulative[i + 1];
      final segLen = segEnd - segStart;
      final ax = x(points[i]), ay = y(points[i]), bx = x(points[i + 1]), by = y(points[i + 1]);
      final dx = bx - ax, dy = by - ay;
      final len2 = dx * dx + dy * dy;
      var t = len2 == 0 ? 0.0 : ((-ax) * dx + (-ay) * dy) / len2;
      // keep the answer inside the window
      final tMin = segLen <= 0 ? 0.0 : ((lo - segStart) / segLen).clamp(0.0, 1.0);
      final tMax = segLen <= 0 ? 1.0 : ((hi - segStart) / segLen).clamp(0.0, 1.0);
      t = t.clamp(tMin, tMax);
      final q = geoLerp(points[i], points[i + 1], t);
      final off = geoDistanceMeters(p, q);
      if (best == null || off < best.offMeters) {
        best = (segment: i, t: t, offMeters: off, alongMeters: segStart + segLen * t, point: q);
      }
    }
    return best!;
  }
}
