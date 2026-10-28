// Moves a car marker smoothly between GPS samples. Each new sample becomes the target and the
// shown pose glides to it over the time between samples (capped).
//
// With a known road ([route]) each sample is projected onto it, inside a window ahead of where
// the car last was (so it never jumps to a crossing street or back down the road because of GPS
// jitter), and the car moves along the road's distance, turning through the corners with the
// road's bearing instead of cutting them. When the next sample is late it keeps rolling along
// the road at its last speed for a few seconds, then stops. Without a route the glide is a
// straight line and there is no dead reckoning.
//
// Which way the car faces comes from a HeadingFilter (heading_filter.dart): the phone's heading
// while it really moves, else its movement between real samples at least 8 m apart, else the
// road's bearing; a parked car or GPS jitter keeps the last heading. Along a road the car takes
// the road's bearing as it drives. The drawn heading turns to a new one the short way round over
// ~450 ms (a HeadingEaser), only when it changes, never as a side effect of the position glide.
// A big jump snaps. More than [staleAfter] without a sample marks the pose stale.
//
// The animator is a ValueListenable: the map listens to it and draws each frame natively, so
// screens never rebuild per frame.

import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'heading_filter.dart';
import 'scene/route_track.dart';

@immutable
class AnimatedPose {
  const AnimatedPose({required this.lat, required this.lng, required this.heading, required this.stale, this.speed = 0});
  final double lat;
  final double lng;
  /// degrees clockwise from north
  final double heading;
  final bool stale;
  /// m/s, how fast the shown pose is moving
  final double speed;
  GeoPoint get point => (lat: lat, lng: lng);

  @override
  bool operator ==(Object other) => other is AnimatedPose && other.lat == lat && other.lng == lng && other.heading == heading && other.stale == stale && other.speed == speed;
  @override
  int get hashCode => Object.hash(lat, lng, heading, stale, speed);
}

class MarkerAnimator extends ChangeNotifier implements ValueListenable<AnimatedPose?> {
  MarkerAnimator({
    TickerProvider? vsync,
    DateTime Function()? now,
    this.maxGlide = const Duration(seconds: 4),
    this.deadReckonFor = const Duration(seconds: 6),
    this.snapOverMeters = 300,
    this.staleAfter = const Duration(seconds: 20),
    this.parkedSpeed = 1.5,
    this.offRouteMeters = 40,
    this.backTolerance = 25,
    Duration turn = const Duration(milliseconds: 450),
  })  : _now = now ?? DateTime.now,
        _filter = HeadingFilter(movingSpeed: parkedSpeed),
        _turn = HeadingEaser(duration: turn) {
    if (vsync != null) _ticker = vsync.createTicker(_tick);
  }

  final DateTime Function() _now;
  final Duration maxGlide;
  /// how long the car keeps rolling along the route when the next sample is late
  final Duration deadReckonFor;
  final double snapOverMeters;
  final Duration staleAfter;
  /// m/s; below it the car is parked and keeps its heading
  final double parkedSpeed;
  /// a sample further than this from the route is drawn where it is, off the route
  final double offRouteMeters;
  /// metres a sample may fall behind the last progress (GPS jitter) without moving the car back
  final double backTolerance;
  Ticker? _ticker;
  Timer? _staleTimer;

  final HeadingFilter _filter;
  final HeadingEaser _turn;
  // what is shown now
  AnimatedPose? _pose;
  double _heading = 0;
  double? _shownAlong;
  // the glide in progress (along the route when both ends are on it, else a straight line)
  GeoPoint? _from;
  GeoPoint? _to;
  double? _fromAlong;
  double? _toAlong;
  DateTime? _glideStart;
  DateTime? _glideEnd;
  Duration _glide = Duration.zero;
  double _glideSpeed = 0;
  // the last sample
  DateTime? _sampleAt;
  GeoPoint? _lastSample;
  double _speed = 0;
  // the road
  RouteTrack? _track;
  double? _progress;
  bool _wasStale = false;

  AnimatedPose? get pose => _pose;
  @override
  AnimatedPose? get value => _pose;

  bool get isStale => _sampleAt != null && _now().difference(_sampleAt!) > staleAfter;

