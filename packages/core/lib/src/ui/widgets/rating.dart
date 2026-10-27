// Stars to give and to show, and the tag chips that go with a rating.

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';
import 'feedback.dart';

class RatingStars extends StatelessWidget {
  const RatingStars({super.key, required this.value, this.onChanged, this.size = 40, this.gap = 6});
  final int value;
  final ValueChanged<int>? onChanged;
  final double size;
  final double gap;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Semantics(
      value: '$value',
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 1; i <= 5; i++) ...[
            if (i > 1) SizedBox(width: gap),
            GestureDetector(
              onTap: onChanged == null
                  ? null
                  : () {
                      Haptics.light();
                      onChanged!(i);
                    },
              child: AnimatedScale(
                scale: i == value && onChanged != null ? 1.18 : 1,
                duration: AnbessaMotion.of(context, AnbessaMotion.base),
                curve: AnbessaMotion.spring,
                child: Icon(i <= value ? Icons.star_rounded : Icons.star_outline_rounded, size: size, color: i <= value ? c.accent : c.borderStrong),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// "4.9 · 128" with a star.
class RatingSummary extends StatelessWidget {
  const RatingSummary({super.key, required this.average, required this.count, this.style, this.newLabel});
  final double? average;
  final int count;
  final TextStyle? style;
  /// shown when there's no average yet ("New")
  final String? newLabel;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final s = (style ?? AnbessaType.body2).copyWith(fontFeatures: AnbessaType.tabular);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.star_rounded, size: (s.fontSize ?? 14) + 4, color: c.accent),
        const SizedBox(width: 3),
        Flexible(
          child: average == null
              ? Text(newLabel ?? '—', style: s.copyWith(color: c.muted), maxLines: 1, overflow: TextOverflow.ellipsis)
              : Text.rich(
                  TextSpan(children: [
                    TextSpan(text: average!.toStringAsFixed(1), style: s.copyWith(fontWeight: FontWeight.w600)),
                    if (count > 0) TextSpan(text: ' · $count', style: s.copyWith(color: c.muted)),
                  ]),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
        ),
      ],
    );
  }
}

class TagChips extends StatelessWidget {
  const TagChips({super.key, required this.tags, required this.selected, required this.onToggle, required this.label});
  final List<String> tags;
  final Set<String> selected;
  final ValueChanged<String> onToggle;
  final String Function(String tag) label;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final t in tags)
          FilterChip(
            label: Text(label(t)),
            selected: selected.contains(t),
            onSelected: (_) {
              Haptics.selection();
              onToggle(t);
            },
            selectedColor: c.accentSoft,
            checkmarkColor: c.accentStrong,
            side: BorderSide(color: selected.contains(t) ? c.accent : c.border),
          ),
      ],
    );
  }
}
