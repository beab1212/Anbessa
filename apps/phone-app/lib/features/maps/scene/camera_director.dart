// One place for camera decisions, for both map engines (each gives it a CameraPort).
//
// Modes:
//   - free: the camera stays where the person (or the last move) left it
//   - overview(points): the points fit in the part of the map not covered by the insets; fitted
//     only on explicit overview() calls and when the insets settle, never per frame
//   - follow(subject): centred on the subject, north up, at the follow zoom
//   - navigate(subject): turned the way the subject goes, tilted, the subject in the lower third
//     of the free area, zoomed by speed (17.5 at walking pace → 15.5 at 80 km/h)
// Follow and navigate move the camera on each new subject sample, with an animation about as
// long as the gap since the last move (300–1000 ms), so a camera move chains into the next and
// the camera glides with the car. The subject is a ValueListenable (an animator), never a
// widget rebuild.
//
// An animated car (everyFrame) is followed frame by frame instead: the camera jumps to the very
// pose the car is drawn at on each animation frame, so the car stays put on the screen. Chained
// eased moves speed up and slow down around a car that moves evenly, which reads as the car
// floating about, the more the closer the map is zoomed. Entering the mode, recentring and inset
// changes blend from where the camera was over [transition]; the navigation zoom and the padding
// follow their targets smoothly over time rather than per call.
//
// Any gesture by the person switches to free and raises [showRecenter]; recenter() goes back to
// the mode the gesture interrupted.

import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart' show EdgeInsets, Size;
import 'package:ride_app_core/ride_app_core.dart';
import '../marker_animator.dart';

enum CameraModeKind { free, overview, follow, navigate }

/// Where a camera looks.
typedef CameraView = ({GeoPoint center, double zoom, double bearing, double pitch});

/// What the director asks of a map engine.
abstract interface class CameraPort {
  /// The map's size in logical pixels (null before layout).
  Size? get viewport;

  /// The camera's bearing now, degrees.
  double get bearing;

  /// What the camera shows now (null before the map has a camera).
  CameraView? get current;

  /// Move the camera; [duration] zero moves at once. Cancelled moves are ignored.
  Future<void> moveTo({required GeoPoint center, required double zoom, required double bearing, required double pitch, required EdgeInsets padding, required Duration duration});

  /// Show [points] inside [padding], never closer than [maxZoom] (or [singleZoom] for one point).
  Future<void> fit(List<GeoPoint> points, {required EdgeInsets padding, required double bearing, required double pitch, required Duration duration, double maxZoom, double singleZoom});

  /// The engine moves the camera itself on every subject change (cheap Dart moves): no chaining.
  bool get followsEveryFrame;
}

/// Navigation zoom for a speed in m/s: 17.5 up to 20 km/h, 15.5 from 80 km/h, linear between.
double navZoomForSpeed(double metersPerSecond) {
  final kmh = metersPerSecond * 3.6;
  if (kmh <= 20) return 17.5;
  if (kmh >= 80) return 15.5;
  return 17.5 - (kmh - 20) / 60 * 2;
}

/// The tilt while navigating: 55° in 3D, 45° on the flat and satellite maps (the road ahead
/// stays visible); the raster engine can't tilt and ignores it.
double navPitchFor({required bool threeD}) => threeD ? 55 : 45;

/// Padding that puts the subject at two thirds of the free height (the road ahead above it).
EdgeInsets lowerThirdPadding(Size viewport, EdgeInsets insets) {
  final free = max(0.0, viewport.height - insets.top - insets.bottom);
  return EdgeInsets.fromLTRB(insets.left, insets.top + free / 3, insets.right, insets.bottom);
}

/// The duration of a chained follow move: the gap since the last move, 300–1000 ms.
Duration followMoveDuration(Duration sinceLast) {
  final ms = sinceLast.inMilliseconds.clamp(300, 1000);
  return Duration(milliseconds: ms);
}

class CameraDirector {
  CameraDirector({
    required this.port,
    DateTime Function()? now,
    this.cadence = const Duration(milliseconds: 300),
    this.settleDelay = const Duration(milliseconds: 250),
    this.transition = const Duration(milliseconds: 500),
  }) : _now = now ?? DateTime.now;

  final CameraPort port;
  final DateTime Function() _now;
  /// the shortest time between two chained follow moves
  final Duration cadence;
  /// how long the insets must stay still before a refit
  final Duration settleDelay;
  /// the length of a move into a new mode
  final Duration transition;

