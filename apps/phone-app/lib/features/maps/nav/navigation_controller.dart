// In-app guidance to a target: fetches the road route with its turns, follows the driver's
// position along it and asks for a new route when the car has left it.
//
// Driven by positions, never by a widget build: the controller listens to the shift's location
// stream (`lastPositionProvider`), and tests (or a screen with its own source) call [update].
//
// Progress along the route only moves forward. Each fix is matched inside a window ahead of the
// last progress (a small step back is allowed for GPS jitter), and only to stretches of road
// running the way the car is heading (within 60°), so a route that passes the same street twice,
// or a parallel or crossing road, never makes the car jump. The matched point and the road's
// bearing there ([NavState.snapped], [NavState.bearing]) feed the car animator and the camera.
//
// A new route is asked for when the car is more than 50 m from the route for 6 s, or drives the
// opposite way along it for 5 s; at most every 15 s (60 s when the route is approximate, i.e. a
// straight line because the road router is down). /api/maps/route takes no bearing, so the
// current heading is used on the phone: when a new route starts by turning back (a U-turn first
// step, or a first stretch more than 100° off the heading), it is asked for again from a point
// 80 m ahead along the heading, and the one that starts the way the car is going wins.
//
// Within 40 m of the target the state says [NavState.arrived].

import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/location/location_source.dart';
import '../../../core/network/providers.dart';
import '../scene/route_track.dart';

typedef RouteFetcher = Future<RouteSteps> Function({required double fromLat, required double fromLng, required double toLat, required double toLng, bool steps});

/// Overridable in tests.
final routeFetcherProvider = Provider<RouteFetcher>((ref) => ref.read(apisProvider).maps.route);

@immutable
class NavTarget {
  const NavTarget({required this.lat, required this.lng, this.label});
  final double lat;
  final double lng;
  final String? label;
  GeoPoint get point => (lat: lat, lng: lng);
  @override
  bool operator ==(Object other) => other is NavTarget && other.lat == lat && other.lng == lng;
  @override
  int get hashCode => Object.hash(lat, lng);
}

/// The smallest difference between two bearings, 0–180°.
double angleDiff(double a, double b) {
  final d = ((a - b) % 360 + 360) % 360;
  return d > 180 ? 360 - d : d;
}

@immutable
class NavState {
  const NavState({
    this.track,
    this.routeVersion = 0,
    this.steps = const [],
    this.stepAlong = const [],
    this.progressMeters,
    this.snapped,
    this.bearing,
    this.fixSeq = 0,
    this.stepIndex,
    this.metersToManeuver,
    this.remainingMeters,
    this.remainingSeconds,
    this.offRoute = false,
    this.wrongWay = false,
    this.rerouting = false,
    this.approximate = false,
    this.arrived = false,
    this.error,
    this.loading = true,
  });

  /// The route with its distances (null before the first one arrives).
  final RouteTrack? track;
  /// Goes up with each new route: the cheap identity of [track] and [steps].
  final int routeVersion;
  final List<RouteStep> steps;
  /// Metres along the route of each step's maneuver.
  final List<double> stepAlong;
  /// Where the car is along the route, metres from its start (monotonic).
  final double? progressMeters;
  /// The car's position on the route (the raw fix when it is off the route).
  final GeoPoint? snapped;
  /// The road's bearing at [snapped] (null off the route).
  final double? bearing;
  /// Goes up with each position handled.
  final int fixSeq;
  /// The index in [steps] of the next maneuver.
  final int? stepIndex;
  final int? metersToManeuver;
  final int? remainingMeters;
  final int? remainingSeconds;
  /// More than 50 m from the route.
  final bool offRoute;
  /// On the route, but driving against it.
  final bool wrongWay;
  final bool rerouting;
  final bool approximate;
  /// Within 40 m of the target.
  final bool arrived;
  final Object? error;
  final bool loading;

  bool get hasRoute => track != null && track!.isUsable;
  List<GeoPoint> get route => track?.points ?? const [];
  List<double> get cumulative => track?.cumulative ?? const [];
  RouteStep? get nextStep => stepIndex == null ? null : steps[stepIndex!];
  RouteStep? get thenStep => stepIndex == null || stepIndex! + 1 >= steps.length ? null : steps[stepIndex! + 1];
  /// Metres from [nextStep] to [thenStep] (how soon the "then" turn follows).
  double? get thenGapMeters => stepIndex == null || stepIndex! + 1 >= stepAlong.length ? null : stepAlong[stepIndex! + 1] - stepAlong[stepIndex!];

