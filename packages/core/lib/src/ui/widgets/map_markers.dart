// Map marker art from the GoRide kit, our own drawings: the person's avatar in an amber ring with
// a tail, the red destination ring pin, a top-down car (white body, dark glass) and the
// "searching" radar rings. Each marker is a painter function first, so the map engine can
// rasterise it for a native symbol layer (markerPngBytes / markerImage), and a widget second,
// for overlays and screens.

import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';
import 'avatar_image.dart';

/// Paints [paint] onto a [logical]-sized canvas at [pixelRatio] and returns the picture.
Future<ui.Image> markerImage(Size logical, void Function(Canvas canvas, Size size) paint, {double pixelRatio = 3}) {
  final rec = ui.PictureRecorder();
  final canvas = Canvas(rec);
  canvas.scale(pixelRatio);
  paint(canvas, logical);
  final pic = rec.endRecording();
  return pic.toImage((logical.width * pixelRatio).ceil(), (logical.height * pixelRatio).ceil()).whenComplete(pic.dispose);
}

/// [markerImage] encoded as PNG bytes (for `addImage` on a map style).
Future<Uint8List> markerPngBytes(Size logical, void Function(Canvas canvas, Size size) paint, {double pixelRatio = 3}) async {
  final img = await markerImage(logical, paint, pixelRatio: pixelRatio);
  try {
    final data = await img.toByteData(format: ui.ImageByteFormat.png);
    return data!.buffer.asUint8List();
  } finally {
    img.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Avatar pin

/// A circle of radius [r] at [center] joined with a tail whose tip is at ([center].dx, [tipY]).
Path _pinPath(Offset center, double r, double tipY, double halfWidth) {
  final tail = Path()
    ..moveTo(center.dx - r * halfWidth, center.dy + r * 0.85)
    ..lineTo(center.dx, tipY)
    ..lineTo(center.dx + r * halfWidth, center.dy + r * 0.85)
    ..close();
  return Path.combine(PathOperation.union, Path()..addOval(Rect.fromCircle(center: center, radius: r)), tail);
}

/// The logical size of an avatar pin whose circle is [diameter] wide (the tail adds below).
Size avatarPinSize(double diameter) => Size(diameter, diameter * 1.22);

/// An avatar pin: a [ring]-coloured circle with a tail pointing down to the spot, the [photo]
/// (or [initials] on [fill]) inside. The tip is at the bottom centre of [size].
void paintAvatarPin(Canvas canvas, Size size, {required Color ring, ui.Image? photo, String? initials, Color fill = const Color(0xFFFFF4D6), Color initialsColor = const Color(0xFF17191D), bool shadow = true}) {
  final d = size.width;
  final r = d / 2;
  final center = Offset(r, r);
  final body = _pinPath(center, r, size.height, 0.42);
  if (shadow) {
    canvas.drawPath(body.shift(const Offset(0, 1.5)), Paint()
      ..color = const Color(0x40000000)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 2.5));
  }
  canvas.drawPath(body, Paint()..color = ring);
  final inner = r * 0.78;
  final innerRect = Rect.fromCircle(center: center, radius: inner);
  if (photo != null) {
    canvas.save();
    canvas.clipPath(Path()..addOval(innerRect));
    final src = Rect.fromLTWH(0, 0, photo.width.toDouble(), photo.height.toDouble());
    // cover: the centred square of the photo
    final side = math.min(src.width, src.height);
    final square = Rect.fromCenter(center: src.center, width: side, height: side);
    canvas.drawImageRect(photo, square, innerRect, Paint()..filterQuality = FilterQuality.medium);
    canvas.restore();
  } else {
    canvas.drawCircle(center, inner, Paint()..color = fill);
    if (initials != null && initials.isNotEmpty) {
      final tp = TextPainter(
        text: TextSpan(text: initials, style: TextStyle(color: initialsColor, fontSize: inner * 0.8, fontWeight: FontWeight.w700, fontFamily: anbessaFontFamily)),
        textDirection: TextDirection.ltr,
      )..layout();
      tp.paint(canvas, center - Offset(tp.width / 2, tp.height / 2));
    }
  }
}

/// The person on the map: their avatar in an amber ring with a tail (the kit's user pin).
class MapAvatarPin extends StatelessWidget {
  const MapAvatarPin({super.key, this.photo, required this.name, this.diameter = 52, this.ringColor});
  /// a data URL or https URL (see AvatarImage)
  final String? photo;
  final String name;
  final double diameter;
  final Color? ringColor;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final size = avatarPinSize(diameter);
    final inner = diameter * 0.78;
    return Semantics(
      label: name,
      child: SizedBox.fromSize(
        size: size,
        child: Stack(
          children: [
            Positioned.fill(child: CustomPaint(painter: _AvatarPinPainter(ringColor ?? c.accent))),
            Positioned(
              left: (diameter - inner) / 2,
              top: (diameter - inner) / 2,
              // a light face under the avatar, so initials read on the ring in both themes
              child: DecoratedBox(decoration: const BoxDecoration(shape: BoxShape.circle, color: Color(0xFFFFF4D6)), child: AvatarImage(src: photo, name: name, size: inner)),
            ),
          ],
        ),
      ),
    );
  }
}

