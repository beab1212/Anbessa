// The opening animation on the amber splash: our own side-view car drives in from the left along
// a road line, motion streaks behind it and wheels turning with the distance it covers; it brakes
// in the middle (the nose dips and settles in a small bounce) while the name "Anbessa" rises
// letter by letter from under the road. While the app is still loading the car cruises on the
// spot: the road's dashes slide by under it, the wheels turn, the body bobs a little.
//
// Cheap: one AnimationController whose value is the time in seconds, one CustomPainter that
// draws everything (car, road, streaks, name) in a RepaintBoundary, the name laid out once.
// With reduced motion the car stands still in the middle and the name is simply there.

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:ride_app_core/ride_app_core.dart';

/// The brand name, never translated.
const anbessaWordmark = 'Anbessa';

/// The splash's ink (on amber).
const splashInk = Color(0xFF17191D);

/// The timeline, in seconds.
abstract final class SplashTimeline {
  /// the car arrives in the middle
  static const driveEnd = 1.2;
  /// the share of the drive at full speed; the rest is braking
  static const cruise = 0.45;
  /// the first letter starts to rise; each next one [letterGap] later, each over [letterRise]
  static const lettersStart = 0.95;
  static const letterGap = 0.06;
  static const letterRise = 0.5;
  /// the cruise on the spot starts (and takes [idleRamp] to reach its speed)
  static const idleStart = 2.3;
  static const idleRamp = 0.9;
  /// the intro is over: only the idle loop moves after this
  static double get introEnd => lettersStart + letterGap * (anbessaWordmark.length - 1) + letterRise;
}

/// The animated splash art (car, road, name). [onlyStill] draws the end state without motion
/// (reduced motion), and never starts the controller.
class SplashIntro extends StatefulWidget {
  const SplashIntro({super.key, this.height = 236, this.semanticsLabel = anbessaWordmark});
  final double height;
  final String semanticsLabel;
  @override
  State<SplashIntro> createState() => _SplashIntroState();
}

class _SplashIntroState extends State<SplashIntro> with SingleTickerProviderStateMixin {
  // value = seconds since the splash appeared (linear), for an hour at most
  late final AnimationController _clock = AnimationController(vsync: this, upperBound: 3600, duration: const Duration(seconds: 3600));
  bool? _still;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final still = MediaQuery.disableAnimationsOf(context);
    if (still == _still) return;
    _still = still;
    if (still) {
      _clock.stop();
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
    final still = _still ?? false;
    return Semantics(
      container: true,
      label: widget.semanticsLabel,
      image: true,
      child: RepaintBoundary(
        child: SizedBox(
          height: widget.height,
          width: double.infinity,
          child: CustomPaint(painter: SplashPainter(clock: _clock, still: still, textDirection: Directionality.of(context))),
        ),
      ),
    );
  }
}

/// What the splash shows at a moment (pure, for the painter and the tests).
@immutable
class SplashFrame {
  const SplashFrame({required this.carX, required this.speed, required this.wheel, required this.pitch, required this.bob, required this.roadShift, required this.streaks, required this.letters});

  /// the car's centre, as a fraction of the way from off-screen left (-1) to the middle (0)
  final double carX;
  /// how fast the car (or the road under it) moves, 0–1
  final double speed;
  /// wheel turn, radians
  final double wheel;
  /// body pitch, degrees (positive: the nose dips)
  final double pitch;
  /// body lift, logical pixels (up is positive)
  final double bob;
  /// how far the road's dashes have slid left, logical pixels
  final double roadShift;
  /// motion streaks' strength, 0–1
  final double streaks;
  /// each letter's rise, 0 (hidden under the road) – 1 (in place); may overshoot a little
  final List<double> letters;

  /// The end state, nothing moving (reduced motion).
  static final still = SplashFrame(carX: 0, speed: 0, wheel: 0, pitch: 0, bob: 0, roadShift: 0, streaks: 0, letters: List.filled(anbessaWordmark.length, 1.0));

