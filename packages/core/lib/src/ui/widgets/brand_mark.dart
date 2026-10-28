import 'package:flutter/widgets.dart';
import 'package:flutter_svg/flutter_svg.dart';

/// The Anbessa app icon ("Lion Grille": a car front whose headlights, nose and grille read as a
/// lion's face) on its amber rounded square. Same artwork as the launcher icons
/// (assets/brand/anbessa_icon.svg).
class AnbessaMark extends StatelessWidget {
  const AnbessaMark({super.key, this.size = 40});
  final double size;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
        child: SvgPicture.asset(
          'assets/brand/anbessa_icon.svg',
          package: 'ride_app_core',
          width: size,
          height: size,
        ),
      );
}

/// The icon's glyph drawn on a [Canvas] part by part, so an animation can show each part on
/// its own (the phone app's splash). The same shapes and coordinates as
/// assets/brand/anbessa_icon.svg (a 1024 square; the shapes sit under its translate(0,-37));
/// a test checks they stay in sync, so change both together.
abstract final class LionGrilleArt {
  /// the icon's side, in its own coordinates
  static const size = 1024.0;
  /// the amber square's corner radius in the master
  static const cornerRadius = 230.0;
  /// the glyph's shift inside the square (the SVG's translate)
  static const shiftY = -37.0;

  static const amber = Color(0xFFFFB300);
  static const ink = Color(0xFF17191D);
  static const cream = Color(0xFFFFE7A3);
  static const paper = Color(0xFFF6F5F1);

  /// the roof and pillars (ink)
  static const roofPath = 'M332 496 L382 330 Q394 292 434 292 L590 292 Q630 292 642 330 L692 496 Z';
  /// the windshield (cream)
  static const windshieldPath = 'M384 470 L420 352 Q426 334 446 334 L578 334 Q598 334 604 352 L640 470 Z';
  /// the body (ink): x, y, width, height, corner radius
  static const body = (232.0, 470.0, 560.0, 262.0, 96.0);
  /// the two wheels (ink), like [body]
  static const wheels = [(286.0, 700.0, 112.0, 106.0, 30.0), (626.0, 700.0, 112.0, 106.0, 30.0)];
  /// the headlights (paper) — the lion's eyes
  static const headlights = [Offset(340, 580), Offset(684, 580)];
  static const headlightRadius = 56.0;
  /// the pupils (ink), toward the centre and up
  static const pupils = [Offset(352, 568), Offset(672, 568)];
  static const pupilRadius = 22.0;
  /// the nose (amber)
  static const nosePath = 'M466 566 L558 566 L512 622 Z';
  /// the grille's smile (amber), as SVG polygon points
  static const grillePoints =
      '448.0,652.0 453.6,657.2 459.2,661.6 464.8,665.0 470.2,667.6 475.6,669.2 481.0,670.0 486.3,669.9 491.6,668.9 496.8,667.0 501.9,664.2 507.0,660.6 512.0,656.0 517.0,660.6 522.1,664.2 527.2,667.0 532.4,668.9 537.7,669.9 543.0,670.0 548.4,669.2 553.8,667.6 559.2,665.0 564.8,661.6 570.4,657.2 576.0,652.0 576.0,668.0 570.4,673.5 564.8,678.2 559.2,681.9 553.8,684.7 548.4,686.5 543.0,687.5 537.7,687.5 532.4,686.7 527.2,684.9 522.1,682.2 517.0,678.5 512.0,674.0 507.0,678.5 501.9,682.2 496.8,684.9 491.6,686.7 486.3,687.5 481.0,687.5 475.6,686.5 470.2,684.7 464.8,681.9 459.2,678.2 453.6,673.5 448.0,668.0';

  static final Path roof = _svgPath(roofPath);
  static final Path windshield = _svgPath(windshieldPath);
  static final Path nose = _svgPath(nosePath);
  static final Path grille = _polygon(grillePoints);

  static RRect _rrect((double, double, double, double, double) r) => RRect.fromLTRBR(r.$1, r.$2, r.$1 + r.$3, r.$2 + r.$4, Radius.circular(r.$5));

  /// Draws the glyph (no amber square) in the icon's 1024 coordinates; scale the canvas first.
  /// Each part's opacity is its own: [lights] the headlights, [windshieldOpacity], [noseOpacity],
  /// [grilleOpacity]. The ink silhouette (roof, body, wheels, pupils) is always drawn.
  /// [underLights] paints between the body and the headlights (already shifted like the glyph).
  static void paintGlyph(
    Canvas canvas, {
    double lights = 1,
    double windshieldOpacity = 1,
    double noseOpacity = 1,
    double grilleOpacity = 1,
    void Function(Canvas canvas)? underLights,
  }) {
    final p = Paint()..isAntiAlias = true;
    Paint fill(Color c, [double opacity = 1]) => p..color = c.withValues(alpha: c.a * opacity.clamp(0.0, 1.0));
    canvas.save();
    canvas.translate(0, shiftY);
    canvas.drawPath(roof, fill(ink));
    if (windshieldOpacity > 0) canvas.drawPath(windshield, fill(cream, windshieldOpacity));
    canvas.drawRRect(_rrect(body), fill(ink));
    for (final w in wheels) {
      canvas.drawRRect(_rrect(w), fill(ink));
    }
    underLights?.call(canvas);
    if (lights > 0) {
      for (final h in headlights) {
        canvas.drawCircle(h, headlightRadius, fill(paper, lights));
      }
    }
    for (final e in pupils) {
      canvas.drawCircle(e, pupilRadius, fill(ink));
    }
    if (noseOpacity > 0) canvas.drawPath(nose, fill(amber, noseOpacity));
    if (grilleOpacity > 0) canvas.drawPath(grille, fill(amber, grilleOpacity));
    canvas.restore();
  }

  /// The few SVG path commands the master uses: M, L, Q (absolute) and Z.
  static Path _svgPath(String d) {
    final path = Path();
    final tokens = RegExp(r'[MLQZ]|-?\d+(?:\.\d+)?').allMatches(d).map((m) => m[0]!).toList();
    var i = 0;
    double n() => double.parse(tokens[i++]);
    while (i < tokens.length) {
      switch (tokens[i++]) {
        case 'M':
          path.moveTo(n(), n());
        case 'L':
          path.lineTo(n(), n());
        case 'Q':
          path.quadraticBezierTo(n(), n(), n(), n());
        case 'Z':
          path.close();
        case final t:
          throw FormatException('unsupported path token $t', d);
      }
    }
    return path;
  }

  static Path _polygon(String points) {
    final xy = [for (final pair in points.trim().split(RegExp(r'\s+'))) pair.split(',').map(double.parse).toList()];
    return Path()..addPolygon([for (final q in xy) Offset(q[0], q[1])], true);
  }
}
