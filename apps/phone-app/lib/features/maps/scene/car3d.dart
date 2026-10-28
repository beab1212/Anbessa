// The car on the 3D map: a small low-poly car (body, cabin with dark glass, wheels, lights, a soft
// shadow) seen from the tilted camera, painted once per [car3dFrames] directions. A flat top-down
// image lying on a tilted map reads as a paper cut-out; these frames stand up like a car does.
//
// The native layer shows them upright facing the screen (viewport aligned) and picks, per car, the
// frame for its heading relative to the camera's bearing, so a car turning, or the map turning
// under it, steps through the frames (every 10°).
//
// Drawing order instead of a depth buffer: the shadow, then the wheels (entirely under the body's
// floor), then the body (two stacked slabs), its lights, then the cabin (entirely above the
// body's roof line). From a camera above the car, a part lower down can only be covered by a part
// higher up, so this order is exact; within a convex part, back faces are culled and the
// remaining faces never overlap.

import 'dart:math';
import 'dart:ui';

import 'scene_images.dart' show SceneImage, carImageWidth;

/// Directions painted: one frame every 360 / [car3dFrames] degrees.
const car3dFrames = 36;

/// The camera tilt the frames are drawn for (the 3D map's and navigation's tilt).
const car3dPitch = 55.0;

/// The car's width in model units (metres): its frames are scaled so this is [carImageWidth]
/// logical pixels, like the flat car's image, so both share the zoom-dependent sizes.
const _carWidth = 1.86;

/// Half the side of a frame, in model units: the car turned any way, with its roof and shadow.
const _half = 2.9;

/// The logical side of a frame.
double get car3dImageSize => _half * 2 * carImageWidth / _carWidth;

/// The frame for a car heading [heading] (degrees, clockwise from north) on a map turned to
/// [viewBearing]: 0 is a car driving away from the viewer, up the screen.
int car3dFrameFor(double heading, double viewBearing) {
  final rel = ((heading - viewBearing) % 360 + 360) % 360;
  return (rel / (360 / car3dFrames)).round() % car3dFrames;
}

/// The image id of a frame.
String car3dImageId(int frame) => 'anb-car3d-$frame';

typedef _V = (double x, double y, double z);

class _Face {
  const _Face(this.points, this.color, {this.outline = true});
  final List<_V> points;
  final Color color;
  final bool outline;
}

/// A prism between two horizontal outlines (the same number of points, counter-clockwise seen
/// from above): its side quads and its top. The bottom never faces a camera above it.
List<_Face> _prism(List<(double, double)> bottom, double z0, List<(double, double)> top, double z1, {required Color side, required Color roof, Color? front, Color? back}) {
  final faces = <_Face>[];
  final n = bottom.length;
  for (var i = 0; i < n; i++) {
    final j = (i + 1) % n;
    final b0 = bottom[i], b1 = bottom[j], t0 = top[i], t1 = top[j];
    // which way this side faces, to colour the windscreen and rear window
    final ny = (b0.$1 - b1.$1);
    final nx = (b1.$2 - b0.$2);
    final facing = atan2(nx, ny);
    var color = side;
    if (front != null && cos(facing) > 0.85) color = front;
    if (back != null && cos(facing) < -0.85) color = back;
    faces.add(_Face([(b0.$1, b0.$2, z0), (b1.$1, b1.$2, z0), (t1.$1, t1.$2, z1), (t0.$1, t0.$2, z1)], color));
  }
  faces.add(_Face([for (final t in top) (t.$1, t.$2, z1)], roof));
  return faces;
}

/// A rectangle with its four corners cut by [c], counter-clockwise from above.
List<(double, double)> _chamfered(double hw, double hl, double c) => [
      (hw, -hl + c), (hw, hl - c), (hw - c, hl), (-hw + c, hl),
      (-hw, hl - c), (-hw, -hl + c), (-hw + c, -hl), (hw - c, -hl),
    ];

List<(double, double)> _rect(double x0, double x1, double y0, double y1) => [(x1, y0), (x1, y1), (x0, y1), (x0, y0)];

/// The car's parts in drawing order (see the file comment); [body] is its paint colour.
List<List<_Face>> _model(Color body) {
  const tyre = Color(0xFF202328);
  const skirt = Color(0xFFC9CDD3);
  const glass = Color(0xFF323944);
  const glassFront = Color(0xFF39414C);
  const head = Color(0xFFFFF1BF);
  const tail = Color(0xFFE5484D);
  const hw = 0.93, hl = 2.26;
  final wheels = <_Face>[
    for (final sx in const [-1.0, 1.0])
      for (final cy in const [-1.42, 1.42])
        ..._prism(_rect(sx > 0 ? 0.74 : -0.97, sx > 0 ? 0.97 : -0.74, cy - 0.36, cy + 0.36), 0, _rect(sx > 0 ? 0.74 : -0.97, sx > 0 ? 0.97 : -0.74, cy - 0.36, cy + 0.36), 0.3, side: tyre, roof: tyre),
  ];
  final lower = _prism(_chamfered(hw, hl, 0.34), 0.3, _chamfered(hw, hl, 0.34), 0.52, side: skirt, roof: skirt);
  final upper = _prism(_chamfered(hw, hl, 0.34), 0.52, _chamfered(hw - 0.05, hl - 0.08, 0.42), 0.9, side: body, roof: body);
  // counter-clockwise as seen from outside: from the front the viewer's right is -x
  final lights = <_Face>[
    for (final (lo, hi) in const [(0.22, 0.56), (-0.56, -0.22)]) ...[
      _Face([(hi, hl + 0.01, 0.62), (lo, hl + 0.01, 0.62), (lo, hl + 0.01, 0.78), (hi, hl + 0.01, 0.78)], head, outline: false),
      _Face([(lo, -hl - 0.01, 0.62), (hi, -hl - 0.01, 0.62), (hi, -hl - 0.01, 0.76), (lo, -hl - 0.01, 0.76)], tail, outline: false),
    ],
  ];
  final cabin = _prism(
    _rect(-0.84, 0.84, -1.42, 0.72), 0.9,
    _rect(-0.66, 0.66, -1.0, 0.24), 1.42,
    side: glass, roof: body, front: glassFront, back: glass,
  );
  return [wheels, lower, upper, lights, cabin];
}