  /// The frame at [t] seconds. [travel] is how far (logical px) the car drives in.
  static SplashFrame at(double t, {double travel = 300, double wheelRadius = 14}) {
    const end = SplashTimeline.driveEnd;
    // driving in: at full speed, then braking evenly into the stop
    final u = (t / end).clamp(0.0, 1.0);
    const a = SplashTimeline.cruise, v0 = 2 / (1 + a);
    final eased = u <= a ? v0 * u : v0 * a + v0 * (u - a) - v0 * (u - a) * (u - a) / (2 * (1 - a));
    final carX = eased - 1;
    final driveSpeed = t >= end ? 0.0 : (u <= a ? 1.0 : 1 - (u - a) / (1 - a));
    // the brake: the nose dips and settles (a damped wobble), starting just before the stop
    final tb = t - (end - 0.12);
    final pitch = tb <= 0 ? 0.0 : 3.2 * math.exp(-5.5 * tb) * math.sin(11 * tb);
    // the cruise on the spot once the intro has settled
    final ti = t - SplashTimeline.idleStart;
    final ramp = ti <= 0 ? 0.0 : Curves.easeInOut.transform((ti / SplashTimeline.idleRamp).clamp(0.0, 1.0));
    const idleSpeedPx = 70.0; // px/s of road sliding by
    // distance the road has slid under the car: ∫ ramp dt, closed form for the smooth ramp
    final roadShift = ti <= 0 ? 0.0 : idleSpeedPx * (ti <= SplashTimeline.idleRamp ? _rampIntegral(ti) : _rampIntegral(SplashTimeline.idleRamp) + (ti - SplashTimeline.idleRamp));
    final driven = travel * eased;
    final wheel = (driven + roadShift) / wheelRadius;
    final bob = ramp * 0.9 * math.sin(t * 2 * math.pi * 1.6);
    final letters = [
      for (var i = 0; i < anbessaWordmark.length; i++) _rise((t - SplashTimeline.lettersStart - SplashTimeline.letterGap * i) / SplashTimeline.letterRise),
    ];
    final idleSpeed = ramp * 0.28;
    return SplashFrame(
      carX: carX,
      speed: math.max(driveSpeed, idleSpeed),
      wheel: wheel,
      pitch: pitch,
      bob: bob,
      roadShift: roadShift,
      streaks: math.max(driveSpeed, idleSpeed),
      letters: letters,
    );
  }

  // ∫0..x easeInOut(s / ramp) ds, numerically (cheap: 24 steps)
  static double _rampIntegral(double x) {
    const n = 24;
    final h = x / n;
    var sum = 0.0;
    for (var i = 0; i < n; i++) {
      sum += Curves.easeInOut.transform((((i + 0.5) * h) / SplashTimeline.idleRamp).clamp(0.0, 1.0)) * h;
    }
    return sum;
  }

  static double _rise(double u) {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    return AnbessaMotion.emphasizedDecelerate.transform(u);
  }
}

/// Draws a [SplashFrame]: the road, the streaks, the car, the name.
class SplashPainter extends CustomPainter {
  SplashPainter({this.clock, this.still = false, this.time, this.textDirection = TextDirection.ltr}) : super(repaint: clock);

  /// seconds (an AnimationController's value)
  final Animation<double>? clock;
  final bool still;
  /// a fixed time instead of [clock] (tests)
  final double? time;
  final TextDirection textDirection;

  static const _carWidth = 176.0;
  static const _fontSize = 46.0;
  static const _style = TextStyle(fontFamily: anbessaFontFamily, fontSize: _fontSize, fontWeight: FontWeight.w800, color: splashInk, height: 1.0, letterSpacing: -0.5);
  // the whole name laid out once (for its width and each letter's place, kerning included), and
  // each letter on its own (to move and fade them one by one)
  TextPainter? _word;
  List<(TextPainter, double)>? _letters;

  void _layoutWord() {
    if (_word != null) return;
    final word = TextPainter(text: const TextSpan(text: anbessaWordmark, style: _style), textDirection: TextDirection.ltr)..layout();
    _word = word;
    _letters = [
      for (var i = 0; i < anbessaWordmark.length; i++)
        (
          TextPainter(text: TextSpan(text: anbessaWordmark[i], style: _style), textDirection: TextDirection.ltr)..layout(),
          word.getOffsetForCaret(TextPosition(offset: i), Rect.zero).dx,
        ),
    ];
  }