  CameraModeKind _mode = CameraModeKind.free;
  CameraModeKind get mode => _mode;

  // what the current (or interrupted) mode works with
  List<GeoPoint> _points = const [];
  ValueListenable<AnimatedPose?>? _subject;
  double _followZoom = 16;
  CameraModeKind? _resume;

  EdgeInsets _insets = EdgeInsets.zero;
  EdgeInsets get insets => _insets;
  double _basePitch = 0;
  bool _threeD = false;
  bool _reduceMotion = false;
  double? _navZoom;

  DateTime? _lastMove;
  Timer? _trailing;
  // frame-by-frame following
  bool _everyFrame = false;
  CameraView? _blendFrom;
  DateTime? _blendStart;
  DateTime? _lastFrame;
  EdgeInsets? _padShown;
  double? _zoomShown;
  Timer? _settle;
  bool _disposed = false;

  final _showRecenter = ValueNotifier<bool>(false);
  /// The person moved the map away from what the camera was doing: offer to go back.
  ValueListenable<bool> get showRecenter => _showRecenter;

  /// The mode a gesture interrupted (what recenter() goes back to).
  CameraModeKind? get resumeMode => _resume;

  // ── settings ────────────────────────────────────────────────────────────────

  /// The parts of the map covered by banners (top), the sheet (bottom), plus side room.
  void setInsets(EdgeInsets insets) {
    if (insets == _insets) return;
    _insets = insets;
    _settle?.cancel();
    _settle = Timer(settleDelay, _onSettled);
  }

  void _onSettled() {
    if (_disposed) return;
    switch (_mode) {
      case CameraModeKind.overview:
        _fit(duration: _d(transition));
      case CameraModeKind.follow || CameraModeKind.navigate:
        // frame by frame, the padding glides to the new insets by itself
        if (!_everyFrame) _move(duration: _d(transition));
      case CameraModeKind.free:
        break;
    }
  }

  /// The map's look: its resting tilt (3D), and whether motion should be reduced.
  void setLook({required double basePitch, required bool threeD, bool reduceMotion = false}) {
    final changed = basePitch != _basePitch || threeD != _threeD;
    _basePitch = basePitch;
    _threeD = threeD;
    _reduceMotion = reduceMotion;
    if (!changed) return;
    switch (_mode) {
      case CameraModeKind.overview:
        _fit(duration: _d(transition));
      case CameraModeKind.follow || CameraModeKind.navigate:
        _transition();
      case CameraModeKind.free:
        break;
    }
  }

  Duration _d(Duration d) => _reduceMotion ? Duration.zero : d;

  // ── modes ───────────────────────────────────────────────────────────────────

  /// Fit [points]. With [force] false, a camera the person has moved stays put and the points
  /// become what recenter() shows.
  void overview(List<GeoPoint> points, {bool force = true, bool animate = true}) {
    if (points.isEmpty) return;
    _points = List.of(points);
    _detachSubject();
    if (!force && _mode == CameraModeKind.free && _resume != null) {
      _resume = CameraModeKind.overview;
      return;
    }
    _enter(CameraModeKind.overview);
    _fit(duration: animate ? _d(transition) : Duration.zero);
  }

  /// Keep [subject] centred, north up, at [zoom]. [everyFrame]: the subject is an animated car
  /// that changes on every frame; the camera moves with each of them.
  void follow(ValueListenable<AnimatedPose?> subject, {double zoom = 16, bool animate = true, bool everyFrame = false}) {
    _followZoom = zoom;
    _attachSubject(subject);
    _enter(CameraModeKind.follow, everyFrame: everyFrame);
    _transition(animate: animate);
  }

  /// Drive with [subject]: turned its way, tilted, zoomed by speed.
  void navigate(ValueListenable<AnimatedPose?> subject, {bool animate = true, bool everyFrame = false}) {
    _attachSubject(subject);
    _navZoom = null;
    _zoomShown = null;
    _enter(CameraModeKind.navigate, everyFrame: everyFrame);
    _transition(animate: animate);
  }