  /// The part of the route before [meters] (the car's progress by default).
  List<GeoPoint> traversedAt([double? meters]) {
    final t = track;
    final m = meters ?? progressMeters;
    if (t == null || m == null || m <= 0) return const [];
    final i = t.segmentAt(m);
    return [...t.points.take(i + 1), t.pointAt(m)];
  }

  /// The part of the route from [meters] on (the whole route before any progress).
  List<GeoPoint> remainingAt([double? meters]) {
    final t = track;
    if (t == null) return const [];
    final m = meters ?? progressMeters;
    if (m == null || m <= 0) return t.points;
    final i = t.segmentAt(m);
    return [t.pointAt(m), ...t.points.skip(i + 1)];
  }

  List<GeoPoint> get traversed => traversedAt();
  List<GeoPoint> get remaining => remainingAt();

  NavState copyWith({
    RouteTrack? track,
    int? routeVersion,
    List<RouteStep>? steps,
    List<double>? stepAlong,
    double? progressMeters,
    GeoPoint? snapped,
    double? bearing,
    int? fixSeq,
    int? stepIndex,
    int? metersToManeuver,
    int? remainingMeters,
    int? remainingSeconds,
    bool? offRoute,
    bool? wrongWay,
    bool? rerouting,
    bool? approximate,
    bool? arrived,
    Object? error,
    bool? loading,
    bool clearStep = false,
    bool clearBearing = false,
  }) =>
      NavState(
        track: track ?? this.track,
        routeVersion: routeVersion ?? this.routeVersion,
        steps: steps ?? this.steps,
        stepAlong: stepAlong ?? this.stepAlong,
        progressMeters: progressMeters ?? this.progressMeters,
        snapped: snapped ?? this.snapped,
        bearing: clearBearing ? null : bearing ?? this.bearing,
        fixSeq: fixSeq ?? this.fixSeq,
        stepIndex: clearStep ? null : stepIndex ?? this.stepIndex,
        metersToManeuver: clearStep ? null : metersToManeuver ?? this.metersToManeuver,
        remainingMeters: remainingMeters ?? this.remainingMeters,
        remainingSeconds: remainingSeconds ?? this.remainingSeconds,
        offRoute: offRoute ?? this.offRoute,
        wrongWay: wrongWay ?? this.wrongWay,
        rerouting: rerouting ?? this.rerouting,
        approximate: approximate ?? this.approximate,
        arrived: arrived ?? this.arrived,
        error: error,
        loading: loading ?? this.loading,
      );

  @override
  bool operator ==(Object other) =>
      other is NavState &&
      other.routeVersion == routeVersion &&
      identical(other.track, track) &&
      other.progressMeters == progressMeters &&
      other.snapped == snapped &&
      other.bearing == bearing &&
      other.fixSeq == fixSeq &&
      other.stepIndex == stepIndex &&
      other.metersToManeuver == metersToManeuver &&
      other.remainingMeters == remainingMeters &&
      other.remainingSeconds == remainingSeconds &&
      other.offRoute == offRoute &&
      other.wrongWay == wrongWay &&
      other.rerouting == rerouting &&
      other.approximate == approximate &&
      other.arrived == arrived &&
      other.error == error &&
      other.loading == loading;

  @override
  int get hashCode => Object.hash(routeVersion, progressMeters, snapped, bearing, fixSeq, stepIndex, metersToManeuver, remainingMeters, remainingSeconds, offRoute, wrongWay, rerouting, approximate, arrived, error, loading);
}

/// A place on the route a position may belong to: one per segment, the closest point on it.
typedef _Candidate = ({double along, double off, double bearing});

class NavigationController extends Notifier<NavState> {
  NavigationController(this.target);
  final NavTarget target;

  static const offRouteMeters = 50.0;
  static const offRouteFor = Duration(seconds: 6);
  static const wrongWayFor = Duration(seconds: 5);
  static const minReroute = Duration(seconds: 15);
  static const minRerouteApproximate = Duration(seconds: 60);
  static const arriveWithin = 40.0;
  /// how far a fix may fall behind the last progress (GPS jitter) without moving it back
  static const backTolerance = 25.0;
  /// a heading this close to the road's bearing matches it
  static const headingMatch = 60.0;
  /// below this speed (m/s) headings are noise
  static const headingSpeed = 2.0;
  /// how far ahead the second route request starts when the first one turns back
  static const aheadMeters = 80.0;