  @override
  void paint(Canvas canvas, Size size) {
    final t = time ?? clock?.value ?? 0;
    final f = still ? SplashFrame.still : SplashFrame.at(t, travel: size.width / 2 + _carWidth * 0.7, wheelRadius: _carWidth * 0.085);
    final cx = size.width / 2;
    final roadY = size.height * 0.48;
    _paintRoad(canvas, size, roadY, f);
    // the car: centred, its wheels on the road
    final scale = _carWidth / 100;
    final carCx = cx + f.carX * (size.width / 2 + _carWidth * 0.7);
    final carLeft = carCx - _carWidth / 2;
    final carTop = roadY - 40 * scale - 1.5;
    _paintStreaks(canvas, carLeft, carTop, scale, f);
    canvas.save();
    canvas.translate(carLeft, carTop);
    canvas.scale(scale);
    paintSideCar(canvas, wheel: f.wheel, pitch: f.pitch, lift: f.bob / scale);
    canvas.restore();
    _paintWordmark(canvas, size, roadY, f);
  }

  void _paintRoad(Canvas canvas, Size size, double y, SplashFrame f) {
    final fade = Paint()
      ..shader = LinearGradient(
        colors: [splashInk.withValues(alpha: 0), splashInk.withValues(alpha: 0.9), splashInk.withValues(alpha: 0.9), splashInk.withValues(alpha: 0)],
        stops: const [0, 0.22, 0.78, 1],
      ).createShader(Rect.fromLTWH(0, y - 2, size.width, 4))
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round;
    // the road: a line with gaps, sliding left while the car cruises
    const dash = 34.0, gap = 12.0, period = dash + gap;
    final shift = f.roadShift % period;
    for (var x = -period - shift; x < size.width + period; x += period) {
      canvas.drawLine(Offset(x, y), Offset(x + dash, y), fade);
    }
  }

  void _paintStreaks(Canvas canvas, double carLeft, double carTop, double scale, SplashFrame f) {
    if (f.streaks <= 0.02) return;
    final p = Paint()
      ..color = splashInk.withValues(alpha: 0.55 * math.min(1, f.streaks * 1.4))
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round;
    // three lines trailing the car, longer the faster it goes
    const rows = [(y: 13.0, len: 1.0, back: 4.0), (y: 21.0, len: 0.7, back: 12.0), (y: 29.0, len: 0.85, back: 2.0)];
    for (final r in rows) {
      final len = (18 + 70 * f.streaks) * r.len;
      final x1 = carLeft - r.back * scale * 0.5;
      final y = carTop + r.y * scale;
      canvas.drawLine(Offset(x1 - len, y), Offset(x1 - 6, y), p);
    }
  }

  void _paintWordmark(Canvas canvas, Size size, double roadY, SplashFrame f) {
    _layoutWord();
    final word = _word!;
    final left = (size.width - word.width) / 2;
    final top = roadY + 30;
    for (final (i, (tp, x)) in _letters!.indexed) {
      final rise = f.letters[i];
      if (rise <= 0) continue;
      final at = Offset(left + x, top + (1 - rise) * 22);
      if (rise >= 1) {
        tp.paint(canvas, at);
      } else {
        canvas.saveLayer(Rect.fromLTWH(at.dx - 4, at.dy - 4, tp.width + 8, tp.height + 8), Paint()..color = Color.fromRGBO(0, 0, 0, rise.clamp(0.0, 1.0)));
        tp.paint(canvas, at);
        canvas.restore();
      }
    }
  }

  @override
  bool shouldRepaint(SplashPainter old) => old.still != still || old.time != time || old.clock != clock;
}

