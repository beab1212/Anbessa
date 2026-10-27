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

/// How a route kind is drawn by the raster engine (the vector engine's layers are in
/// scene/scene_style.dart and match it): the main route is an amber line with an ink casing
/// that separates it from the streets under it; the part already driven is grey.
@immutable
class RouteStroke {
  const RouteStroke({required this.color, required this.width, this.casing, this.casingWidth = 0, this.dash});
  final Color color;
  final double width;
  final Color? casing;
  final double casingWidth;
  /// dash and gap lengths in line widths; null is solid
  final List<double>? dash;
}

RouteStroke routeStroke(AnbessaColors c, RouteKind kind, {bool onImagery = false}) {
  final bright = c.isDark || onImagery;
  return switch (kind) {
    RouteKind.primary => RouteStroke(color: c.accent, width: 5, casing: bright ? const Color(0xFF111214) : c.text, casingWidth: 9),
    RouteKind.traversed => RouteStroke(color: bright ? const Color(0xFF7A7F87) : c.faint.withValues(alpha: 0.9), width: 5),
    RouteKind.secondary => RouteStroke(color: bright ? Colors.white : c.text2, width: 4, dash: const [2, 1.5]),
    RouteKind.straight => RouteStroke(color: bright ? Colors.white : c.text2, width: 3, dash: const [0.5, 2]),
  };
}

/// flutter_map polylines for the lines: a casing under a fill for the road ones.
List<Polyline> routePolylines(AnbessaColors c, List<RouteLine> routes, {bool onImagery = false}) {
  final out = <Polyline>[];
  for (final r in routes) {
    if (r.isEmpty) continue;
    final s = routeStroke(c, r.kind, onImagery: onImagery);
    if (s.casing != null) out.add(Polyline(points: r.points, color: s.casing!, strokeWidth: s.casingWidth, strokeCap: StrokeCap.round, strokeJoin: StrokeJoin.round));
    final dash = s.dash;
    out.add(Polyline(
      points: r.points,
      color: s.color,
      strokeWidth: s.width,
      strokeCap: StrokeCap.round,
      strokeJoin: StrokeJoin.round,
      pattern: dash == null ? const StrokePattern.solid() : (dash[0] < 1 ? const StrokePattern.dotted(spacingFactor: 2.5) : StrokePattern.dashed(segments: [dash[0] * s.width * 2, dash[1] * s.width * 2])),
    ));
  }
  return out;
}

List<LatLng> toLatLngs(List<GeoPoint> pts) => pts.map((p) => LatLng(p.lat, p.lng)).toList(growable: false);
List<GeoPoint> toGeoPoints(List<LatLng> pts) => pts.map((p) => (lat: p.latitude, lng: p.longitude)).toList(growable: false);
