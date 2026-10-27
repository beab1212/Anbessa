// Small labels anchored above a point on the map: the ETA over the car, "Pickup" over the pin.

import 'package:flutter/material.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';

@immutable
class MapCallout {
  const MapCallout({required this.point, required this.label, this.tone, this.icon, this.offsetY = -30});
  final LatLng point;
  final String label;
  final Tone? tone;
  /// unused in the flat design (kept so older screens compile)
  final IconData? icon;
  /// pixels above the point
  final double offsetY;
}

/// The label itself: dark text on the surface with a hairline border; the tone only colours a
/// small dot in front.
class MapCalloutChip extends StatelessWidget {
  const MapCalloutChip({super.key, required this.callout});
  final MapCallout callout;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final dot = callout.tone?.colorsOf(c).$1;
    return IgnorePointer(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(color: c.surface, borderRadius: BorderRadius.circular(AnbessaRadius.sm), border: Border.all(color: c.border)),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (dot != null) ...[Container(width: 7, height: 7, decoration: BoxDecoration(color: dot, shape: BoxShape.circle)), const SizedBox(width: 6)],
            Flexible(child: Text(callout.label, style: AnbessaType.label.copyWith(color: c.text, fontWeight: FontWeight.w700, fontFeatures: AnbessaType.tabular), maxLines: 1, overflow: TextOverflow.ellipsis)),
          ],
        ),
      ),
    );
  }
}
