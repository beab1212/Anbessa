// Motion helpers. Every one of them collapses to no motion when the system asks for less.

import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import '../theme/tokens.dart';

/// Fade + slide up on first build; stagger with [delay].
class FadeSlideIn extends StatelessWidget {
  const FadeSlideIn({super.key, required this.child, this.delay = Duration.zero, this.offset = 0.08, this.duration = AnbessaMotion.slow});
  final Widget child;
  final Duration delay;
  final double offset;
  final Duration duration;
  @override
  Widget build(BuildContext context) {
    if (MediaQuery.disableAnimationsOf(context)) return child;
    return child.animate(delay: delay).fadeIn(duration: duration, curve: AnbessaMotion.emphasized).slideY(begin: offset, end: 0, duration: duration, curve: AnbessaMotion.emphasized);
  }
}

/// Scale in with a little overshoot (a card appearing, a selected state).
class PopIn extends StatelessWidget {
  const PopIn({super.key, required this.child, this.delay = Duration.zero});
  final Widget child;
  final Duration delay;
  @override
  Widget build(BuildContext context) {
    if (MediaQuery.disableAnimationsOf(context)) return child;
    return child.animate(delay: delay).fadeIn(duration: AnbessaMotion.base).scale(begin: const Offset(0.92, 0.92), end: const Offset(1, 1), duration: AnbessaMotion.slow, curve: AnbessaMotion.spring);
  }
}

/// A gentle repeating pulse (something waiting for attention).
class Pulse extends StatelessWidget {
  const Pulse({super.key, required this.child, this.scale = 1.06});
  final Widget child;
  final double scale;
  @override
  Widget build(BuildContext context) {
    if (MediaQuery.disableAnimationsOf(context)) return child;
    return child.animate(onPlay: (c) => c.repeat(reverse: true)).scale(begin: const Offset(1, 1), end: Offset(scale, scale), duration: const Duration(milliseconds: 900), curve: Curves.easeInOut);
  }
}

/// Shake sideways once (a wrong code).
class Shake extends StatelessWidget {
  const Shake({super.key, required this.child, required this.trigger});
  final Widget child;
  /// change the value to shake again
  final Object? trigger;
  @override
  Widget build(BuildContext context) {
    if (MediaQuery.disableAnimationsOf(context) || trigger == null) return child;
    return child.animate(key: ValueKey(trigger)).shakeX(hz: 5, amount: 6, duration: const Duration(milliseconds: 400));
  }
}

/// Cross-fade between children with a size change, keyed by the child.
class AnimatedSwitcherX extends StatelessWidget {
  const AnimatedSwitcherX({super.key, required this.child, this.duration = AnbessaMotion.slow, this.alignment = Alignment.topCenter});
  final Widget child;
  final Duration duration;
  final Alignment alignment;
  @override
  Widget build(BuildContext context) => AnimatedSize(
        duration: AnbessaMotion.of(context, duration),
        curve: AnbessaMotion.emphasized,
        alignment: alignment,
        child: AnimatedSwitcher(
          duration: AnbessaMotion.of(context, duration),
          switchInCurve: AnbessaMotion.emphasized,
          switchOutCurve: AnbessaMotion.emphasized,
          transitionBuilder: (w, a) => FadeTransition(opacity: a, child: SlideTransition(position: Tween(begin: const Offset(0, 0.03), end: Offset.zero).animate(a), child: w)),
          layoutBuilder: (current, previous) => Stack(alignment: alignment, children: [...previous, ?current]),
          child: child,
        ),
      );
}

/// Switches between keyed children with a shared-axis transition: the new child slides in along
/// [axis] while the old one slides out the other way, cross-fading through. Set [reverse] when
/// going back a step. Children must have distinct keys. A plain swap when motion is reduced.
class SharedAxisSwitcher extends StatelessWidget {
  const SharedAxisSwitcher({super.key, required this.child, this.axis = Axis.horizontal, this.reverse = false, this.duration = AnbessaMotion.medium, this.distance = 30, this.alignment = Alignment.topCenter});
  final Widget child;
  final Axis axis;
  final bool reverse;
  final Duration duration;
  /// how far (px) the children travel
  final double distance;
  final Alignment alignment;

  @override
  Widget build(BuildContext context) {
    if (AnbessaMotion.reduced(context)) return child;
    return AnimatedSwitcher(
      duration: duration,
      // the curves live in AnbessaMotion.sharedAxis; the switcher runs linear
      transitionBuilder: (w, a) => AnbessaMotion.sharedAxis(w, a, axis: axis, reverse: reverse, outgoing: w.key != child.key, distance: distance),
      layoutBuilder: (current, previous) => Stack(alignment: alignment, children: [...previous, ?current]),
      child: child,
    );
  }
}

/// Expanding rings from a point: "finding a driver" at the pickup, going online.
class RadarPulse extends StatefulWidget {
  const RadarPulse({super.key, required this.color, this.size = 120, this.rings = 3});
  final Color color;
  final double size;
  final int rings;
  @override
  State<RadarPulse> createState() => _RadarPulseState();
}

class _RadarPulseState extends State<RadarPulse> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 2400))..repeat();
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (MediaQuery.disableAnimationsOf(context)) {
      return Container(width: widget.size * 0.5, height: widget.size * 0.5, decoration: BoxDecoration(shape: BoxShape.circle, color: widget.color.withValues(alpha: 0.25)));
    }
    return AnimatedBuilder(
      animation: _c,
      builder: (_, _) => SizedBox(
        width: widget.size,
        height: widget.size,
        child: Stack(
          alignment: Alignment.center,
          children: [
            for (var i = 0; i < widget.rings; i++)
              Builder(builder: (_) {
                final t = ((_c.value + i / widget.rings) % 1.0);
                return Container(
                  width: widget.size * t,
                  height: widget.size * t,
                  decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: widget.color.withValues(alpha: (1 - t) * 0.6), width: 2), color: widget.color.withValues(alpha: (1 - t) * 0.12)),
                );
              }),
            Container(width: 14, height: 14, decoration: BoxDecoration(shape: BoxShape.circle, color: widget.color, border: Border.all(color: Colors.white, width: 2))),
          ],
        ),
      ),
    );
  }
}
