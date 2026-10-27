// "4 min" in a pill, on vehicle cards and above the car on the map.

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';
import 'animated_counter.dart';

class EtaBadge extends StatelessWidget {
  const EtaBadge({super.key, required this.seconds, required this.minuteLabel, this.approximate = false, this.onDark = false, this.large = false, this.icon});
  /// null = unknown ("—")
  final int? seconds;
  /// e.g. (m) => "$m min" from the app's localisation
  final String Function(int minutes) minuteLabel;
  final bool approximate;
  /// the badge sits on the map (solid surface + shadow)
  final bool onDark;
  final bool large;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final style = (large ? AnbessaType.title : AnbessaType.label).copyWith(color: c.text, fontFeatures: AnbessaType.tabular);
    final mins = seconds == null ? null : (seconds! / 60).ceil().clamp(1, 999);
    return Container(
      padding: EdgeInsets.symmetric(horizontal: large ? 12 : 8, vertical: large ? 6 : 3),
      decoration: BoxDecoration(
        color: onDark ? c.surface : c.surface2,
        borderRadius: BorderRadius.circular(AnbessaRadius.pill),
        border: onDark ? null : Border.all(color: c.border),
        boxShadow: onDark ? AnbessaElevation.card(c.brightness) : null,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[Icon(icon, size: large ? 16 : 13, color: c.accentStrong), const SizedBox(width: 4)],
          if (mins == null)
            Text('—', style: style)
          else
            AnimatedCounter(value: mins, format: (v) => '${approximate ? '~' : ''}${minuteLabel(v.round())}', style: style),
        ],
      ),
    );
  }
}
