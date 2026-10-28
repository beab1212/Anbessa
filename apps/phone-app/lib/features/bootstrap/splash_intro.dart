// The opening animation, "Headlights in the dark": on an ink screen the app icon's two headlights
// flicker on, a warm glow blooms around them, an amber disc grows from the icon's centre over the
// whole screen (revealing the ink car against it), then shrinks and morphs into the icon's
// rounded square with a small overshoot; the windshield, nose and grille fade in, and the name
// "Anbessa" rises under the icon. While the app is still loading after that, the headlights'
// glow pulses gently. The art is the app icon ("Lion Grille"), painted part by part from
// `LionGrilleArt` (the same shapes as the SVG master in the core package).
//
// The prototype's timeline runs 0–100%; here it plays once over [SplashTimeline.intro] seconds.
// Cheap: one AnimationController (its value is seconds, linear), one CustomPainter for the disc
// and the glyph in a RepaintBoundary, the name a Text under Fade/SlideTransitions driven by the
// same controller. With reduced motion it is the final frame (icon and name), nothing moving.

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:ride_app_core/ride_app_core.dart';

/// The brand name, never translated.
const anbessaWordmark = 'Anbessa';

/// The splash's background (the icon's ink), and the name's colour on it.
const splashInk = LionGrilleArt.ink;
const splashPaper = LionGrilleArt.paper;
const splashAmber = LionGrilleArt.amber;

/// The timeline and the layout. Times as fractions of the intro (the prototype's percentages).
abstract final class SplashTimeline {
  /// seconds the whole intro (0–100%) takes
  static const intro = 3.2;
  /// the icon has settled into its square: the router may move on from here
  static const settled = 0.78;
  static const settleTime = settled * intro;
  /// the idle glow's period, seconds
  static const idlePeriod = 1.6;

  /// the icon's side and corner radius, logical px
  static const iconSize = 200.0;
  static const iconCorner = 46.0;
  /// the icon's centre, as a fraction of the screen's height
  static const iconCentre = 0.42;
  /// the name's gap under the icon, its size and line height
  static const wordGap = 32.0;
  static const wordSize = 40.0;
  static const wordBox = 48.0;
  /// how far the name rises as it fades in, logical px
  static const wordRise = 18.0;

  /// seconds at a fraction of the intro
  static double seconds(double fraction) => fraction * intro;
}

/// What the splash shows at a moment (pure, for the painter, the name and the tests).
@immutable
class SplashFrame {
  const SplashFrame({
    required this.lights,
    required this.glow,
    required this.glowScale,
    required this.shape,
    required this.corner,
    required this.details,
    required this.word,
    required this.wordRise,
  });

  /// the headlights' opacity, 0–1
  final double lights;
  /// the warm glow around the headlights: opacity and scale (of its 150 radius)
  final double glow;
  final double glowScale;
  /// the amber shape's side and corner radius, logical px: a disc ([corner] = half [shape])
  /// while it grows, then the icon's rounded square. [double.infinity] covers the screen.
  final double shape;
  final double corner;
  /// the windshield, nose and grille's opacity, 0–1
  final double details;
  /// the name's opacity, 0–1, and how far below its place it is, logical px
  final double word;
  final double wordRise;

  static const _ease = Cubic(.65, 0, .2, 1);
  static const _wordCurve = Cubic(.2, 0, 0, 1);

  /// The final frame (reduced motion, and the end of the intro).
  static final end = at(SplashTimeline.intro);