  DateTime Function() now = DateTime.now;

  DateTime? _offSince;
  DateTime? _wrongSince;
  DateTime? _lastRoute;
  GeoPoint? _last;
  double _speed = 0;
  double? _heading;
  bool _fetching = false;
  bool _started = false;
  double _routeMps = 8;
  int _version = 0;
  bool _disposed = false;

  @override
  NavState build() {
    _disposed = false;
    ref.onDispose(() => _disposed = true);
    // positions drive the guidance: the shift's stream while the driver is online
    ref.listen<DevicePosition?>(lastPositionProvider, (_, p) {
      if (p != null) onPosition(p);
    });
    final p0 = ref.read(lastPositionProvider);
    if (p0 != null) Future.microtask(() => onPosition(p0));
    return const NavState();
  }

  /// A fix from the location stream: the first one fetches the route, later ones follow it.
  void onPosition(DevicePosition p) {
    if (_disposed) return;
    final g = (lat: p.lat, lng: p.lng);
    if (!_started) {
      _started = true;
      _speed = p.speed ?? 0;
      _heading = p.heading;
      start(g, heading: p.heading, speed: p.speed);
    } else {
      update(g, speed: p.speed, heading: p.heading);
    }
  }

  /// Start (or restart) from [from]. Later fixes go to [update].
  Future<void> start(GeoPoint from, {double? heading, double? speed}) async {
    _started = true;
    _last = from;
    if (heading != null) _heading = heading;
    if (speed != null) _speed = speed;
    await _fetch(from);
  }

  bool get _headingReliable => _heading != null && _speed >= headingSpeed;

  Future<void> _fetch(GeoPoint from) async {
    if (_fetching) return;
    _fetching = true;
    state = state.copyWith(loading: !state.hasRoute, rerouting: state.hasRoute, error: null);
    _lastRoute = now();
    try {
      final fetch = ref.read(routeFetcherProvider);
      final heading = _headingReliable ? _heading : null;
      var r = await fetch(fromLat: from.lat, fromLng: from.lng, toLat: target.lat, toLng: target.lng, steps: true);
      if (_disposed) return;
      var pts = _pointsOf(r, from);
      var steps = r.steps;
      if (heading != null && !r.approximate && _turnsBack(pts, steps, heading)) {
        // no bearing on the route API: ask again from a little ahead of the car
        final ahead = geoOffset(from, heading, aheadMeters);
        try {
          final r2 = await fetch(fromLat: ahead.lat, fromLng: ahead.lng, toLat: target.lat, toLng: target.lng, steps: true);
          if (_disposed) return;
          final pts2 = [from, ..._pointsOf(r2, ahead)];
          if (_startBearingOff(pts2, heading) < _startBearingOff(pts, heading)) {
            final lead = geoDistanceMeters(from, pts2[1]);
            r = RouteSteps(polyline6: r2.polyline6, distanceMeters: r2.distanceMeters + lead.round(), durationSeconds: r2.durationSeconds + (lead / 8).round(), approximate: r2.approximate, steps: r2.steps);
            pts = pts2;
            steps = r2.steps;
          }
        } catch (_) {
          // keep the first route
        }
      }
      final track = RouteTrack(pts);
      _routeMps = r.durationSeconds > 0 && r.distanceMeters > 0 ? r.distanceMeters / r.durationSeconds : 8;
      _version++;
      _offSince = null;
      _wrongSince = null;
      state = NavState(
        track: track,
        routeVersion: _version,
        steps: steps,
        stepAlong: _stepAlong(track, steps),
        remainingMeters: r.distanceMeters,
        remainingSeconds: r.durationSeconds,
        approximate: r.approximate,
        arrived: state.arrived,
        fixSeq: state.fixSeq,
        loading: false,
      );
      _fetching = false;
      final last = _last;
      if (last != null) update(last);
    } catch (e) {
      if (_disposed) return;
      state = state.copyWith(loading: false, rerouting: false, error: e);
    } finally {
      _fetching = false;
    }
  }

  static List<GeoPoint> _pointsOf(RouteSteps r, GeoPoint from) {
    final pts = r.polyline6.isEmpty ? <GeoPoint>[] : decodePolyline6(r.polyline6);
    return pts.length >= 2 ? pts : [from, ...pts];
  }