  /// Move into the current follow or navigate mode: an animated move, and frame by frame a blend
  /// from where the camera is (the frames take over from the animation as they come).
  void _transition({bool animate = true}) {
    final d = animate ? _d(transition) : Duration.zero;
    if (_everyFrame && d > Duration.zero) {
      _blendFrom = port.current;
      _blendStart = _now();
    } else {
      _blendFrom = _blendStart = null;
    }
    _move(duration: d);
  }

  /// Stop moving the camera (nothing to show, or the screen took over).
  void free() {
    _detachSubject();
    _everyFrame = false;
    _mode = CameraModeKind.free;
    _resume = null;
    _showRecenter.value = false;
  }

  void _enter(CameraModeKind m, {bool everyFrame = false}) {
    _everyFrame = everyFrame;
    _padShown = null;
    _lastFrame = null;
    _mode = m;
    _resume = null;
    _showRecenter.value = false;
  }

  /// The person panned, pinched, turned or tilted the map.
  void onUserGesture() {
    if (_mode == CameraModeKind.free) return;
    _resume = _mode;
    _mode = CameraModeKind.free;
    _trailing?.cancel();
    _trailing = null;
    _showRecenter.value = true;
  }

  /// Go back to what the camera did before the gesture.
  void recenter() {
    final r = _resume;
    _showRecenter.value = false;
    if (r == null) return;
    _resume = null;
    _mode = r;
    switch (r) {
      case CameraModeKind.overview:
        _fit(duration: _d(transition));
      case CameraModeKind.follow:
        _transition();
      case CameraModeKind.navigate:
        _navZoom = null;
        _zoomShown = null;
        _transition();
      case CameraModeKind.free:
        break;
    }
  }

  // ── subject ─────────────────────────────────────────────────────────────────

  void _attachSubject(ValueListenable<AnimatedPose?> s) {
    if (identical(s, _subject)) return;
    _subject?.removeListener(_onSubject);
    _subject = s;
    s.addListener(_onSubject);
  }

  void _detachSubject() {
    _subject?.removeListener(_onSubject);
    _subject = null;
    _trailing?.cancel();
    _trailing = null;
  }

  void _onSubject() {
    if (_disposed || (_mode != CameraModeKind.follow && _mode != CameraModeKind.navigate)) return;
    if (_everyFrame) {
      _frameMove();
      return;
    }
    if (port.followsEveryFrame) {
      _move(duration: Duration.zero);
      return;
    }
    final last = _lastMove;
    final since = last == null ? cadence : _now().difference(last);
    if (since >= cadence) {
      _trailing?.cancel();
      _trailing = null;
      _move(duration: _reduceMotion ? Duration.zero : followMoveDuration(since));
    } else {
      // a move went out a moment ago: send the latest pose when the cadence allows
      _trailing ??= Timer(cadence - since, () {
        _trailing = null;
        if (_disposed || (_mode != CameraModeKind.follow && _mode != CameraModeKind.navigate)) return;
        _move(duration: _reduceMotion ? Duration.zero : followMoveDuration(cadence));
      });
    }
  }

  // ── moves ───────────────────────────────────────────────────────────────────

  /// The zoom the next navigate move uses (smoothed towards the speed's zoom).
  double navZoom(double speed) {
    final target = navZoomForSpeed(speed);
    final z = _navZoom;
    return _navZoom = z == null ? target : z + (target - z) * 0.2;
  }

  void _move({required Duration duration}) {
    final s = _subject?.value;
    if (s == null) return;
    final nav = _mode == CameraModeKind.navigate;
    final vp = port.viewport;
    final padding = nav && vp != null ? lowerThirdPadding(vp, _insets) : _insets;
    _lastMove = _now();
    port.moveTo(
      center: s.point,
      zoom: nav ? navZoom(s.speed) : _followZoom,
      bearing: nav ? s.heading : 0,
      pitch: nav ? navPitchFor(threeD: _threeD) : _basePitch,
      padding: padding,
      duration: duration,
    ).catchError((Object _) {});
  }

