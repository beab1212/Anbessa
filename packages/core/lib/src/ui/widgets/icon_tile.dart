// Square shortcut tiles: Home, Work, add a place.

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';

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
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 12),
          decoration: BoxDecoration(
            color: selected ? c.accentSoft : c.surface2,
            borderRadius: BorderRadius.circular(AnbessaRadius.lg),
            border: Border.all(color: selected ? c.accent : (dashed ? c.borderStrong : c.border), style: BorderStyle.solid),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 32,
                height: 32,
                decoration: BoxDecoration(color: dashed ? Colors.transparent : c.surface, shape: BoxShape.circle, border: dashed ? Border.all(color: c.borderStrong) : null),
                child: Icon(icon, size: 18, color: dashed ? c.muted : c.accentStrong),
              ),
              const SizedBox(height: 8),
              Text(label, style: AnbessaType.body2.copyWith(fontWeight: FontWeight.w600, color: c.text), maxLines: 1, overflow: TextOverflow.ellipsis),
              if (sublabel != null) Text(sublabel!, style: AnbessaType.caption.copyWith(color: c.muted), maxLines: 1, overflow: TextOverflow.ellipsis),
            ],
          ),
        ),
      ),
    );
  }
}