/// The light, from the upper left and a little ahead on the screen, so every frame is lit alike.
const _light = (-0.42, 0.4, 0.81);

/// One frame: the car for frame [frame], painted [scale] times larger than shown.
SceneImage car3dImage(int frame, double scale, {Color body = const Color(0xFFFFFFFF)}) {
  final size = car3dImageSize;
  final px = (size * scale).ceil();
  return (width: px, height: px, paint: (canvas) => paintCar3d(canvas, frame, size * scale, body: body));
}

/// Paints frame [frame] centred in a [side] × [side] square: the car's ground centre at the
/// centre (the layer anchors the image there).
void paintCar3d(Canvas canvas, int frame, double side, {Color body = const Color(0xFFFFFFFF)}) {
  final yaw = frame * 2 * pi / car3dFrames;
  final pitch = car3dPitch * pi / 180;
  final u = side / (_half * 2);
  final cy = cos(yaw), sy = sin(yaw), cp = cos(pitch), sp = sin(pitch);
  final centre = Offset(side / 2, side / 2);

  // turned clockwise by the frame's direction (0: driving up the screen)
  _V turn(_V v) => (v.$1 * cy + v.$2 * sy, -v.$1 * sy + v.$2 * cy, v.$3);
  Offset project(_V v) {
    final t = turn(v);
    return centre + Offset(t.$1, -(t.$2 * cp + t.$3 * sp)) * u;
  }

  // shadow: the footprint on the ground, blurred
  final shadow = Path()..addPolygon([for (final p in _chamfered(1.02, 2.36, 0.5)) project((p.$1, p.$2, 0))], true);
  canvas.drawPath(shadow, Paint()
    ..color = const Color(0x52000000)
    ..maskFilter = MaskFilter.blur(BlurStyle.normal, 0.22 * u));

  final edge = Paint()
    ..style = PaintingStyle.stroke
    ..strokeWidth = max(0.6, 0.035 * u)
    ..strokeJoin = StrokeJoin.round
    ..color = const Color(0x2E000000);
  for (final part in _model(body)) {
    final visible = <(_Face, double, _V)>[];
    for (final f in part) {
      final n = _normal([for (final p in f.points) turn(p)]);
      // towards the camera: up the screen's depth (-y) and up (z)
      if (-n.$2 * sp + n.$3 * cp <= 1e-6) continue;
      final depth = f.points.map((p) {
        final t = turn(p);
        return t.$2 * sp - t.$3 * cp;
      }).reduce((a, b) => a + b) / f.points.length;
      visible.add((f, depth, n));
    }
    visible.sort((a, b) => b.$2.compareTo(a.$2));
    for (final (f, _, n) in visible) {
      final lambert = max(0.0, n.$1 * _light.$1 + n.$2 * _light.$2 + n.$3 * _light.$3);
      final shade = 0.6 + 0.4 * lambert;
      final path = Path()..addPolygon([for (final p in f.points) project(p)], true);
      canvas.drawPath(path, Paint()
        ..isAntiAlias = true
        ..color = _shaded(f.color, shade));
      if (f.outline) canvas.drawPath(path, edge);
    }
  }
}

Color _shaded(Color c, double k) => Color.from(alpha: c.a, red: (c.r * k).clamp(0.0, 1.0), green: (c.g * k).clamp(0.0, 1.0), blue: (c.b * k).clamp(0.0, 1.0));

/// The unit normal of a planar polygon (Newell's method), outward for counter-clockwise points
/// seen from outside.
_V _normal(List<_V> pts) {
  var x = 0.0, y = 0.0, z = 0.0;
  for (var i = 0; i < pts.length; i++) {
    final a = pts[i], b = pts[(i + 1) % pts.length];
    x += (a.$2 - b.$2) * (a.$3 + b.$3);
    y += (a.$3 - b.$3) * (a.$1 + b.$1);
    z += (a.$1 - b.$1) * (a.$2 + b.$2);
  }
  final l = sqrt(x * x + y * y + z * z);
  return l == 0 ? (0.0, 0.0, 1.0) : (x / l, y / l, z / l);
}