  /// How far the first ~40 m of [pts] point away from [heading].
  static double _startBearingOff(List<GeoPoint> pts, double heading) {
    if (pts.length < 2) return 180;
    final t = RouteTrack(pts);
    if (!t.isUsable) return 180;
    return angleDiff(geoBearing(pts.first, t.pointAt(min(40, t.length))), heading);
  }

  /// The route starts by turning back: a U-turn in its first 150 m, or a first stretch more than
  /// 100° off the way the car goes.
  static bool _turnsBack(List<GeoPoint> pts, List<RouteStep> steps, double heading) {
    if (_startBearingOff(pts, heading) > 100) return true;
    for (final s in steps.take(3)) {
      if (s.modifier == 'uturn' && geoDistanceMeters(pts.first, (lat: s.lat, lng: s.lng)) < 150) return true;
    }
    return false;
  }

  /// Each step's maneuver along the route, in order (a route that passes a junction twice gets
  /// the pass that follows the previous step).
  static List<double> _stepAlong(RouteTrack t, List<RouteStep> steps) {
    final out = <double>[];
    var from = 0.0;
    for (final s in steps) {
      final p = (lat: s.lat, lng: s.lng);
      final cands = _candidates(t, p, from: from);
      final near = cands.where((c) => c.off <= 25).toList();
      final double a;
      if (near.isNotEmpty) {
        a = near.map((c) => c.along).reduce(min);
      } else {
        a = t.project(p, from: from).alongMeters;
      }
      out.add(a);
      from = a;
    }
    return List.unmodifiable(out);
  }

  /// The closest point of each segment of [t] to [p], between [from] and [to] metres.
  static List<_Candidate> _candidates(RouteTrack t, GeoPoint p, {double from = 0, double to = double.infinity}) {
    final out = <_Candidate>[];
    if (!t.isUsable) return out;
    final lo = max(0.0, from), hi = min(t.length, to);
    if (hi < lo) return out;
    final first = t.segmentAt(lo), last = t.segmentAt(hi);
    final pts = t.points, cum = t.cumulative;
    final cosLat = cos(p.lat * pi / 180);
    for (var i = first; i <= last; i++) {
      final segLen = cum[i + 1] - cum[i];
      if (segLen <= 0) continue;
      final ax = (pts[i].lng - p.lng) * cosLat, ay = pts[i].lat - p.lat;
      final bx = (pts[i + 1].lng - p.lng) * cosLat, by = pts[i + 1].lat - p.lat;
      final dx = bx - ax, dy = by - ay;
      final len2 = dx * dx + dy * dy;
      var u = len2 == 0 ? 0.0 : (-ax * dx - ay * dy) / len2;
      u = u.clamp(((lo - cum[i]) / segLen).clamp(0.0, 1.0), ((hi - cum[i]) / segLen).clamp(0.0, 1.0));
      final q = geoLerp(pts[i], pts[i + 1], u);
      out.add((along: cum[i] + segLen * u, off: geoDistanceMeters(p, q), bearing: geoBearing(pts[i], pts[i + 1])));
    }
    return out;
  }

