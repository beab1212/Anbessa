// Cards and rows from the GoRide kit: the plain card, the circle-outlined icon, list rows,
// selectable cards (payment methods, promos), key–value cards (ride / fare details) and the
// three-stat card (rating · rides · years; duration · distance · speed).

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';
import 'feedback.dart';

/// A card: white with a hairline on light pages, lifted grey on dark ones; radius 12.
class AppCard extends StatelessWidget {
  const AppCard({super.key, required this.child, this.padding = const EdgeInsets.all(16), this.onTap, this.color, this.radius = AnbessaRadius.md, this.border = true});
  final Widget child;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onTap;
  final Color? color;
  final double radius;
  final bool border;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final r = BorderRadius.circular(radius);
    return Material(
      color: color ?? c.cardFill,
      shape: RoundedRectangleBorder(borderRadius: r, side: border ? BorderSide(color: c.cardBorder) : BorderSide.none),
      clipBehavior: Clip.antiAlias,
      child: onTap == null ? Padding(padding: padding, child: child) : InkWell(onTap: onTap, child: Padding(padding: padding, child: child)),
    );
  }
}

/// An icon in a hairline circle (list rows, stats, the "+" of a top-up row).
class CircleIcon extends StatelessWidget {
  const CircleIcon(this.icon, {super.key, this.size = AnbessaSize.rowIcon, this.color, this.borderColor, this.fill});
  final IconData icon;
  final double size;
  /// the glyph colour (ink by default)
  final Color? color;
  final Color? borderColor;
  final Color? fill;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ExcludeSemantics(
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(shape: BoxShape.circle, color: fill, border: Border.all(color: borderColor ?? c.border, width: 1.5)),
        child: Icon(icon, size: size * 0.46, color: color ?? c.text),
      ),
    );
  }
}

/// A list row: a circle-outlined icon (or any [leading]), a bold title, a grey subtitle, and on
/// the right a value ("0.4 km", "$10.00" over "GoRide Wallet") and/or a trailing widget (a
/// bookmark, a chevron). A hairline under it when [divider].
class ListRowTile extends StatelessWidget {
  const ListRowTile({
    super.key,
    required this.title,
    this.subtitle,
    this.icon,
    this.leading,
    this.value,
    this.valueSub,
    this.valueSubColor,
    this.trailing,
    this.chevron = false,
    this.onTap,
    this.onLongPress,
    this.divider = false,
    this.padding = const EdgeInsets.symmetric(vertical: 12),
    this.titleColor,
  });
  final String title;
  final String? subtitle;
  final IconData? icon;
  /// instead of the circle icon (an avatar, a brand logo)
  final Widget? leading;
  /// bold text on the right
  final String? value;
  /// small grey text under [value] ("GoRide Wallet", "Canceled & Refunded")
  final String? valueSub;
  final Color? valueSubColor;
  final Widget? trailing;
  /// a › after everything
  final bool chevron;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final bool divider;
  final EdgeInsets padding;
  /// red for "Logout" / "Delete Account"
  final Color? titleColor;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final lead = leading ?? (icon != null ? CircleIcon(icon!) : null);
    final row = Padding(
      padding: padding,
      child: Row(
        children: [
          if (lead != null) ...[lead, const SizedBox(width: 14)],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.title.copyWith(color: titleColor ?? c.text)),
                if (subtitle != null) ...[
                  const SizedBox(height: 4),
                  Text(subtitle!, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.caption.copyWith(color: c.muted)),
                ],
              ],
            ),
          ),
          if (value != null || valueSub != null) ...[
            const SizedBox(width: 10),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 140),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (value != null) Text(value!, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.title.copyWith(color: c.text, fontFeatures: AnbessaType.tabular)),
                  if (valueSub != null) ...[
                    const SizedBox(height: 4),
                    Text(valueSub!, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.caption.copyWith(fontSize: 12, color: valueSubColor ?? c.muted)),
                  ],
                ],
              ),
            ),
          ],
          if (trailing != null) ...[const SizedBox(width: 10), trailing!],
          if (chevron) ...[const SizedBox(width: 6), ExcludeSemantics(child: Icon(Icons.chevron_right_rounded, size: 24, color: c.text))],
        ],
      ),
    );
    final body = divider ? DecoratedBox(decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.border))), child: row) : row;
    if (onTap == null && onLongPress == null) return body;
    return Material(type: MaterialType.transparency, child: InkWell(onTap: onTap, onLongPress: onLongPress, child: body));
  }
}

