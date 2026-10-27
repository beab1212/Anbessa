// The person's own position: a blue dot with a heading cone (the raster engine also draws the
// accuracy circle).

import 'dart:math';

import 'package:flutter/material.dart';
import 'package:latlong2/latlong.dart' show LatLng;
import 'package:ride_app_core/ride_app_core.dart';

@immutable
class MePose {
  const MePose({required this.position, this.heading, this.accuracy});
  final LatLng position;
  final double? heading;
  /// metres
  final double? accuracy;
}

class MeDot extends StatelessWidget {
  const MeDot({super.key, this.heading});
  final double? heading;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Semantics(
      label: 'me',
      child: Stack(
        alignment: Alignment.center,
        children: [
          if (heading != null)
            Transform.rotate(
              angle: heading! * pi / 180,
              child: CustomPaint(size: const Size(48, 48), painter: _ConePainter(c.info)),
            ),
          Container(
            width: 20,
            height: 20,
            decoration: BoxDecoration(color: c.info, shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 3), boxShadow: const [BoxShadow(color: Color(0x44000000), blurRadius: 6, offset: Offset(0, 2))]),
          ),
        ],
      ),
    );
  }
}

class _ConePainter extends CustomPainter {
  const _ConePainter(this.color);
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    final cx = size.width / 2, cy = size.height / 2;
    final path = Path()
      ..moveTo(cx, cy)
      ..lineTo(cx - 11, cy - 22)
      ..quadraticBezierTo(cx, cy - 27, cx + 11, cy - 22)
      ..close();
    canvas.drawPath(path, Paint()..shader = RadialGradient(colors: [color.withValues(alpha: 0.55), color.withValues(alpha: 0)], radius: 0.8).createShader(Rect.fromCircle(center: Offset(cx, cy), radius: 26)));
  }

  @override
  bool shouldRepaint(_ConePainter old) => old.color != color;
}
