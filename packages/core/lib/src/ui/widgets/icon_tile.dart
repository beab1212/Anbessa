// Shortcut tiles: Home, Work, add a place. Words only (the [icon] isn't drawn).

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
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          decoration: BoxDecoration(
            color: c.surface,
            borderRadius: BorderRadius.circular(AnbessaRadius.md),
            border: Border.all(color: selected ? c.text : c.border, width: selected ? 2 : 1.5),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(dashed ? '+ $label' : label, style: AnbessaType.body.copyWith(fontWeight: FontWeight.w700, color: dashed ? c.text2 : c.text), maxLines: 1, overflow: TextOverflow.ellipsis),
              if (sublabel != null) Text(sublabel!, style: AnbessaType.caption.copyWith(color: c.muted), maxLines: 1, overflow: TextOverflow.ellipsis),
            ],
          ),
        ),
      ),
    );
  }
}
