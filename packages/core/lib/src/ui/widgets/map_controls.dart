// Round buttons that sit over the map: recenter, compass, layers, navigate.

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';

class MapControlButton extends StatelessWidget {
  const MapControlButton({super.key, required this.icon, required this.onTap, required this.tooltip, this.active = false, this.size = 44, this.child});
  final IconData icon;
  final VoidCallback? onTap;
  final String tooltip;
  final bool active;
  final double size;
  /// replaces the icon (a rotated compass needle)
  final Widget? child;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Tooltip(
      message: tooltip,
      child: Material(
        color: active ? c.primaryFill : c.surface,
        shape: const CircleBorder(),
        elevation: 0,
        shadowColor: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          customBorder: const CircleBorder(),
          child: Container(
            width: size,
            height: size,
            decoration: BoxDecoration(shape: BoxShape.circle, boxShadow: AnbessaElevation.card(c.brightness)),
            child: Semantics(button: true, label: tooltip, child: child ?? Icon(icon, size: 22, color: active ? c.onAccent : c.text)),
          ),
        ),
      ),
    );
  }
}

class MapControlColumn extends StatelessWidget {
  const MapControlColumn({super.key, required this.children, this.gap = 10});
  final List<Widget> children;
  final double gap;
  @override
  Widget build(BuildContext context) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final (i, w) in children.indexed) ...[
            if (i > 0) SizedBox(height: gap),
            w,
          ],
        ],
      );
}

/// A chip over the map with an icon and text ("3 cars nearby · ~4 min", "GPS weak").
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
    final fg = tone ?? c.text;
    return Material(
      color: c.surface,
      borderRadius: BorderRadius.circular(AnbessaRadius.pill),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AnbessaRadius.pill),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(AnbessaRadius.pill), boxShadow: AnbessaElevation.card(c.brightness)),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[Icon(icon, size: 16, color: fg), const SizedBox(width: 6)],
              Flexible(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.label.copyWith(color: fg))),
            ],
          ),
        ),
      ),
    );
  }
}
