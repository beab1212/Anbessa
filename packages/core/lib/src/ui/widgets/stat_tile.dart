// Small stats in a row: today's earnings, trips, hours online.

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';
import 'basics.dart';

/// A small stat card: an icon (or a tone bar) and label, the value on one line, a sub line.
class StatTile extends StatelessWidget {
  const StatTile({super.key, required this.label, required this.value, this.icon, this.tone, this.sub});
  final String label;
  final Widget value;
  final IconData? icon;
  final Tone? tone;
  final String? sub;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (fg, _) = (tone ?? Tone.grey).colorsOf(c);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: c.surface, borderRadius: BorderRadius.circular(AnbessaRadius.md), border: Border.all(color: c.border)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          // the label, led by the icon in the tone colour (or a small tone bar with no icon)
          Row(
            children: [
              if (icon != null) ...[Icon(icon, size: 16, color: tone == null ? c.text2 : fg), const SizedBox(width: 6)]
              else if (tone != null) ...[Container(width: 3, height: 12, decoration: BoxDecoration(color: fg, borderRadius: BorderRadius.circular(2))), const SizedBox(width: 6)],
              Expanded(child: Text(label, style: AnbessaType.caption.copyWith(color: c.muted, fontWeight: FontWeight.w500), maxLines: 1, overflow: TextOverflow.ellipsis)),
            ],
          ),
          const SizedBox(height: 6),
          // one line, shrunk to fit: money must never break mid-number in a narrow tile
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: AlignmentDirectional.centerStart,
            child: DefaultTextStyle.merge(style: AnbessaType.h2.copyWith(color: c.text, fontFeatures: AnbessaType.tabular), maxLines: 1, softWrap: false, child: value),
          ),
          if (sub != null) Text(sub!, style: AnbessaType.caption.copyWith(color: c.muted)),
        ],
      ),
    );
  }
}

/// [StatTile]s side by side, equal widths.
class StatRow extends StatelessWidget {
  const StatRow({super.key, required this.children, this.gap = 8});
  final List<Widget> children;
  final double gap;
  @override
  Widget build(BuildContext context) => Row(
        children: [
          for (final (i, w) in children.indexed) ...[
            if (i > 0) SizedBox(width: gap),
            Expanded(child: w),
          ],
        ],
      );
}
