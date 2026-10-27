// The images the native layers draw, painted on a canvas (our own shapes, no assets): the car
// seen from above pointing north (the layer turns it with `icon-rotate`), the small anonymous
// car, the pickup ring and drop-off square pins, the person's dot and heading cone, and the
// labels over cars. Each is painted [scale] times larger than it is shown.

import 'dart:math';

import 'package:flutter/painting.dart';
import 'package:ride_app_core/ride_app_core.dart';

/// One image: its logical size and how to paint it (already scaled).
typedef SceneImage = ({int width, int height, void Function(Canvas) paint});

const _ink = Color(0xFF111214);

/// The followed car, 24 × 44 logical: amber body with an ink outline (grey when [stale]).
SceneImage carImage(AnbessaColors c, double scale, {bool stale = false}) {
  const w = 24.0, h = 44.0;
  final body = stale ? c.faint : c.accent;
  return (
    width: ((w + 8) * scale).ceil(),
    height: ((h + 8) * scale).ceil(),
    paint: (canvas) {
      canvas.scale(scale);
      canvas.translate(4, 4);
      _paintCar(canvas, w, h, body: body, outline: _ink, glass: const Color(0xE6202328), shadow: true);
    },
  );
}

/// A car around the rider, 16 × 30 logical: ink (light map) or light grey (dark map).
SceneImage nearbyCarImage(AnbessaColors c, double scale) {
  const w = 16.0, h = 30.0;
  final body = c.isDark ? const Color(0xFFC9CDD3) : c.text2;
  final outline = c.isDark ? _ink : const Color(0xFFFFFFFF);
  return (
    width: ((w + 6) * scale).ceil(),
    height: ((h + 6) * scale).ceil(),
    paint: (canvas) {
      canvas.scale(scale);
      canvas.translate(3, 3);
      _paintCar(canvas, w, h, body: body, outline: outline, glass: c.isDark ? const Color(0xFF5A5F66) : const Color(0xFF3A3D42), shadow: false);
    },
  );
}

void _paintCar(Canvas canvas, double w, double h, {required Color body, required Color outline, required Color glass, required bool shadow}) {
  final r = Radius.circular(w * 0.38);
  final shape = RRect.fromRectAndCorners(Rect.fromLTWH(0, 0, w, h), topLeft: r, topRight: r, bottomLeft: Radius.circular(w * 0.28), bottomRight: Radius.circular(w * 0.28));
  if (shadow) {
    canvas.drawRRect(shape.shift(const Offset(0, 1.5)), Paint()
      ..color = const Color(0x55000000)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 2.5));
  }
  canvas.drawRRect(shape, Paint()..color = body);
  canvas.drawRRect(shape.deflate(0.75), Paint()
    ..color = outline
    ..style = PaintingStyle.stroke
    ..strokeWidth = 1.5);
  // windscreen (front, at the top), rear window, and the roof between them
  final ws = Path()
    ..moveTo(w * 0.16, h * 0.30)
    ..quadraticBezierTo(w * 0.5, h * 0.22, w * 0.84, h * 0.30)
    ..lineTo(w * 0.76, h * 0.42)
    ..lineTo(w * 0.24, h * 0.42)
    ..close();
  canvas.drawPath(ws, Paint()..color = glass);
  final rear = Path()
    ..moveTo(w * 0.24, h * 0.76)
    ..lineTo(w * 0.76, h * 0.76)
    ..lineTo(w * 0.82, h * 0.86)
    ..quadraticBezierTo(w * 0.5, h * 0.9, w * 0.18, h * 0.86)
    ..close();
  canvas.drawPath(rear, Paint()..color = glass);
  canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTRB(w * 0.24, h * 0.45, w * 0.76, h * 0.73), Radius.circular(w * 0.12)), Paint()..color = Color.lerp(body, const Color(0xFFFFFFFF), 0.18)!);
  // headlights
  final light = Paint()..color = const Color(0xFFFFF4D0);
  canvas.drawOval(Rect.fromCenter(center: Offset(w * 0.24, h * 0.06), width: w * 0.2, height: h * 0.04), light);
  canvas.drawOval(Rect.fromCenter(center: Offset(w * 0.76, h * 0.06), width: w * 0.2, height: h * 0.04), light);
}

