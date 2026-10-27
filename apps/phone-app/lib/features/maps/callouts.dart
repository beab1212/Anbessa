// Small labels anchored above a point on the map: the ETA over the car, "Pickup" over the pin.

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';

@immutable
class MapCallout {
  const MapCallout({required this.point, required this.label, this.tone, this.icon, this.offsetY = -30});
  final LatLng point;
  final String label;
  final Tone? tone;
  final IconData? icon;
  /// pixels above the point
  final double offsetY;
}

Marker calloutMarker(AnbessaColors c, MapCallout m) => Marker(
      point: m.point,
      width: 240,
      height: 36,
      alignment: Alignment(0, m.offsetY / 16),
      child: Center(child: _CalloutChip(m: m)),
    );

class _CalloutChip extends StatelessWidget {
  const _CalloutChip({required this.m});
  final MapCallout m;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (fg, bg) = m.tone == null ? (c.text, c.surface) : (m.tone!.colorsOf(c).$1, c.surface);
    return IgnorePointer(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(AnbessaRadius.pill), boxShadow: AnbessaElevation.card(c.brightness)),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (m.icon != null) ...[Icon(m.icon, size: 13, color: fg), const SizedBox(width: 4)],
            Flexible(child: Text(m.label, style: AnbessaType.label.copyWith(color: fg, fontFeatures: AnbessaType.tabular), maxLines: 1, overflow: TextOverflow.ellipsis)),
          ],
        ),
      ),
    );
  }
}
