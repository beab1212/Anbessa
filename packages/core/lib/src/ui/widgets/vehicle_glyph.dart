// An icon per vehicle type code. Unknown codes get the plain car.

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';

IconData vehicleIcon(String code) => switch (code.toLowerCase()) {
      'minivan' || 'van' || 'minibus' => Icons.airport_shuttle_rounded,
      'comfort' || 'premium' || 'business' => Icons.directions_car_filled_rounded,
      'bajaj' || 'tuktuk' || 'three_wheeler' => Icons.electric_rickshaw_rounded,
      'moto' || 'motorbike' || 'bike' => Icons.two_wheeler_rounded,
      'electric' || 'ev' => Icons.electric_car_rounded,
      _ => Icons.directions_car_rounded,
    };

class VehicleGlyph extends StatelessWidget {
  const VehicleGlyph(this.code, {super.key, this.size = 44, this.selected = false, this.plain = false});
  final String code;
  final double size;
  final bool selected;
  /// no background circle
  final bool plain;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final icon = Icon(vehicleIcon(code), size: size * 0.55, color: selected ? c.accentStrong : c.text2);
    if (plain) return icon;
    return AnimatedContainer(
      duration: AnbessaMotion.of(context, AnbessaMotion.base),
      width: size,
      height: size,
      decoration: BoxDecoration(color: selected ? c.accentSoft : c.surface2, borderRadius: BorderRadius.circular(AnbessaRadius.md)),
      child: icon,
    );
  }
}