/// A pin whose tip (the bottom centre) is the point: 36 × 44 logical. Pickup: a ring;
/// drop-off: a filled square.
SceneImage pinImage(AnbessaColors c, double scale, {required bool pickup}) {
  const w = 36.0, h = 44.0;
  final ink = c.isDark ? const Color(0xFFFFFFFF) : c.text;
  return (
    width: (w * scale).ceil(),
    height: (h * scale).ceil(),
    paint: (canvas) {
      canvas.scale(scale);
      // ground shadow, stem, head
      canvas.drawOval(Rect.fromCenter(center: const Offset(w / 2, h - 1.5), width: 8, height: 3), Paint()..color = const Color(0x44000000));
      canvas.drawRect(Rect.fromLTWH(w / 2 - 1.5, h - 19, 3, 16), Paint()..color = ink);
      const center = Offset(w / 2, 13);
      if (pickup) {
        canvas.drawCircle(center, 11, Paint()..color = ink);
        canvas.drawCircle(center, 5, Paint()..color = c.surface);
      } else {
        final sq = RRect.fromRectAndRadius(Rect.fromCenter(center: center, width: 20, height: 20), const Radius.circular(4));
        canvas.drawRRect(sq, Paint()..color = c.surface);
        canvas.drawRRect(sq.deflate(3), Paint()..color = ink);
      }
    },
  );
}

/// The person's dot, 28 × 28 logical.
SceneImage meDotImage(AnbessaColors c, double scale) {
  const s = 28.0;
  return (
    width: (s * scale).ceil(),
    height: (s * scale).ceil(),
    paint: (canvas) {
      canvas.scale(scale);
      const center = Offset(s / 2, s / 2);
      canvas.drawCircle(center.translate(0, 1.5), 10, Paint()
        ..color = const Color(0x44000000)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 2.5));
      canvas.drawCircle(center, 10, Paint()..color = const Color(0xFFFFFFFF));
      canvas.drawCircle(center, 7, Paint()..color = c.info);
    },
  );
}

/// The heading cone around the dot, 56 × 56 logical, pointing north.
SceneImage meConeImage(AnbessaColors c, double scale) {
  const s = 56.0;
  return (
    width: (s * scale).ceil(),
    height: (s * scale).ceil(),
    paint: (canvas) {
      canvas.scale(scale);
      const cx = s / 2, cy = s / 2;
      final path = Path()
        ..moveTo(cx, cy)
        ..lineTo(cx - 13, cy - 25)
        ..quadraticBezierTo(cx, cy - 31, cx + 13, cy - 25)
        ..close();
      canvas.drawPath(path, Paint()..shader = RadialGradient(colors: [c.info.withValues(alpha: 0.55), c.info.withValues(alpha: 0)], radius: 0.8).createShader(Rect.fromCircle(center: const Offset(cx, cy), radius: 30)));
    },
  );
}

/// A label chip with a small tail at the bottom centre ("4 min" over the car): ink text on the
/// surface, a hairline border and an amber dot.
SceneImage labelImage(AnbessaColors c, double scale, String text) {
  final tp = TextPainter(
    text: TextSpan(text: text, style: AnbessaType.label.copyWith(color: c.text, fontWeight: FontWeight.w700, fontSize: 13, fontFeatures: AnbessaType.tabular)),
    textDirection: TextDirection.ltr,
    maxLines: 1,
    ellipsis: '…',
  )..layout(maxWidth: 200);
  const padX = 10.0, dot = 7.0, gap = 6.0, bodyH = 28.0, tail = 6.0;
  final w = padX * 2 + dot + gap + tp.width;
  const h = bodyH + tail + 2;
  return (
    width: ((w + 4) * scale).ceil(),
    height: (h * scale).ceil(),
    paint: (canvas) {
      canvas.scale(scale);
      canvas.translate(2, 0);
      final body = RRect.fromRectAndRadius(Rect.fromLTWH(0, 0, w, bodyH), const Radius.circular(AnbessaRadius.sm));
      final tailPath = Path()
        ..moveTo(w / 2 - tail, bodyH - 0.5)
        ..lineTo(w / 2, bodyH + tail)
        ..lineTo(w / 2 + tail, bodyH - 0.5)
        ..close();
      final shadow = Paint()
        ..color = const Color(0x33000000)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 2);
      canvas.drawRRect(body.shift(const Offset(0, 1)), shadow);
      canvas.drawRRect(body, Paint()..color = c.surface);
      canvas.drawPath(tailPath, Paint()..color = c.surface);
      canvas.drawRRect(body.deflate(0.5), Paint()
        ..color = c.border
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1);
      canvas.drawCircle(Offset(padX + dot / 2, bodyH / 2), dot / 2, Paint()..color = c.accent);
      tp.paint(canvas, Offset(padX + dot + gap, (bodyH - tp.height) / 2));
    },
  );
}

/// The image scale for a device: as many pixels as the screen has, at most 3×.
double sceneImageScale(double devicePixelRatio) => max(1.0, min(3.0, devicePixelRatio)).ceilToDouble();