  /// Gliding, or rolling on along the route: the ticker is needed.
  bool get isAnimating => _glideStart != null || _deadReckoning(_now()) || _turn.busyAt(_now());

  /// Where the car is along [route], metres from its start (null off the route or without one).
  double? get progressMeters => _progress;

  /// The road the car drives along; null drops it. Setting the same geometry again keeps the
  /// progress.
  set route(List<GeoPoint>? points) {
    if (points == null || points.length < 2) {
      if (_track == null) return;
      _track = null;
      _progress = null;
      _shownAlong = null;
      _fromAlong = _toAlong = null;
      return;
    }
    if (_track != null && _track!.sameAs(points)) return;
    final t = RouteTrack(points);
    _track = t.isUsable ? t : null;
    _progress = null;
    _shownAlong = null;
    _fromAlong = _toAlong = null;
    // place the shown pose on the new road at once if it is close to it
    final p = _pose;
    if (_track != null && p != null) {
      final pr = _track!.project(p.point);
      if (pr.offMeters <= offRouteMeters) {
        _progress = pr.alongMeters;
        _shownAlong = pr.alongMeters;
      }
    }
  }

  List<GeoPoint>? get route => _track?.points;

  /// A new GPS sample. [heading] in degrees, [speed] in m/s, [at] when the phone measured it.
  void push(GeoPoint p, {double? heading, double? speed, DateTime? at}) {
    final now = _now();
    final sampleAt = at ?? now;
    final prevAt = _sampleAt;
    final prev = _lastSample;
    final first = _pose == null;
    final gapS = prevAt == null ? 0.0 : max(0.0, sampleAt.difference(prevAt).inMilliseconds / 1000);
    final measured = speed ?? (prev == null || gapS <= 0 ? 0.0 : geoDistanceMeters(prev, p) / gapS);
    _speed = measured;
    _sampleAt = sampleAt;
    _lastSample = p;
    _scheduleStale();

    // on the road?
    double? along;
    final track = _track;
    if (track != null) {
      RouteProjection pr;
      final last = _progress;
      if (last == null) {
        pr = track.project(p);
      } else {
        final ahead = max(200.0, measured * max(gapS, 1) * 2 + 60);
        pr = track.project(p, from: last - backTolerance, to: last + ahead);
        if (pr.offMeters > offRouteMeters) {
          // maybe it moved further than expected (a gap in the samples): look along the whole road
          final g = track.project(p);
          if (g.offMeters <= offRouteMeters) pr = g;
        }
      }
      if (pr.offMeters <= offRouteMeters) {
        // monotonic: a sample a little behind the last progress is jitter, not the car reversing
        along = last != null && pr.alongMeters < last && last - pr.alongMeters <= backTolerance ? last : pr.alongMeters;
      }
    }
    final target = along != null ? track!.pointAt(along) : p;
    final roadBearing = along != null ? track!.bearingAt(along) : null;
    final jump = first ? 0.0 : geoDistanceMeters(_pose!.point, target);
    _progress = along;

    if (first || jump > snapOverMeters) {
      // somewhere new: what the samples said before says nothing about this one
      _filter.reset();
      _heading = _filter.update(target, gpsHeading: heading, speed: speed, roadBearing: roadBearing) ?? roadBearing ?? _heading;
      _turn.snap(_heading);
      _shownAlong = along;
      _from = _to = target;
      _fromAlong = _toAlong = along;
      _glideStart = null;
      _glideEnd = now;
      _glideSpeed = 0;
      _emit(target, now);
      _ensureTicking();
      return;
    }

    // glide from what is shown to the target, over the sample gap (capped)
    final gap = prevAt == null ? maxGlide : sampleAt.difference(prevAt);
    _glide = gap <= Duration.zero ? maxGlide : (gap > maxGlide ? maxGlide : gap);
    _from = _pose!.point;
    _to = target;
    // off the road the sample decides the heading; on it the road does, as the car drives
    final h = _filter.update(along != null ? target : p, gpsHeading: heading, speed: speed ?? measured, roadBearing: roadBearing);
    if (h != null && along == null) _turn.turnTo(h, now);
    if (along != null && _shownAlong != null) {
      _fromAlong = _shownAlong;
      // dead reckoning may have carried the car past the new sample: wait there rather than reverse
      _toAlong = max(along, _shownAlong!);
      _glideSpeed = (_toAlong! - _fromAlong!) / max(0.001, _glide.inMilliseconds / 1000);
    } else {
      _fromAlong = _toAlong = null;
      _glideSpeed = geoDistanceMeters(_from!, _to!) / max(0.001, _glide.inMilliseconds / 1000);
    }
    _glideStart = now;
    _ensureTicking();
  }

