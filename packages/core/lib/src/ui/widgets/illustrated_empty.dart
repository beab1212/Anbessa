// Empty and error states with a small illustration. The SVGs are two-tone and take the theme's
// accent and muted colours through currentColor-style substitution.

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';

enum AnbessaIllustration { noTrips, noConnection, searchEmpty, carWaiting, documents, celebrate, locationOff, wallet }

extension on AnbessaIllustration {
  String get file => switch (this) {
        AnbessaIllustration.noTrips => 'no_trips',
        AnbessaIllustration.noConnection => 'no_connection',
        AnbessaIllustration.searchEmpty => 'search_empty',
        AnbessaIllustration.carWaiting => 'car_waiting',
        AnbessaIllustration.documents => 'documents',
        AnbessaIllustration.celebrate => 'celebrate',
        AnbessaIllustration.locationOff => 'location_off',
        AnbessaIllustration.wallet => 'wallet',
      };
}

class Illustration extends StatelessWidget {
  const Illustration(this.kind, {super.key, this.size = 140});
  final AnbessaIllustration kind;
  final double size;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    // the SVGs use #D97706 (accent), #94A3B8 (muted) and #E4E7EC (soft); recolour per theme
    return SvgPicture.asset(
      'assets/illustrations/${kind.file}.svg',
      package: 'ride_app_core',
      width: size,
      height: size,
      colorMapper: _ThemeColors(c),
    );
  }
}

class _ThemeColors extends ColorMapper {
  const _ThemeColors(this.c);
  final AnbessaColors c;
  @override
  Color substitute(String? id, String elementName, String attributeName, Color color) {
    final v = color.toARGB32() & 0xFFFFFF;
    return switch (v) {
      0xD97706 => c.accent,
      0x94A3B8 => c.muted,
      0xE4E7EC => c.isDark ? c.surface2 : c.border,
      0xFFFFFF => c.surface,
      0x0F172A => c.text,
      _ => color,
    };
  }
}

/// An empty or finished state: a heading, a line and an action. The [illustration] is kept for
/// older call sites but no longer drawn (the design is text-first, no pictures).
class IllustratedEmpty extends StatelessWidget {
  const IllustratedEmpty({super.key, required this.illustration, required this.title, this.body, this.action, this.compact = false});
  final AnbessaIllustration illustration;
  final String title;
  final String? body;
  final Widget? action;
  final bool compact;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Center(
      child: Padding(
        padding: EdgeInsets.all(compact ? 16 : 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(title, textAlign: TextAlign.center, style: (compact ? AnbessaType.title : AnbessaType.h2).copyWith(color: c.text)),
            if (body != null) ...[const SizedBox(height: 8), Text(body!, textAlign: TextAlign.center, style: AnbessaType.body.copyWith(color: c.text2))],
            if (action != null) ...[const SizedBox(height: 20), action!],
          ],
        ),
      ),
    );
  }
}