  /// One frame of frame-by-frame following: the camera exactly on the subject (blended from the
  /// camera's start while a transition runs), the padding and the navigation zoom eased in time.
  void _frameMove() {
    final s = _subject?.value;
    if (s == null) return;
    final now = _now();
    final last = _lastFrame;
    _lastFrame = now;
    final dt = last == null ? 0.0 : now.difference(last).inMicroseconds / 1e6;
    double ease(double tau) => last == null ? 1 : 1 - exp(-dt / tau);

    final nav = _mode == CameraModeKind.navigate;
    final vp = port.viewport;
    final padTarget = nav && vp != null ? lowerThirdPadding(vp, _insets) : _insets;
    final pad = _padShown == null ? padTarget : EdgeInsets.lerp(_padShown, padTarget, ease(0.25))!;
    _padShown = pad;
    var zoom = _followZoom;
    if (nav) {
      final target = navZoomForSpeed(s.speed);
      final z = _zoomShown;
      zoom = _zoomShown = z == null ? target : z + (target - z) * ease(2.0);
    }
    var center = s.point;
    var bearing = nav ? s.heading : 0.0;
    var pitch = nav ? navPitchFor(threeD: _threeD) : _basePitch;

    final from = _blendFrom, start = _blendStart;
    if (from != null && start != null) {
      final t = now.difference(start).inMicroseconds / max(1, transition.inMicroseconds);
      if (t >= 1) {
        _blendFrom = _blendStart = null;
      } else {
        final k = _easeInOut(t);
        center = (lat: from.center.lat + (center.lat - from.center.lat) * k, lng: from.center.lng + (center.lng - from.center.lng) * k);
        zoom = from.zoom + (zoom - from.zoom) * k;
        bearing = from.bearing + _shortest(from.bearing, bearing) * k;
        pitch = from.pitch + (pitch - from.pitch) * k;
      }
    }
    _lastMove = now;
    port.moveTo(center: center, zoom: zoom, bearing: bearing, pitch: pitch, padding: pad, duration: Duration.zero).catchError((Object _) {});
  }

  void _fit({required Duration duration}) {
    if (_points.isEmpty) return;
    _lastMove = _now();
    port.fit(_points, padding: _fitPadding, bearing: port.bearing, pitch: _basePitch, duration: duration).catchError((Object _) {});
  }

  /// Breathing room around fitted points, inside the insets.
  EdgeInsets get _fitPadding => EdgeInsets.fromLTRB(_insets.left, _insets.top + 48, _insets.right, _insets.bottom + 32);

  void dispose() {
    _disposed = true;
    _detachSubject();
    _settle?.cancel();
    _showRecenter.dispose();
  }
}

double _easeInOut(double t) => t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2;

/// The signed turn from [a] to [b] the short way round, degrees.
double _shortest(double a, double b) => ((b - a) % 360 + 540) % 360 - 180;

/// The zoom at which [points] fill a [viewport] minus [padding], on a Web Mercator map whose
/// world is [tileSize] × 2^zoom pixels wide (512 for MapLibre, 256 for flutter_map). Bearing is
/// ignored (the engines rotate the fit themselves). Infinity for a single point.
double fitZoomFor(List<GeoPoint> points, Size viewport, EdgeInsets padding, {double tileSize = 512}) {
  if (points.length < 2) return double.infinity;
  double x(double lng) => (lng + 180) / 360;
  double y(double lat) {
    final s = sin(lat.clamp(-85.0, 85.0) * pi / 180);
    return 0.5 - log((1 + s) / (1 - s)) / (4 * pi);
  }

  var minX = double.infinity, maxX = -double.infinity, minY = double.infinity, maxY = -double.infinity;
  for (final p in points) {
    minX = min(minX, x(p.lng));
    maxX = max(maxX, x(p.lng));
    minY = min(minY, y(p.lat));
    maxY = max(maxY, y(p.lat));
  }
  final w = max(1.0, viewport.width - padding.left - padding.right);
  final h = max(1.0, viewport.height - padding.top - padding.bottom);
  final dx = maxX - minX, dy = maxY - minY;
  if (dx <= 0 && dy <= 0) return double.infinity;
  final zx = dx <= 0 ? double.infinity : log(w / (dx * tileSize)) / ln2;
  final zy = dy <= 0 ? double.infinity : log(h / (dy * tileSize)) / ln2;
  return min(zx, zy);
}

/// The middle of [points]' bounding box.
GeoPoint boundsCenter(List<GeoPoint> points) {
  var minLat = double.infinity, maxLat = -double.infinity, minLng = double.infinity, maxLng = -double.infinity;
  for (final p in points) {
    minLat = min(minLat, p.lat);
    maxLat = max(maxLat, p.lat);
    minLng = min(minLng, p.lng);
    maxLng = max(maxLng, p.lng);
  }
  return (lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2);
}
