// Shortcut tiles: Home, Work, add a place. The icon sits before the label so the tile keeps its
// height in a 96 px strip.

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';

/// A square-ish shortcut tile (Home, Work, add a place): icon + label, a muted sublabel.
class IconTile extends StatelessWidget {
  const IconTile({super.key, required this.icon, required this.label, this.sublabel, this.onTap, this.onLongPress, this.selected = false, this.dashed = false, this.width = 96});
  final IconData icon;
  final String label;
  final String? sublabel;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final bool selected;
  /// an "add" tile
  final bool dashed;
  final double width;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Semantics(
      button: true,
      label: sublabel == null ? label : '$label, $sublabel',
      child: InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
        borderRadius: BorderRadius.circular(AnbessaRadius.lg),
        child: AnimatedContainer(
          duration: AnbessaMotion.of(context, AnbessaMotion.base),
          width: width,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          decoration: BoxDecoration(
            color: c.surface,
            borderRadius: BorderRadius.circular(AnbessaRadius.md),
            border: Border.all(color: selected ? c.accent : c.border, width: selected ? 2 : 1.5),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  ExcludeSemantics(
                    child: Container(
                      width: 26,
                      height: 26,
                      decoration: BoxDecoration(color: dashed ? c.surface2 : c.accentSoft, borderRadius: BorderRadius.circular(8)),
                      child: Icon(icon, size: 16, color: dashed ? c.text2 : (c.isDark ? c.accent : c.text)),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(child: Text(label, style: AnbessaType.body2.copyWith(fontWeight: FontWeight.w700, color: dashed ? c.text2 : c.text), maxLines: 1, overflow: TextOverflow.ellipsis)),
                ],
              ),
              const SizedBox(height: 4),
              if (sublabel != null) Text(sublabel!, style: AnbessaType.caption.copyWith(color: c.muted), maxLines: 1, overflow: TextOverflow.ellipsis),
            ],
          ),
        ),
      ),
    );
  }
}