  /// The frame at [t] seconds. [cover] is the amber disc's radius that covers the whole screen
  /// (from the icon's centre to the farthest corner); infinite when unknown.
  static SplashFrame at(double t, {double cover = double.infinity}) {
    final p = t / SplashTimeline.intro;
    const size = SplashTimeline.iconSize, corner = SplashTimeline.iconCorner;
    // the amber: a disc growing from nothing over the whole screen, held, then shrinking into
    // the icon's square with a small overshoot
    double shape, radius;
    if (p < 0.32) {
      shape = radius = 0;
    } else if (p < 0.50) {
      radius = cover * _ease.transform((p - 0.32) / 0.18);
      shape = radius * 2;
    } else if (p < 0.58) {
      radius = cover;
      shape = cover * 2;
    } else if (p < 0.70) {
      final u = _ease.transform((p - 0.58) / 0.12);
      shape = _lerp(cover * 2, size, u);
      radius = _lerp(cover, corner, u);
    } else if (p < 0.74) {
      final u = Curves.easeOut.transform((p - 0.70) / 0.04);
      shape = _lerp(size, 212, u);
      radius = _lerp(corner, 48, u);
    } else if (p < 0.78) {
      final u = Curves.easeInOut.transform((p - 0.74) / 0.04);
      shape = _lerp(212, size, u);
      radius = _lerp(48, corner, u);
    } else {
      shape = size;
      radius = corner;
    }
    final w = _wordCurve.transform(((p - 0.76) / 0.10).clamp(0.0, 1.0));
    // after the intro, while the app still loads: the glow breathes (0 → 0.25 → 0)
    final idle = t <= SplashTimeline.intro ? 0.0 : 0.25 * math.pow(math.sin(math.pi * (t - SplashTimeline.intro) / SplashTimeline.idlePeriod), 2).toDouble();
    return SplashFrame(
      lights: _keys(p, const [(0.10, 0), (0.12, 1), (0.14, 0.15), (0.17, 1), (0.19, 0.4), (0.22, 1)]),
      glow: p <= 0.52 ? _keys(p, const [(0.20, 0), (0.30, 0.55), (0.44, 0.35), (0.52, 0)]) : idle,
      glowScale: p <= 0.52 ? _keys(p, const [(0.20, 0.6), (0.30, 1.25), (0.44, 1.1), (0.52, 1.0)]) : 1.0,
      shape: shape,
      corner: radius,
      details: Curves.easeOut.transform(((p - 0.48) / 0.08).clamp(0.0, 1.0)),
      word: w,
      wordRise: SplashTimeline.wordRise * (1 - w),
    );
  }

  static double _lerp(double a, double b, double u) => a.isInfinite ? (u >= 1 ? b : a) : a + (b - a) * u;

  /// Linear between keyframes (fraction, value); held before the first and after the last.
  static double _keys(double p, List<(double, double)> keys) {
    if (p <= keys.first.$1) return keys.first.$2;
    for (var i = 1; i < keys.length; i++) {
      final (x1, y1) = keys[i];
      if (p <= x1) {
        final (x0, y0) = keys[i - 1];
        return y0 + (y1 - y0) * (p - x0) / (x1 - x0);
      }
    }
    return keys.last.$2;
  }
}

/// The animated splash: the art fills the screen (ink), the name sits [SplashTimeline.wordGap]
/// under the icon, and [footer] (the offline line) under the name, so the art never moves when
/// it appears. [onSettled] is called once, when the icon has settled into its square (at once
/// with reduced motion). [loadingLabel] is announced in a live region.
class SplashIntro extends StatefulWidget {
  const SplashIntro({super.key, this.footer, this.onSettled, this.loadingLabel});
  final Widget? footer;
  final VoidCallback? onSettled;
  final String? loadingLabel;
  @override
  State<SplashIntro> createState() => _SplashIntroState();
}

class _SplashIntroState extends State<SplashIntro> with SingleTickerProviderStateMixin {
  // value = seconds since the splash appeared (linear), for an hour at most
  late final AnimationController _clock = AnimationController(vsync: this, upperBound: 3600, duration: const Duration(seconds: 3600))..addListener(_tick);
  late final Animation<double> _wordOpacity = _clock.drive(_Track((t) => SplashFrame.at(t).word));
  late final Animation<Offset> _wordOffset = _clock.drive(_OffsetTrack((t) => Offset(0, SplashFrame.at(t).wordRise / SplashTimeline.wordBox)));
  bool? _still;
  bool _settled = false;

  void _tick() {
    // only while playing (not when the reduced-motion branch sets the value, during a build)
    if (!_settled && _clock.isAnimating && _clock.value >= SplashTimeline.settleTime) _settle();
  }

  void _settle() {
    _settled = true;
    widget.onSettled?.call();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final still = MediaQuery.disableAnimationsOf(context);
    if (still == _still) return;
    _still = still;
    if (still) {
      // the final frame, nothing moving; the router may go on right away
      _clock.stop();
      _clock.value = SplashTimeline.intro;
      if (!_settled) WidgetsBinding.instance.addPostFrameCallback((_) => mounted && !_settled ? _settle() : null);
    } else if (!_clock.isAnimating) {
      _clock.forward();
    }
  }

