// Design tokens: spacing, radii, motion, elevation and type. Screens use these instead of magic numbers so
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
  /// chips, badges, small boxes
  static const sm = 10.0;
  /// buttons, inputs, list cards
  static const md = 16.0;
  /// cards, tiles, the search bar
  static const lg = 20.0;
  /// dialogs
  static const xl = 24.0;
  /// bottom sheets and the floating cards over the map
  static const sheet = 28.0;
  static const pill = 999.0;
}

abstract final class AnbessaMotion {
  static const fast = Duration(milliseconds: 120);
  static const base = Duration(milliseconds: 200);
  /// small state changes (a selected card, a chip appearing)
  static const short = Duration(milliseconds: 250);
  static const slow = Duration(milliseconds: 320);
  static const sheet = Duration(milliseconds: 380);
  /// shared-axis steps, cards entering
  static const medium = Duration(milliseconds: 400);
  /// large moves (a screen-sized change)
  static const long = Duration(milliseconds: 500);
  static const camera = Duration(milliseconds: 500);

  /// Material 3 "emphasized": fast start, long gentle settle. The default for things that move.
  static const emphasized = Cubic(0.2, 0, 0, 1);
  /// entering: decelerates hard into place
  static const emphasizedDecelerate = Cubic(0.05, 0.7, 0.1, 1);
  /// leaving: accelerates out of view
  static const emphasizedAccelerate = Cubic(0.3, 0, 0.8, 0.15);
  /// a small overshoot (selection, pop-in)
  static const spring = Curves.easeOutBack;
  /// a softer overshoot for larger surfaces
  static const springSoft = Cubic(0.34, 1.36, 0.64, 1);
  static const standard = Curves.easeInOutCubic;

  /// A critically damped-ish spring for physics-driven motion (sheets, drags).
  static const springDescription = SpringDescription(mass: 1, stiffness: 420, damping: 34);

  /// Zero when the person asked the system for less motion.
  static Duration of(BuildContext context, Duration d) => MediaQuery.disableAnimationsOf(context) ? Duration.zero : d;

  /// True when the person asked the system for less motion.
  static bool reduced(BuildContext context) => MediaQuery.disableAnimationsOf(context);

  /// A shared-axis transition for an [AnimatedSwitcher]-style builder: the incoming child fades
  /// and slides in from [distance] px along [axis]; with [outgoing] it slides the other way as
  /// [animation] runs back to 0. [reverse] flips the direction (going back a step).
  static Widget sharedAxis(Widget child, Animation<double> animation, {Axis axis = Axis.horizontal, bool reverse = false, bool outgoing = false, double distance = 30}) {
    final sign = (reverse ? -1.0 : 1.0) * (outgoing ? -1.0 : 1.0);
    final curved = CurvedAnimation(parent: animation, curve: outgoing ? emphasizedAccelerate : emphasizedDecelerate);
    return AnimatedBuilder(
      animation: curved,
      child: child,
      builder: (context, child) {
        final d = (1 - curved.value) * distance * sign;
        // the outgoing child is gone by the halfway mark, the incoming one appears after it
        final fade = outgoing ? ((animation.value - 0.65) / 0.35).clamp(0.0, 1.0) : ((animation.value - 0.3) / 0.7).clamp(0.0, 1.0);
        return Opacity(opacity: fade, child: Transform.translate(offset: axis == Axis.horizontal ? Offset(d, 0) : Offset(0, d), child: child));
      },
    );
  }
}

/// Lists stay flat (hairline borders); what floats over the map or rises from the bottom gets a
/// soft, wide shadow. Dark mode uses a deeper shadow so the lift still reads on charcoal.
abstract final class AnbessaElevation {
  /// list cards: no shadow
  static List<BoxShadow> card(Brightness b) => const [];

  /// a card or button floating over the map
  static List<BoxShadow> floating(Brightness b) => b == Brightness.dark
      ? const [
          BoxShadow(color: Color(0x66000000), blurRadius: 24, offset: Offset(0, 8)),
          BoxShadow(color: Color(0x33000000), blurRadius: 4, offset: Offset(0, 1)),
        ]
      : const [
          BoxShadow(color: Color(0x1A17191D), blurRadius: 24, offset: Offset(0, 8)),
          BoxShadow(color: Color(0x0D17191D), blurRadius: 4, offset: Offset(0, 1)),
        ];

  /// a selected card lifted a little above its neighbours
  static List<BoxShadow> raised(Brightness b) => b == Brightness.dark
      ? const [BoxShadow(color: Color(0x59000000), blurRadius: 16, offset: Offset(0, 6))]
      : const [BoxShadow(color: Color(0x1F17191D), blurRadius: 16, offset: Offset(0, 6))];

  /// the bottom sheet (the shadow points up)
  static List<BoxShadow> sheet(Brightness b) => b == Brightness.dark
      ? const [BoxShadow(color: Color(0x80000000), blurRadius: 28, offset: Offset(0, -6))]
      : const [BoxShadow(color: Color(0x1F17191D), blurRadius: 28, offset: Offset(0, -6))];
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
