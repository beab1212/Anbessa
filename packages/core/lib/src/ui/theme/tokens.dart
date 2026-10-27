// Design tokens: spacing, radii, motion and type. Screens use these instead of magic numbers so
// the whole app moves and breathes the same way.

import 'package:flutter/material.dart';

abstract final class AnbessaSpace {
  static const xs = 4.0;
  static const sm = 8.0;
  static const md = 12.0;
  static const lg = 16.0;
  static const xl = 20.0;
  static const xxl = 24.0;
  static const xxxl = 32.0;
}

abstract final class AnbessaRadius {
  static const sm = 8.0;
  static const md = 12.0;
  static const lg = 16.0;
  static const xl = 24.0;
  /// bottom sheets and the floating cards over the map
  static const sheet = 24.0;
  static const pill = 999.0;
}

abstract final class AnbessaMotion {
  static const fast = Duration(milliseconds: 120);
  static const base = Duration(milliseconds: 200);
  static const slow = Duration(milliseconds: 320);
  static const sheet = Duration(milliseconds: 380);
  static const camera = Duration(milliseconds: 500);
  static const emphasized = Curves.easeOutCubic;
  static const spring = Curves.easeOutBack;
  static const standard = Curves.easeInOutCubic;

  /// Zero when the person asked the system for less motion.
  static Duration of(BuildContext context, Duration d) => MediaQuery.disableAnimationsOf(context) ? Duration.zero : d;
}

/// Flat by design: hairline borders separate things; shadows only lift what floats over the map.
abstract final class AnbessaElevation {
  static List<BoxShadow> card(Brightness b) => const [];
  static List<BoxShadow> floating(Brightness b) => [
        BoxShadow(color: b == Brightness.dark ? const Color(0x59000000) : const Color(0x14000000), blurRadius: 16, offset: const Offset(0, 4)),
      ];
  static List<BoxShadow> sheet(Brightness b) => [
        BoxShadow(color: b == Brightness.dark ? const Color(0x66000000) : const Color(0x14000000), blurRadius: 20, offset: const Offset(0, -2)),
      ];
}

/// The type scale. Money and ids add tabular figures on top.
abstract final class AnbessaType {
  static const display = TextStyle(fontSize: 30, fontWeight: FontWeight.w800, height: 1.2, letterSpacing: -0.6);
  static const h1 = TextStyle(fontSize: 24, fontWeight: FontWeight.w700, height: 1.25, letterSpacing: -0.4);
  static const h2 = TextStyle(fontSize: 20, fontWeight: FontWeight.w700, height: 1.3, letterSpacing: -0.2);
  static const title = TextStyle(fontSize: 17, fontWeight: FontWeight.w600, height: 1.35);
  static const body = TextStyle(fontSize: 16, fontWeight: FontWeight.w400, height: 1.5);
  static const body2 = TextStyle(fontSize: 14, fontWeight: FontWeight.w400, height: 1.45);
  static const label = TextStyle(fontSize: 12, fontWeight: FontWeight.w600, height: 1.25);
  static const caption = TextStyle(fontSize: 12.5, fontWeight: FontWeight.w400, height: 1.4);
  static const tabular = [FontFeature.tabularFigures()];
}