  bool _deadReckoning(DateTime now) {
    final end = _glideEnd, at = _sampleAt;
    if (_track == null || _toAlong == null || end == null || at == null || _speed <= 0.5) return false;
    return now.difference(end) <= deadReckonFor && _shownAlong != null && _shownAlong! < _track!.length;
  }

  void _ensureTicking() {
    final t = _ticker;
    if (t != null && !t.isActive) t.start();
  }

  void _scheduleStale() {
    if (_ticker == null) return; // tests drive time by hand
    _staleTimer?.cancel();
    _staleTimer = Timer(staleAfter + const Duration(milliseconds: 50), () => _emitStale());
  }

  void _emitStale() {
    final p = _pose;
    if (p == null) return;
    _emit(p.point, _now(), speed: 0);
  }

  void _emit(GeoPoint p, DateTime now, {double? speed}) {
    final stale = _sampleAt != null && now.difference(_sampleAt!) > staleAfter;
    _wasStale = stale;
    final next = AnimatedPose(lat: p.lat, lng: p.lng, heading: _heading, stale: stale, speed: speed ?? 0);
    if (next == _pose) return;
    _pose = next;
    notifyListeners();
  }

  /// Advance to [at] (the ticker calls this; tests and CarsAnimator call it by hand).
  void advance([DateTime? at]) {
    final now = at ?? _now();
    if (_pose == null || _to == null) return;
    final start = _glideStart;
    if (start != null) {
      final t = (now.difference(start).inMilliseconds / max(1, _glide.inMilliseconds)).clamp(0.0, 1.0);
      final track = _track;
      GeoPoint p;
      if (track != null && _fromAlong != null && _toAlong != null) {
        final a = _fromAlong! + (_toAlong! - _fromAlong!) * t;
        _shownAlong = a;
        p = track.pointAt(a);
        // a car standing still keeps facing where it faced
        if ((_toAlong! - _fromAlong!).abs() > 0.5) _turn.turnTo(track.bearingAt(a), now);
      } else {
        p = geoLerp(_from!, _to!, t);
      }
      _heading = _turn.valueAt(now) ?? _heading;
      if (t >= 1) {
        _glideStart = null;
        _glideEnd = now;
        _from = _to;
        _fromAlong = _toAlong;
      }
      _emit(p, now, speed: _glideSpeed);
      return;
    }
    // the glide is done: keep rolling along the road while the next sample is late
    if (_deadReckoning(now)) {
      final extra = now.difference(_glideEnd!).inMilliseconds / 1000 * _speed;
      final a = min(_track!.length, _toAlong! + extra);
      _shownAlong = a;
      _turn.turnTo(_track!.bearingAt(a), now);
      _heading = _turn.valueAt(now) ?? _heading;
      _emit(_track!.pointAt(a), now, speed: _speed);
      return;
    }
    // still turning in place
    if (_turn.busyAt(now)) {
      _heading = _turn.valueAt(now) ?? _heading;
      _emit(_pose!.point, now, speed: 0);
      return;
    }
    _heading = _turn.valueAt(now) ?? _heading;
    // nothing moves: stop the ticker (a new sample starts it again)
    final t = _ticker;
    if (t != null && t.isActive) t.stop();
    final stale = _sampleAt != null && now.difference(_sampleAt!) > staleAfter;
    if (stale != _wasStale || _pose!.speed != 0) _emit(_pose!.point, now, speed: 0);
  }

  void _tick(Duration _) => advance();

  @override
  void dispose() {
    _staleTimer?.cancel();
    _ticker?.dispose();
    super.dispose();
  }
}