class _AvatarPinPainter extends CustomPainter {
  _AvatarPinPainter(this.ring);
  final Color ring;
  @override
  void paint(Canvas canvas, Size size) => paintAvatarPin(canvas, size, ring: ring, fill: ring);
  @override
  bool shouldRepaint(_AvatarPinPainter o) => o.ring != ring;
}

// ---------------------------------------------------------------------------------------------
// Destination pin

/// The logical size of a destination pin [diameter] wide.
Size destinationPinSize(double diameter) => Size(diameter, diameter * 1.25);

/// The destination: a red ring with a white face and a red dot (or a [photo]), a tail to the spot.
void paintDestinationPin(Canvas canvas, Size size, {Color color = const Color(0xFFE5343F), ui.Image? photo, bool shadow = true}) {
  final r = size.width / 2;
  final center = Offset(r, r);
  final body = _pinPath(center, r, size.height, 0.45);
  if (shadow) {
    canvas.drawPath(body.shift(const Offset(0, 1.5)), Paint()
      ..color = const Color(0x40000000)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 2.5));
  }
  canvas.drawPath(body, Paint()..color = color);
  final inner = r * 0.72;
  canvas.drawCircle(center, inner, Paint()..color = const Color(0xFFFFFFFF));
  if (photo != null) {
    final rect = Rect.fromCircle(center: center, radius: inner * 0.9);
    canvas.save();
    canvas.clipPath(Path()..addOval(rect));
    final src = Rect.fromLTWH(0, 0, photo.width.toDouble(), photo.height.toDouble());
    final side = math.min(src.width, src.height);
    canvas.drawImageRect(photo, Rect.fromCenter(center: src.center, width: side, height: side), rect, Paint());
    canvas.restore();
  } else {
    canvas.drawCircle(center, inner * 0.42, Paint()..color = color);
  }
}

/// The red destination ring pin.
class DestinationPin extends StatelessWidget {
  const DestinationPin({super.key, this.diameter = 40, this.color, this.semanticLabel});
  final double diameter;
  /// defaults to the palette's danger red
  final Color? color;
  final String? semanticLabel;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Semantics(
      label: semanticLabel,
      child: CustomPaint(size: destinationPinSize(diameter), painter: _DestinationPainter(color ?? c.danger)),
    );
  }
}

class _DestinationPainter extends CustomPainter {
  _DestinationPainter(this.color);
  final Color color;
  @override
  void paint(Canvas canvas, Size size) => paintDestinationPin(canvas, size, color: color);
  @override
  bool shouldRepaint(_DestinationPainter o) => o.color != color;
}

// ---------------------------------------------------------------------------------------------
// Top-down car

/// The logical size of a top-down car [width] wide (it points up, north).
Size topDownCarSize(double width) => Size(width, width * 2.05);

