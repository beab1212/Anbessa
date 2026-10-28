// Segmented tabs and outlined chips from the GoRide kit.
//   SegmentedTabs: a grey track split into equal parts, the selected part filled amber
//   ("Recent | Suggested", "Today | Tomorrow | Select Date").
//   OutlineChip / ChipRow: outlined pills in a scrolling row ("Home", "Office"), the selected one
//   amber-filled (Activity filters, tip amounts).

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';
import 'feedback.dart';
import 'pill_button.dart';

class SegmentedTabs<T> extends StatelessWidget {
  const SegmentedTabs({super.key, required this.items, required this.selected, required this.onChanged, this.height = AnbessaSize.segmented});
  final List<(T value, String label)> items;
  final T selected;
  final ValueChanged<T> onChanged;
  final double height;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final d = AnbessaMotion.of(context, AnbessaMotion.base);
    final radius = BorderRadius.circular(AnbessaRadius.sm);
    return ConstrainedBox(
      constraints: BoxConstraints(minHeight: height),
      child: DecoratedBox(
        decoration: BoxDecoration(color: c.field, borderRadius: radius),
        child: Row(
          children: [
            for (final (value, label) in items)
              Expanded(
                child: Semantics(
                  selected: value == selected,
                  button: true,
                  inMutuallyExclusiveGroup: true,
                  child: Material(
                    type: MaterialType.transparency,
                    child: InkWell(
                      borderRadius: radius,
                      onTap: () {
                        if (value != selected) {
                          Haptics.selection();
                          onChanged(value);
                        }
                      },
                      child: AnimatedContainer(
                        duration: d,
                        curve: AnbessaMotion.emphasized,
                        constraints: BoxConstraints(minHeight: height),
                        alignment: Alignment.center,
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                        decoration: BoxDecoration(color: value == selected ? c.primaryFill : Colors.transparent, borderRadius: radius),
                        child: AnimatedDefaultTextStyle(
                          duration: d,
                          style: AnbessaType.body.copyWith(
                            color: value == selected ? c.onAccent : c.text,
                            fontWeight: value == selected ? FontWeight.w700 : FontWeight.w600,
                            fontFamily: DefaultTextStyle.of(context).style.fontFamily,
                            fontFamilyFallback: DefaultTextStyle.of(context).style.fontFamilyFallback,
                          ),
                          child: Text(label, textAlign: TextAlign.center, maxLines: 1, overflow: TextOverflow.ellipsis),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// An outlined pill with an optional leading icon; amber-filled when [selected].
class OutlineChip extends StatelessWidget {
  const OutlineChip({super.key, required this.label, this.icon, this.selected = false, this.onTap, this.iconColor});
  final String label;
  final IconData? icon;
  final bool selected;
  final VoidCallback? onTap;
  /// the icon's colour when not selected (defaults to amber text, like the kit's map glyph)
  final Color? iconColor;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final d = AnbessaMotion.of(context, AnbessaMotion.short);
    final fg = selected ? c.onAccent : c.text;
    return Semantics(
      button: onTap != null,
      selected: selected,
      child: PressScale(
        enabled: onTap != null,
        child: AnimatedContainer(
          duration: d,
          curve: AnbessaMotion.emphasized,
          constraints: const BoxConstraints(minHeight: AnbessaSize.chip),
          decoration: ShapeDecoration(
            color: selected ? c.primaryFill : Colors.transparent,
            shape: StadiumBorder(side: BorderSide(color: selected ? c.primaryFill : c.border, width: 1.5)),
          ),
          child: Material(
            type: MaterialType.transparency,
            shape: const StadiumBorder(),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: onTap == null
                  ? null
                  : () {
                      Haptics.selection();
                      onTap!();
                    },
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (icon != null) ...[ExcludeSemantics(child: Icon(icon, size: 18, color: selected ? fg : (iconColor ?? c.accentText))), const SizedBox(width: 6)],
                    Flexible(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.body2.copyWith(color: fg, fontWeight: FontWeight.w600))),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A horizontally scrolling row of chips with the page gutter at both ends.
class ChipRow extends StatelessWidget {
  const ChipRow({super.key, required this.children, this.gap = 8, this.padding = const EdgeInsets.symmetric(horizontal: AnbessaSpace.page)});
  final List<Widget> children;
  final double gap;
  final EdgeInsets padding;
  @override
  Widget build(BuildContext context) => SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: padding,
        child: Row(
          children: [
            for (final (i, w) in children.indexed) ...[if (i > 0) SizedBox(width: gap), w],
          ],
        ),
      );
}