/// Our side-view car, facing right, in a 100 × 40 box (y down; the wheels' bottoms on y = 40):
/// an ink body with pale amber windows, a headlight and a tail light, wheels with amber rims
/// whose spokes show the turn ([wheel], radians). [pitch] tilts the body (degrees, nose down)
/// about the rear wheel; [lift] raises it on its springs.
void paintSideCar(Canvas canvas, {double wheel = 0, double pitch = 0, double lift = 0}) {
  const ink = splashInk;
  const glass = Color(0xFFFFE3A0);
  const rearW = Offset(25, 31.5), frontW = Offset(77, 31.5);
  const tireR = 8.5;
  // the shadow on the road
  canvas.drawOval(
    Rect.fromCenter(center: const Offset(51, 40.2), width: 90, height: 3.6),
    Paint()
      ..color = const Color(0x40000000)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 1.6),
  );
  // the body (on its springs): tilted about the rear wheel
  canvas.save();
  canvas.translate(0, -lift);
  canvas.translate(rearW.dx, rearW.dy);
  canvas.rotate(pitch * math.pi / 180);
  canvas.translate(-rearW.dx, -rearW.dy);
  final body = Path()
    ..moveTo(5, 31)
    ..lineTo(13.2, 31)
    ..arcToPoint(const Offset(36.8, 31), radius: const Radius.circular(11.8), clockwise: true)
    ..lineTo(65.2, 31)
    ..arcToPoint(const Offset(88.8, 31), radius: const Radius.circular(11.8), clockwise: true)
    ..lineTo(95, 31)
    ..quadraticBezierTo(98.6, 30.6, 98.4, 26.5)
    ..lineTo(98, 22.5)
    ..quadraticBezierTo(97.4, 18.6, 92.5, 17.6)
    ..lineTo(76, 15.2)
    ..quadraticBezierTo(73.2, 14.8, 70.6, 12.4)
    ..lineTo(63.8, 6.6)
    ..quadraticBezierTo(60.6, 4.2, 55.5, 4.1)
    ..lineTo(38.5, 4.1)
    ..quadraticBezierTo(33.6, 4.2, 30.6, 6.8)
    ..lineTo(22.5, 14.2)
    ..lineTo(9, 16.2)
    ..quadraticBezierTo(3.4, 17.2, 2.6, 21.5)
    ..lineTo(2.2, 26.5)
    ..quadraticBezierTo(2.2, 30.8, 5, 31)
    ..close();
  canvas.drawPath(body, Paint()..color = ink);
  // windows: the rear one and the front one, split by the pillar
  final rearGlass = Path()
    ..moveTo(26.8, 14.3)
    ..lineTo(33.2, 8.3)
    ..quadraticBezierTo(35.4, 6.6, 38.6, 6.6)
    ..lineTo(47.4, 6.6)
    ..lineTo(47.4, 14.3)
    ..close();
  final frontGlass = Path()
    ..moveTo(50.4, 6.6)
    ..lineTo(55.2, 6.6)
    ..quadraticBezierTo(59.4, 6.7, 61.8, 8.6)
    ..lineTo(68.6, 14.3)
    ..lineTo(50.4, 14.3)
    ..close();
  final g = Paint()..color = glass;
  canvas.drawPath(rearGlass, g);
  canvas.drawPath(frontGlass, g);
  // a glint across the windscreen
  canvas.drawLine(const Offset(58.2, 8.4), const Offset(62.6, 12.6), Paint()
    ..color = const Color(0xCCFFFFFF)
    ..strokeWidth = 1.1
    ..strokeCap = StrokeCap.round);
  // the door line and handles, in a lighter ink
  final line = Paint()
    ..color = const Color(0xFF3A3E46)
    ..strokeWidth = 0.7
    ..style = PaintingStyle.stroke;
  canvas.drawLine(const Offset(48.9, 15.6), const Offset(48.9, 28.6), line);
  final handle = Paint()..color = const Color(0xFF4A4F58);
  canvas.drawRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(40.5, 18.6, 4.6, 1.3), const Radius.circular(0.65)), handle);
  canvas.drawRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(60.2, 18.8, 4.6, 1.3), const Radius.circular(0.65)), handle);
  // headlight (with a soft glow) and tail light
  canvas.drawCircle(const Offset(96.6, 21.2), 3.4, Paint()
    ..color = const Color(0x55FFF4C8)
    ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 1.8));
  canvas.drawRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(93.6, 19.6, 4.2, 2.8), const Radius.circular(1.2)), Paint()..color = const Color(0xFFFFF4C8));
  canvas.drawRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(2.4, 19.4, 2.6, 3.2), const Radius.circular(1)), Paint()..color = const Color(0xFFE5483A));
  canvas.restore();
  // the wheels (they don't tilt with the body)
  for (final w in [rearW, frontW]) {
    _paintWheel(canvas, w, tireR, wheel);
  }
}

void _paintWheel(Canvas canvas, Offset c, double r, double turn) {
  canvas.drawCircle(c, r, Paint()..color = splashInk);
  // the rim: amber, with five spokes
  canvas.drawCircle(c, r * 0.6, Paint()..color = const Color(0xFFFFC94A));
  final spoke = Paint()
    ..color = const Color(0xFF8A5E00)
    ..strokeWidth = 1.2
    ..strokeCap = StrokeCap.round;
  for (var i = 0; i < 5; i++) {
    final a = turn + i * 2 * math.pi / 5;
    canvas.drawLine(c + Offset(math.cos(a), math.sin(a)) * r * 0.16, c + Offset(math.cos(a), math.sin(a)) * r * 0.54, spoke);
  }
  canvas.drawCircle(c, r * 0.17, Paint()..color = splashInk);
}