  @override
  void dispose() {
    _clock.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, box) {
      final top = box.maxHeight * SplashTimeline.iconCentre + SplashTimeline.iconSize / 2 + SplashTimeline.wordGap;
      return Stack(
        children: [
          Positioned.fill(
            child: Semantics(
              liveRegion: true,
              label: widget.loadingLabel,
              child: Semantics(
                container: true,
                image: true,
                label: anbessaWordmark,
                child: ExcludeSemantics(
                  child: Stack(
                    children: [
                      Positioned.fill(
                        child: RepaintBoundary(child: CustomPaint(painter: SplashPainter(clock: _clock, still: _still ?? false))),
                      ),
                      Positioned(
                        top: top,
                        left: 16,
                        right: 16,
                        height: SplashTimeline.wordBox,
                        child: FadeTransition(
                          opacity: _wordOpacity,
                          child: SlideTransition(
                            position: _wordOffset,
                            child: const Text(
                              anbessaWordmark,
                              key: ValueKey('splash-wordmark'),
                              textAlign: TextAlign.center,
                              maxLines: 1,
                              textScaler: TextScaler.noScaling,
                              style: TextStyle(
                                fontFamily: anbessaFontFamily,
                                fontWeight: FontWeight.w800,
                                fontSize: SplashTimeline.wordSize,
                                height: SplashTimeline.wordBox / SplashTimeline.wordSize,
                                letterSpacing: -0.5,
                                color: splashPaper,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          if (widget.footer != null) Positioned(top: top + SplashTimeline.wordBox + 24, left: 0, right: 0, bottom: 0, child: widget.footer!),
        ],
      );
    });
  }
}

class _Track extends Animatable<double> {
  _Track(this.f);
  final double Function(double t) f;
  @override
  double transform(double t) => f(t);
}

class _OffsetTrack extends Animatable<Offset> {
  _OffsetTrack(this.f);
  final Offset Function(double t) f;
  @override
  Offset transform(double t) => f(t);
}

/// Paints the amber disc / square and the icon's glyph for the clock's time (seconds).
class SplashPainter extends CustomPainter {
  SplashPainter({required this.clock, required this.still}) : super(repaint: clock);
  final Animation<double> clock;
  /// reduced motion: the final frame
  final bool still;

  static const _glowRadius = 150.0;

  @override
  void paint(Canvas canvas, Size size) {
    final centre = Offset(size.width / 2, size.height * SplashTimeline.iconCentre);
    // from the icon's centre to the farthest corner, and a little more
    final cover = math.sqrt(math.pow(math.max(centre.dx, size.width - centre.dx), 2) + math.pow(math.max(centre.dy, size.height - centre.dy), 2)) + 2;
    final f = still ? SplashFrame.end : SplashFrame.at(clock.value, cover: cover);

    if (f.shape > 0) {
      final rect = Rect.fromCenter(center: centre, width: f.shape, height: f.shape);
      canvas.drawRRect(RRect.fromRectAndRadius(rect, Radius.circular(f.corner)), Paint()..color = splashAmber);
    }

    const scale = SplashTimeline.iconSize / LionGrilleArt.size;
    canvas.save();
    canvas.translate(centre.dx - SplashTimeline.iconSize / 2, centre.dy - SplashTimeline.iconSize / 2);
    canvas.scale(scale);
    LionGrilleArt.paintGlyph(
      canvas,
      lights: f.lights,
      windshieldOpacity: f.details,
      noseOpacity: f.details,
      grilleOpacity: f.details,
      underLights: f.glow <= 0
          ? null
          : (c) {
              final r = _glowRadius * f.glowScale;
              for (final h in LionGrilleArt.headlights) {
                final glow = Paint()
                  ..shader = RadialGradient(
                    colors: [LionGrilleArt.cream.withValues(alpha: f.glow), LionGrilleArt.cream.withValues(alpha: f.glow * 0.45), LionGrilleArt.cream.withValues(alpha: 0)],
                    stops: const [0.3, 0.6, 1],
                  ).createShader(Rect.fromCircle(center: h, radius: r));
                c.drawCircle(h, r, glow);
              }
            },
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(SplashPainter old) => old.still != still || old.clock != clock;
}
