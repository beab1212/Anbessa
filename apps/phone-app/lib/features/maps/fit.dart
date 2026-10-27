// Fitting the camera to points while a sheet covers the bottom and banners cover the top.

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

/// A camera fit that keeps [points] inside the part of the map not covered by [top]/[bottom]
/// pixels of overlay, with [side] breathing room. One point centres on it at [singleZoom].
CameraFit fitWithInsets(List<LatLng> points, {double top = 0, double bottom = 0, double side = 48, double maxZoom = 17, double singleZoom = 15}) {
  final pad = EdgeInsets.fromLTRB(side, top + 48, side, bottom + 32);
  if (points.length == 1) {
    return CameraFit.bounds(bounds: LatLngBounds(points.first, points.first), padding: pad, maxZoom: singleZoom, minZoom: singleZoom);
  }
  return CameraFit.bounds(bounds: LatLngBounds.fromPoints(points), padding: pad, maxZoom: maxZoom);
}

bool sameLatLngs(List<LatLng> a, List<LatLng> b, {double eps = 1e-4}) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if ((a[i].latitude - b[i].latitude).abs() > eps || (a[i].longitude - b[i].longitude).abs() > eps) return false;
  }
  return true;
}
