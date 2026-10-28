// The images the native layers draw, painted on a canvas with the design system's map markers
// (ride_app_core map_markers.dart, the GoRide kit's look): the white top-down car pointing north
// (the layer turns it with `icon-rotate`) for the followed car and the cars around the rider, the
// person as an avatar in an amber ring with a tail (their photo, else their initials, else a
// person glyph) for the pickup and for "you" on the home map, the red destination pin, the small
// position dot and heading cone, and the labels over cars. Each is painted [scale] times larger
// than it is shown (the device's pixel ratio, up to 3), so it stays crisp.

import 'dart:async';
import 'dart:math';
import 'dart:ui' as ui;

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:ride_app_core/ride_app_core.dart';

/// One image: its pixel size and how to paint it (already scaled).
typedef SceneImage = ({int width, int height, void Function(Canvas) paint});

/// The person the avatar markers show: a decoded photo, else initials, else a person glyph.
@immutable
class ScenePerson {
  const ScenePerson({this.photo, this.initials = ''});
  final ui.Image? photo;
  final String initials;
  static const nobody = ScenePerson();
}

/// Room around a car for its soft shadow, in logical pixels.
const _carPad = 4.0;

/// The width of the followed car and of the cars around the rider (logical pixels).
const driverCarWidth = 24.0;
const nearbyCarWidth = 20.0;

/// The avatar pin's circle (the pickup and "you") and the destination pin's, in logical pixels.
const avatarPinDiameter = 46.0;
const destinationPinDiameter = 36.0;

SceneImage _car(double scale, double width, {required Color body, required Color glass}) {
  final s = topDownCarSize(width);
  return (
    width: ((s.width + _carPad * 2) * scale).ceil(),
    height: ((s.height + _carPad * 2) * scale).ceil(),
    paint: (canvas) {
      canvas.scale(scale);
      canvas.translate(_carPad, _carPad);
      paintTopDownCar(canvas, s, body: body, glass: glass);
    },
  );
}

/// The followed car, white like the kit's (grey when [stale]).
SceneImage carImage(AnbessaColors c, double scale, {bool stale = false}) =>
    _car(scale, driverCarWidth, body: stale ? const Color(0xFFB9BCC2) : Colors.white, glass: const Color(0xFF2B2F36));

/// A car around the rider: the same white top-down car, a little smaller.
SceneImage nearbyCarImage(AnbessaColors c, double scale) => _car(scale, nearbyCarWidth, body: Colors.white, glass: const Color(0xFF2B2F36));

/// The person as a pin (the tip, at the bottom centre, is the point): their photo in an amber
/// ring; initials on amber-soft without one; a person glyph without a name.
SceneImage avatarPinImage(AnbessaColors c, double scale, ScenePerson who) {
  final s = avatarPinSize(avatarPinDiameter);
  return (
    width: (s.width * scale).ceil(),
    height: (s.height * scale).ceil(),
    paint: (canvas) {
      canvas.scale(scale);
      paintAvatarPin(canvas, s, ring: c.accent, photo: who.photo, initials: who.initials.isEmpty ? null : who.initials, fill: const Color(0xFFFFF4D6), initialsColor: const Color(0xFF17191D));
      if (who.photo == null && who.initials.isEmpty) _paintPersonGlyph(canvas, Offset(s.width / 2, s.width / 2), s.width * 0.42);
    },
  );
}

void _paintPersonGlyph(Canvas canvas, Offset center, double size) {
  const icon = Icons.person_rounded;
  final tp = TextPainter(
    text: TextSpan(text: String.fromCharCode(icon.codePoint), style: TextStyle(fontFamily: icon.fontFamily, package: icon.fontPackage, fontSize: size, color: const Color(0xFF8F5B00))),
    textDirection: TextDirection.ltr,
  )..layout();
  tp.paint(canvas, center - Offset(tp.width / 2, tp.height / 2));
}

/// The destination: the kit's red ring pin with a white face and a red dot.
SceneImage destinationPinImage(AnbessaColors c, double scale) {
  final s = destinationPinSize(destinationPinDiameter);
  return (
    width: (s.width * scale).ceil(),
    height: (s.height * scale).ceil(),
    paint: (canvas) {
      canvas.scale(scale);
      paintDestinationPin(canvas, s, color: c.danger);
    },
  );
}

/// The person's position as a small dot (screens that don't show them as an avatar), 28 × 28.
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
      final body = RRect.fromRectAndRadius(Rect.fromLTWH(0, 0, w, bodyH), const Radius.circular(bodyH / 2));
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

/// A person's picture (a data URL or an https URL) decoded for painting on the map; null when
/// there is none or it doesn't load within [timeout].
Future<ui.Image?> loadAvatarImage(String? src, {Duration timeout = const Duration(seconds: 8)}) async {
  if (src == null || src.isEmpty) return null;
  final ImageProvider provider;
  if (src.startsWith('data:')) {
    final m = AvatarImage.memoryImageOf(src);
    if (m == null) return null;
    provider = m;
  } else if (src.startsWith('https://') || src.startsWith('http://')) {
    provider = CachedNetworkImageProvider(src);
  } else {
    return null;
  }
  final done = Completer<ui.Image?>();
  final stream = provider.resolve(const ImageConfiguration(size: Size(96, 96)));
  late final ImageStreamListener listener;
  listener = ImageStreamListener(
    (info, _) {
      if (!done.isCompleted) done.complete(info.image.clone());
      info.dispose();
    },
    onError: (_, _) {
      if (!done.isCompleted) done.complete(null);
    },
  );
  stream.addListener(listener);
  try {
    return await done.future.timeout(timeout, onTimeout: () => null);
  } finally {
    stream.removeListener(listener);
  }
}
