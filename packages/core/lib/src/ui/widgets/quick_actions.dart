// Home-screen shortcuts: round quick actions (Trips, Support, Places, Settings) and service tiles
// (Ride, Book ahead, Delivery).

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';
import 'basics.dart';

/// A round 56 px tinted icon with its label below; ripples on tap. For the row of shortcuts on
/// the home sheet (Trips, Support, Places, Settings).
class QuickActionCircle extends StatelessWidget {
  const QuickActionCircle({super.key, required this.icon, required this.label, this.onTap, this.tone, this.badge, this.width = 76});
  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  /// tints the circle; amber-soft with an ink icon when null
  final Tone? tone;
  /// a small count on the circle ("2")
  final String? badge;
  final double width;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (fg, bg) = tone == null ? (c.isDark ? c.accent : c.text, c.accentSoft) : tone!.colorsOf(c);
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: SizedBox(
        width: width,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(AnbessaRadius.md),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Badge(
                  isLabelVisible: badge != null,
                  label: badge == null ? null : Text(badge!),
                  child: Container(width: 56, height: 56, decoration: BoxDecoration(color: bg, shape: BoxShape.circle), child: Icon(icon, size: 26, color: fg)),
                ),
                const SizedBox(height: 6),
                Text(label, textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis, style: AnbessaType.label.copyWith(color: c.text, fontWeight: FontWeight.w600)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A rounded service card (~104×88): an icon or a picture ([art]) over a label, with a selected
/// state (amber ring and tint). For "Ride", "Book ahead", "Delivery".
class ServiceTile extends StatelessWidget {
  const ServiceTile({super.key, required this.label, this.icon, this.art, this.selected = false, this.onTap, this.badge, this.width = 104, this.height = 88})
      : assert(icon != null || art != null);
  final String label;
  final IconData? icon;
  /// replaces the icon (e.g. a `VehicleArt`)
  final Widget? art;
  final bool selected;
  final VoidCallback? onTap;
  /// a short label in the corner ("New")
  final String? badge;
  final double width;
  final double height;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final radius = BorderRadius.circular(AnbessaRadius.lg);
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      excludeSemantics: true,
      child: AnimatedContainer(
        duration: AnbessaMotion.of(context, AnbessaMotion.short),
        curve: AnbessaMotion.emphasized,
        width: width,
        constraints: BoxConstraints(minHeight: height),
        decoration: BoxDecoration(
          color: selected ? c.accentSoft : c.surface,
          borderRadius: radius,
          border: Border.all(color: selected ? c.accent : c.border, width: selected ? 2 : 1.5),
        ),
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: onTap,
            borderRadius: radius,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      SizedBox(height: 36, child: art ?? Icon(icon, size: 30, color: c.isDark ? c.accent : c.text)),
                      const SizedBox(height: 8),
                      Text(label, maxLines: 2, overflow: TextOverflow.ellipsis, style: AnbessaType.body2.copyWith(fontWeight: FontWeight.w700, color: c.text, height: 1.2)),
                    ],
                  ),
                  if (badge != null)
                    Positioned(
                      top: -2,
                      right: -4,
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(color: c.accent, borderRadius: BorderRadius.circular(AnbessaRadius.pill)),
                        child: Text(badge!, style: AnbessaType.label.copyWith(fontSize: 10.5, color: c.onAmber)),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