/// A card you pick from a list (payment method, promo, top-up method): tinted fill, amber
/// border and a check when [selected]; a plain card otherwise.
class SelectableCard extends StatelessWidget {
  const SelectableCard({super.key, required this.selected, required this.child, this.onTap, this.padding = const EdgeInsets.all(16), this.showCheck = true});
  final bool selected;
  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsetsGeometry padding;
  /// the ✓ at the end of the row
  final bool showCheck;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final d = AnbessaMotion.of(context, AnbessaMotion.short);
    final r = BorderRadius.circular(AnbessaRadius.md);
    return Semantics(
      selected: selected,
      button: onTap != null,
      inMutuallyExclusiveGroup: true,
      child: AnimatedContainer(
        duration: d,
        curve: AnbessaMotion.emphasized,
        decoration: BoxDecoration(
          color: selected ? Color.alphaBlend(c.selectedFill, c.cardFill) : c.cardFill,
          borderRadius: r,
          border: Border.all(color: selected ? c.accent : c.cardBorder, width: 1.5),
        ),
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            borderRadius: r,
            onTap: onTap == null
                ? null
                : () {
                    Haptics.selection();
                    onTap!();
                  },
            child: Padding(
              padding: padding,
              child: Row(
                children: [
                  Expanded(child: child),
                  if (showCheck)
                    AnimatedSwitcher(
                      duration: d,
                      transitionBuilder: (w, a) => ScaleTransition(scale: a, child: w),
                      child: selected
                          ? Padding(padding: const EdgeInsetsDirectional.only(start: 8), child: Icon(Icons.check_rounded, key: const ValueKey(true), size: 24, color: c.accentText))
                          : const SizedBox(key: ValueKey(false), width: 0),
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

/// A key–value pair for [KeyValueCard].
typedef KeyValueRow = ({String label, String value, Color? valueColor});

/// Rows of "label ……… value" in a card ("Ride / GoRide Car", "Trip Fare / $12.50"); an optional
/// [total] row under a hairline, in bolder ink; optional widgets after a row's value via
/// [trailing] (a "Completed" badge, a copy icon).
class KeyValueCard extends StatelessWidget {
  const KeyValueCard({super.key, required this.rows, this.total, this.trailing = const {}, this.padding = const EdgeInsets.symmetric(horizontal: 16, vertical: 6)});
  final List<KeyValueRow> rows;
  final KeyValueRow? total;
  /// widgets after a row's value, by row index
  final Map<int, Widget> trailing;
  final EdgeInsetsGeometry padding;

  /// Shorthand for a row.
  static KeyValueRow row(String label, String value, {Color? valueColor}) => (label: label, value: value, valueColor: valueColor);

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget line(KeyValueRow r, {bool bold = false, Widget? after}) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: LayoutBuilder(
            builder: (context, box) => Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: Text(r.label, style: AnbessaType.body.copyWith(color: bold ? c.text : c.text2, fontWeight: bold ? FontWeight.w600 : FontWeight.w500))),
                const SizedBox(width: 12),
                ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: box.maxWidth * 0.6),
                  child: Text(
                    r.value,
                    textAlign: TextAlign.end,
                    style: AnbessaType.body.copyWith(color: r.valueColor ?? c.text, fontWeight: bold ? FontWeight.w700 : FontWeight.w600, fontFeatures: AnbessaType.tabular),
                  ),
                ),
                if (after != null) ...[const SizedBox(width: 6), after],
              ],
            ),
          ),
        );
    return AppCard(
      padding: padding,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (i, r) in rows.indexed) line(r, after: trailing[i]),
          if (total != null) ...[Divider(height: 9, color: c.border), line(total!, bold: true)],
        ],
      ),
    );
  }
}

/// One stat for [StatTriple].
typedef StatItem = ({IconData icon, String value, String caption});

/// Three (or more) stats side by side in a card: a circle-outlined icon, the value, a caption.
class StatTriple extends StatelessWidget {
  const StatTriple({super.key, required this.items});
  final List<StatItem> items;

  static StatItem item(IconData icon, String value, String caption) => (icon: icon, value: value, caption: caption);

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return AppCard(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final s in items)
            Expanded(
              child: Semantics(
                label: '${s.value} ${s.caption}',
                excludeSemantics: true,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    CircleIcon(s.icon, size: 48),
                    const SizedBox(height: 12),
                    FittedBox(fit: BoxFit.scaleDown, child: Text(s.value, maxLines: 1, style: AnbessaType.title.copyWith(fontSize: 17, color: c.text, fontFeatures: AnbessaType.tabular))),
                    const SizedBox(height: 4),
                    Text(s.caption, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center, style: AnbessaType.caption.copyWith(fontSize: 12, color: c.muted)),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// The small rounded outline badge ("Completed", a promo code) in amber text, or red with [danger].
class OutlineBadge extends StatelessWidget {
  const OutlineBadge(this.text, {super.key, this.danger = false});
  final String text;
  final bool danger;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final fg = danger ? c.danger : c.accentText;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(6), border: Border.all(color: danger ? c.danger : c.accent)),
      child: Text(text, maxLines: 1, style: AnbessaType.label.copyWith(fontSize: 11, color: fg, fontWeight: FontWeight.w600)),
    );
  }
}
