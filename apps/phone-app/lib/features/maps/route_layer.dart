// Route lines: the road from a polyline, the part already driven, a secondary leg, or a straight
// dotted line when there's no geometry.

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';

enum RouteKind { primary, traversed, secondary, straight }

@immutable
class RouteLine {
  const RouteLine(this.points, {this.kind = RouteKind.primary});
  final List<LatLng> points;
  final RouteKind kind;

  /// From an encoded polyline (precision 6); null or empty gives an empty line.
  factory RouteLine.fromPolyline6(String? encoded, {RouteKind kind = RouteKind.primary}) =>
      RouteLine(encoded == null || encoded.isEmpty ? const [] : decodePolyline6(encoded).map((p) => LatLng(p.lat, p.lng)).toList(growable: false), kind: kind);

  factory RouteLine.straight(LatLng a, LatLng b) => RouteLine([a, b], kind: RouteKind.straight);

  bool get isEmpty => points.length < 2;
}

/// Flutter-map polylines for the lines: a casing under a fill for the road ones.
List<Polyline> routePolylines(AnbessaColors c, List<RouteLine> routes) {
  final out = <Polyline>[];
  for (final r in routes) {
    if (r.isEmpty) continue;
    switch (r.kind) {
      case RouteKind.primary:
        out.add(Polyline(points: r.points, color: c.isDark ? const Color(0xFF0B1220) : Colors.white, strokeWidth: 9, strokeCap: StrokeCap.round, strokeJoin: StrokeJoin.round));
        out.add(Polyline(points: r.points, color: c.isDark ? c.accentStrong : c.accent, strokeWidth: 5, strokeCap: StrokeCap.round, strokeJoin: StrokeJoin.round));
      case RouteKind.traversed:
        out.add(Polyline(points: r.points, color: c.faint.withValues(alpha: 0.9), strokeWidth: 5, strokeCap: StrokeCap.round, strokeJoin: StrokeJoin.round));
      case RouteKind.secondary:
        out.add(Polyline(points: r.points, color: c.info, strokeWidth: 4, strokeCap: StrokeCap.round, pattern: StrokePattern.dashed(segments: const [12, 8])));
      case RouteKind.straight:
        out.add(Polyline(points: r.points, color: c.text2, strokeWidth: 3, pattern: const StrokePattern.dotted(spacingFactor: 2.5)));
    }
  }
  return out;
}

List<LatLng> toLatLngs(List<GeoPoint> pts) => pts.map((p) => LatLng(p.lat, p.lng)).toList(growable: false);
List<GeoPoint> toGeoPoints(List<LatLng> pts) => pts.map((p) => (lat: p.latitude, lng: p.longitude)).toList(growable: false);
