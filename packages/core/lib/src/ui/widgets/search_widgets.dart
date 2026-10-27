// Searching for a place: the big "Where to?" bar on the home sheet and the rows of suggestions.

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';

/// The big rounded "Where to?" bar: a search icon, the hint, and an optional trailing chip ("Now ▾")
/// with its own tap. Give it a [heroTag] to fly into the search screen's field.
class SearchBarButton extends StatelessWidget {
  const SearchBarButton({super.key, required this.hint, this.onTap, this.trailingLabel, this.trailingIcon = Icons.schedule_rounded, this.onTrailingTap, this.heroTag, this.elevated = true});
  final String hint;
  final VoidCallback? onTap;
  /// the chip on the right ("Now"); no chip when null
  final String? trailingLabel;
  final IconData? trailingIcon;
  final VoidCallback? onTrailingTap;
  /// wraps the bar in a [Hero] with this tag
  final Object? heroTag;
  /// a soft shadow (over the map); flat with a border when false
  final bool elevated;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final radius = BorderRadius.circular(AnbessaRadius.lg);
    Widget bar = Container(
      decoration: BoxDecoration(
        color: elevated ? c.surface : c.surface2,
        borderRadius: radius,
        border: elevated && !c.isDark ? null : Border.all(color: c.border, width: 1.5),
        boxShadow: elevated ? AnbessaElevation.floating(c.brightness) : null,
      ),
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          onTap: onTap,
          borderRadius: radius,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 58),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
              child: Row(
                children: [
                  Icon(Icons.search_rounded, size: 24, color: c.text),
                  const SizedBox(width: 12),
                  Expanded(child: Text(hint, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.title.copyWith(color: c.text, fontWeight: FontWeight.w700))),
                  if (trailingLabel != null) ...[
                    const SizedBox(width: 8),
                    Semantics(
                      button: true,
                      label: trailingLabel,
                      excludeSemantics: true,
                      child: Material(
                        color: c.isDark ? c.surface2 : c.canvas,
                        shape: const StadiumBorder(),
                        child: InkWell(
                          onTap: onTrailingTap ?? onTap,
                          customBorder: const StadiumBorder(),
                          child: Padding(
                            padding: const EdgeInsets.fromLTRB(10, 8, 6, 8),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                if (trailingIcon != null) ...[Icon(trailingIcon, size: 16, color: c.text), const SizedBox(width: 4)],
                                Text(trailingLabel!, style: AnbessaType.label.copyWith(color: c.text, fontSize: 13)),
                                Icon(Icons.arrow_drop_down_rounded, size: 20, color: c.text),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
    if (heroTag != null) bar = Hero(tag: heroTag!, child: Material(type: MaterialType.transparency, child: bar));
    return bar;
  }
}

/// A place suggestion: a 40 px icon circle, the name and address, the distance on the right.
class SuggestionRow extends StatelessWidget {
  const SuggestionRow({super.key, required this.title, this.subtitle, this.icon = Icons.place_rounded, this.distance, this.onTap, this.onLongPress, this.trailing, this.highlight = false});
  final String title;
  final String? subtitle;
  final IconData icon;
  /// e.g. "2.4 km"
  final String? distance;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  /// after the distance (a save star, a remove button)
  final Widget? trailing;
  /// amber icon circle (a saved place, the current location)
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return InkWell(
      onTap: onTap,
      onLongPress: onLongPress,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(
          children: [
            ExcludeSemantics(
              child: Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(color: highlight ? c.accentSoft : (c.isDark ? c.surface2 : c.canvas), shape: BoxShape.circle),
                child: Icon(icon, size: 20, color: highlight && c.isDark ? c.accent : c.text2),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.body.copyWith(fontWeight: FontWeight.w600, color: c.text)),
                  if (subtitle != null) Text(subtitle!, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.caption.copyWith(color: c.muted)),
                ],
              ),
            ),
            if (distance != null) ...[const SizedBox(width: 8), Text(distance!, style: AnbessaType.caption.copyWith(color: c.muted, fontFeatures: AnbessaType.tabular))],
            if (trailing != null) ...[const SizedBox(width: 4), trailing!],
          ],
        ),
      ),
    );
  }
}