  /// A new position of the car. [speed] in m/s, [heading] in degrees.
  void update(GeoPoint p, {double? speed, double? heading}) {
    if (_disposed) return;
    final prev = _last;
    _last = p;
    if (speed != null) _speed = speed;
    if (heading != null) {
      _heading = heading;
    } else if (prev != null && geoDistanceMeters(prev, p) >= 8) {
      _heading = geoBearing(prev, p);
    }
    final seq = state.fixSeq + 1;
    final arrivedNow = state.arrived || geoDistanceMeters(p, target.point) <= arriveWithin;
    final track = state.track;
    if (track == null || !track.isUsable) {
      state = state.copyWith(fixSeq: seq, snapped: p, arrived: arrivedNow, error: state.error);
      // no route because the last request failed: try again now and then
      final lastTry = _lastRoute;
      if (state.error != null && !_fetching && !arrivedNow && (lastTry == null || now().difference(lastTry) >= minReroute)) unawaited(_fetch(p));
      return;
    }

    final hdg = _headingReliable ? _heading : null;
    bool matches(_Candidate c) => hdg == null || angleDiff(c.bearing, hdg) <= headingMatch;
    final last = state.progressMeters;
    _Candidate? best;
    var nearButAgainst = false;
    var lagging = false;
    if (last == null) {
      // the first fix on this route: the earliest stretch near the car running its way
      final cands = _candidates(track, p).where((c) => c.off <= offRouteMeters).toList();
      final ok = cands.where(matches).toList();
      if (ok.isNotEmpty) {
        best = ok.reduce((a, b) => a.along <= b.along ? a : b);
      } else if (cands.isNotEmpty) {
        nearButAgainst = true;
      }
    } else {
      final gapAhead = max(150.0, _speed * 10 + 80);
      final window = _candidates(track, p, from: last - backTolerance, to: last + gapAhead).where((c) => c.off <= offRouteMeters).toList();
      final ok = window.where(matches).toList();
      if (ok.isNotEmpty) {
        best = ok.reduce((a, b) => a.off <= b.off ? a : b);
      } else {
        // a gap in the fixes: the nearest stretch further ahead that runs the car's way
        final ahead = _candidates(track, p, from: last - backTolerance).where((c) => c.off <= offRouteMeters / 2 && matches(c)).toList();
        if (ahead.isNotEmpty) {
          best = ahead.reduce((a, b) => a.along <= b.along ? a : b);
        } else {
          // on the road but behind the progress: driving back along it (the wrong way), or a
          // fix that lags (keep the progress, not off the route)
          final behind = _candidates(track, p, from: last - 300, to: last + gapAhead).where((c) => c.off <= offRouteMeters).toList();
          if (behind.isNotEmpty) {
            if (hdg != null && !behind.any(matches)) {
              nearButAgainst = true;
            } else {
              lagging = true;
            }
          }
        }
      }
    }

    final t = now();
    final off = best == null && !nearButAgainst && !lagging;
    final wrong = best == null && nearButAgainst;
    if (off) {
      _offSince ??= t;
    } else {
      _offSince = null;
    }
    if (wrong) {
      _wrongSince ??= t;
    } else {
      _wrongSince = null;
    }

    // monotonic: a fix a little behind the last progress is jitter, not the car reversing
    double? along = best?.along;
    if (along != null && last != null && along < last) along = last;
    final progress = along ?? last;
    final total = track.length;
    final left = progress == null ? total : (total - progress).clamp(0.0, total);

    // the next maneuver: the first one still ahead (kept for a few metres while passing it)
    int? idx;
    if (progress != null || state.steps.isNotEmpty) {
      final at = progress ?? 0;
      for (var i = 0; i < state.steps.length; i++) {
        if (state.steps[i].type == 'depart') continue;
        if (state.stepAlong[i] >= at - 8) {
          idx = i;
          break;
        }
      }
    }
    final toManeuver = idx == null ? null : max(0.0, state.stepAlong[idx] - (progress ?? 0)).round();
    // the time left: the route's own pace, nudged by the measured speed when moving
    final pace = _speed > 1.5 ? (_routeMps * 0.7 + _speed * 0.3) : _routeMps;
    final arrived = arrivedNow || (progress != null && left <= arriveWithin && (best?.off ?? 999) <= offRouteMeters);

    state = state.copyWith(
      fixSeq: seq,
      progressMeters: progress,
      snapped: along != null ? track.pointAt(along) : p,
      bearing: along != null ? track.bearingAt(along) : null,
      clearBearing: along == null,
      stepIndex: idx,
      metersToManeuver: toManeuver,
      clearStep: idx == null,
      remainingMeters: left.round(),
      remainingSeconds: (left / max(1.0, pace)).round(),
      offRoute: off,
      wrongWay: wrong,
      arrived: arrived,
      error: state.error,
    );

    if (arrived || _fetching) return;
    final due = (off && _offSince != null && t.difference(_offSince!) >= offRouteFor) || (wrong && _wrongSince != null && t.difference(_wrongSince!) >= wrongWayFor);
    if (!due) return;
    final minGap = state.approximate ? minRerouteApproximate : minReroute;
    if (_lastRoute == null || t.difference(_lastRoute!) >= minGap) {
      unawaited(_fetch(p));
    }
  }

  Future<void> retry() async {
    final p = _last;
    if (p != null) await _fetch(p);
  }
}

final navigationProvider = NotifierProvider.autoDispose.family<NavigationController, NavState, NavTarget>(NavigationController.new);
