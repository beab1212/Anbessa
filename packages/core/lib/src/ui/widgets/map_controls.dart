// Round buttons that sit over the map: recenter, compass, layers, navigate.

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';
import 'basics.dart';

/// A rounded square button over the map (recenter, compass, layers).
class MapControlButton extends StatelessWidget {
  const MapControlButton({super.key, this.icon, required this.onTap, required this.tooltip, this.active = false, this.size = 44, this.child}) : assert(icon != null || child != null);
  final IconData? icon;
  final VoidCallback? onTap;
  final String tooltip;
  final bool active;
  final double size;

  /// replaces the icon (a rotated compass needle)
  final Widget? child;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    // a rounded square with a soft shadow: lifts off any map style
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(AnbessaRadius.md),
      side: c.isDark ? BorderSide(color: active ? c.text : c.border) : BorderSide.none,
    );
    return Tooltip(
      message: tooltip,
      child: DecoratedBox(
        decoration: BoxDecoration(borderRadius: BorderRadius.circular(AnbessaRadius.md), boxShadow: AnbessaElevation.floating(c.brightness)),
        child: Material(
          color: active ? c.text : c.surface,
          shape: shape,
          child: InkWell(
            onTap: onTap,
            customBorder: shape,
            child: SizedBox(
              width: size,
              height: size,
              child: Semantics(
                button: true,
                label: tooltip,
                child: Center(child: child ?? Icon(icon, size: 20, color: active ? c.surface : c.text)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A column of [MapControlButton]s with an even gap.
class MapControlColumn extends StatelessWidget {
  const MapControlColumn({super.key, required this.children, this.gap = 10});
  final List<Widget> children;
  final double gap;
  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      for (final (i, w) in children.indexed) ...[if (i > 0) SizedBox(height: gap), w],
    ],
  );
}

/// A chip over the map with an icon and text ("3 cars nearby · ~4 min", "GPS weak"): a soft
/// shadow, the [icon] in the [tone] colour; with no icon a tone shows as a dot (pulsing when
/// [pulse]).
class MapChip extends StatelessWidget {
  const MapChip({super.key, required this.label, this.icon, this.tone, this.onTap, this.pulse = false});
  final String label;
  final IconData? icon;
  final Color? tone;
  final VoidCallback? onTap;
  final bool pulse;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(AnbessaRadius.pill),
      side: c.isDark ? BorderSide(color: c.border) : BorderSide.none,
    );
    return DecoratedBox(
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(AnbessaRadius.pill), boxShadow: AnbessaElevation.floating(c.brightness)),
      child: Material(
        color: c.surface,
        shape: shape,
        child: InkWell(
          onTap: onTap,
          customBorder: shape,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (tone != null && (pulse || icon == null)) ...[
                  if (pulse)
                    PulsingDot(color: tone!, size: 8)
                  else
                    Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(color: tone, shape: BoxShape.circle),
                    ),
                  const SizedBox(width: 7),
                ] else if (icon != null) ...[
                  Icon(icon, size: 16, color: tone ?? c.text2),
                  const SizedBox(width: 6),
                ],
                Flexible(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AnbessaType.label.copyWith(color: c.text, fontWeight: FontWeight.w700),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