/// A car seen from above, pointing up: a rounded [body] (white by default) with mirrors, dark
/// [glass] (windscreen, side and rear windows), a lighter roof, headlights. Rotate it on the map.
void paintTopDownCar(Canvas canvas, Size size, {Color body = const Color(0xFFFFFFFF), Color glass = const Color(0xFF2B2F36), Color outline = const Color(0x33000000), bool shadow = true}) {
  final w = size.width, h = size.height;
  // mirrors poke out beyond the body
  final inset = w * 0.1;
  final bodyRect = Rect.fromLTWH(inset, 0, w - inset * 2, h);
  final bw = bodyRect.width;
  final shape = RRect.fromRectAndCorners(
    bodyRect,
    topLeft: Radius.elliptical(bw * 0.42, bw * 0.5),
    topRight: Radius.elliptical(bw * 0.42, bw * 0.5),
    bottomLeft: Radius.elliptical(bw * 0.3, bw * 0.3),
    bottomRight: Radius.elliptical(bw * 0.3, bw * 0.3),
  );
  if (shadow) {
    canvas.drawRRect(shape.shift(Offset(0, h * 0.02)), Paint()
      ..color = const Color(0x55000000)
      ..maskFilter = MaskFilter.blur(BlurStyle.normal, w * 0.12));
  }
  // mirrors
  final mirror = Paint()..color = body;
  canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(0, h * 0.3, inset + 2, h * 0.05), Radius.circular(w * 0.04)), mirror);
  canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(w - inset - 2, h * 0.3, inset + 2, h * 0.05), Radius.circular(w * 0.04)), mirror);
  canvas.drawRRect(shape, Paint()..color = body);
  canvas.drawRRect(shape.deflate(0.5), Paint()
    ..color = outline
    ..style = PaintingStyle.stroke
    ..strokeWidth = 1);
  final l = bodyRect.left, cx = bodyRect.center.dx;
  final g = Paint()..color = glass;
  // windscreen
  canvas.drawPath(
    Path()
      ..moveTo(l + bw * 0.1, h * 0.36)
      ..quadraticBezierTo(cx, h * 0.25, l + bw * 0.9, h * 0.36)
      ..lineTo(l + bw * 0.8, h * 0.45)
      ..quadraticBezierTo(cx, h * 0.42, l + bw * 0.2, h * 0.45)
      ..close(),
    g,
  );
  // rear window
  canvas.drawPath(
    Path()
      ..moveTo(l + bw * 0.2, h * 0.76)
      ..quadraticBezierTo(cx, h * 0.78, l + bw * 0.8, h * 0.76)
      ..lineTo(l + bw * 0.88, h * 0.85)
      ..quadraticBezierTo(cx, h * 0.89, l + bw * 0.12, h * 0.85)
      ..close(),
    g,
  );
  // side windows
  final side = Paint()..color = glass.withValues(alpha: 0.85);
  canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTRB(l + bw * 0.06, h * 0.47, l + bw * 0.13, h * 0.74), Radius.circular(bw * 0.04)), side);
  canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTRB(l + bw * 0.87, h * 0.47, l + bw * 0.94, h * 0.74), Radius.circular(bw * 0.04)), side);
  // roof highlight
  canvas.drawRRect(
    RRect.fromRectAndRadius(Rect.fromLTRB(l + bw * 0.2, h * 0.47, l + bw * 0.8, h * 0.74), Radius.circular(bw * 0.1)),
    Paint()..color = Color.lerp(body, const Color(0xFF000000), 0.05)!,
  );
  // headlights and tail lights
  final head = Paint()..color = const Color(0xFFFFF1C2);
  canvas.drawOval(Rect.fromCenter(center: Offset(l + bw * 0.24, h * 0.035), width: bw * 0.22, height: h * 0.025), head);
  canvas.drawOval(Rect.fromCenter(center: Offset(l + bw * 0.76, h * 0.035), width: bw * 0.22, height: h * 0.025), head);
  final tail = Paint()..color = const Color(0xFFE5343F);
  canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromCenter(center: Offset(l + bw * 0.2, h * 0.975), width: bw * 0.2, height: h * 0.02), const Radius.circular(1)), tail);
  canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromCenter(center: Offset(l + bw * 0.8, h * 0.975), width: bw * 0.2, height: h * 0.02), const Radius.circular(1)), tail);
}

