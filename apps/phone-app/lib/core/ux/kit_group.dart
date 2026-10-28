// Small GoRide-style building blocks the app's lists share (the kit has no single widget for
// them): a titled card of rows, and the row icon in an outlined circle.

import 'package:flutter/material.dart';
import 'package:ride_app_core/ride_app_core.dart';

/// A titled card of rows (the kit's grouped lists: a bold title, then one hairline card with
/// hairlines between the rows).
class KitGroup extends StatelessWidget {
  const KitGroup({super.key, this.title, this.trailing, required this.children});
  final String? title;
  /// on the right of the title (a count, a status)
  final Widget? trailing;
  final List<Widget> children;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (title != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Row(children: [Expanded(flex: 2, child: Text(title!, style: AnbessaType.title.copyWith(color: c.text))), if (trailing != null) Flexible(flex: 3, child: FittedBox(fit: BoxFit.scaleDown, alignment: AlignmentDirectional.centerEnd, child: trailing))]),
          ),
        AppCard(
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: Column(
            children: [
              for (final (i, w) in children.indexed) i < children.length - 1 ? DecoratedBox(decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.border))), child: w) : w,
            ],
          ),
        ),
      ],
    );
  }
}

/// The kit's row icon: an outlined circle with the icon in amber text colour (or [color]),
/// hidden from screen readers (the row's words say it).
class KitRowIcon extends StatelessWidget {
  const KitRowIcon(this.icon, {super.key, this.color});
  final IconData icon;
  final Color? color;
  @override
  Widget build(BuildContext context) => ExcludeSemantics(child: CircleIcon(icon, color: color ?? context.colors.accentText));
}

/// The text colour of a status [tone] for a list row's small right-hand line (the kit's red
/// "Canceled & Refunded" under the price).
Color kitToneText(BuildContext context, Tone tone) => tone == Tone.amber ? context.colors.accentText : tone.colorsOf(context.colors).$1;