/// A top-down car, pointing up, turned by [heading] degrees clockwise.
class TopDownCar extends StatelessWidget {
  const TopDownCar({super.key, this.width = 22, this.heading = 0, this.body, this.glass});
  final double width;
  final double heading;
  final Color? body;
  final Color? glass;
  @override
  Widget build(BuildContext context) => ExcludeSemantics(
        child: Transform.rotate(
          angle: heading * math.pi / 180,
          child: CustomPaint(size: topDownCarSize(width), painter: _CarPainter(body ?? Colors.white, glass ?? const Color(0xFF2B2F36))),
        ),
      );
}

class _CarPainter extends CustomPainter {
  _CarPainter(this.body, this.glass);
  final Color body;
  final Color glass;
  @override
  void paint(Canvas canvas, Size size) => paintTopDownCar(canvas, size, body: body, glass: glass);
  @override
  bool shouldRepaint(_CarPainter o) => o.body != body || o.glass != glass;
}

// ---------------------------------------------------------------------------------------------
// Radar rings

/// Concentric translucent amber circles around [child] ("Searching your location…", "Finding you
/// a nearby driver…"): two still rings and a wave that keeps growing and fading out. Still when
/// motion is reduced.
class RadarRings extends StatefulWidget {
  const RadarRings({super.key, this.size = 240, this.color, this.child, this.period = const Duration(milliseconds: 2400)});
  final double size;
  /// defaults to amber
  final Color? color;
  /// in the middle (an avatar)
  final Widget? child;
  final Duration period;
  @override
  State<RadarRings> createState() => _RadarRingsState();
}

class _RadarRingsState extends State<RadarRings> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: widget.period);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (AnbessaMotion.reduced(context)) {
      _c.stop();
      _c.value = 0.5;
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.color ?? context.colors.accent;
    return ExcludeSemantics(
      excluding: widget.child == null,
      child: SizedBox.square(
        dimension: widget.size,
        child: RepaintBoundary(
          child: CustomPaint(
            painter: _RadarPainter(_c, color),
            child: widget.child == null ? null : Center(child: widget.child),
          ),
        ),
      ),
    );
  }
}

class _RadarPainter extends CustomPainter {
  _RadarPainter(this.t, this.color) : super(repaint: t);
  final Animation<double> t;
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final maxR = size.shortestSide / 2;
    // still rings: outer pale, inner stronger
    canvas.drawCircle(c, maxR * 0.72, Paint()..color = color.withValues(alpha: 0.16));
    canvas.drawCircle(c, maxR * 0.44, Paint()..color = color.withValues(alpha: 0.28));
    // two waves, half a period apart
    for (final phase in const [0.0, 0.5]) {
      final v = (t.value + phase) % 1.0;
      final r = maxR * (0.3 + 0.7 * Curves.easeOut.transform(v));
      canvas.drawCircle(c, r, Paint()..color = color.withValues(alpha: 0.22 * (1 - v)));
    }
  }

  @override
  bool shouldRepaint(_RadarPainter o) => o.color != color;
}

/// The small "you are here" target: an amber dot in a pale ring (under "Searching your location…").
class LocatingDot extends StatelessWidget {
  const LocatingDot({super.key, this.size = 40});
  final double size;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ExcludeSemantics(
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: c.accent, width: 2), color: c.accent.withValues(alpha: 0.12)),
        alignment: Alignment.center,
        child: Container(width: size * 0.5, height: size * 0.5, decoration: BoxDecoration(shape: BoxShape.circle, color: c.accent)),
      ),
    );
  }
}
