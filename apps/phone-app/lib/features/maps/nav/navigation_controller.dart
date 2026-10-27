// In-app guidance to a target: fetches the road route with its turns, follows the driver's
// position along it (next turn, distance left, the part already driven) and asks for a new
// route when the car has left it.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/network/providers.dart';

typedef RouteFetcher = Future<RouteSteps> Function({required double fromLat, required double fromLng, required double toLat, required double toLng, bool steps});

/// Overridable in tests.
final routeFetcherProvider = Provider<RouteFetcher>((ref) => ref.read(apisProvider).maps.route);

@immutable
class NavTarget {
  const NavTarget({required this.lat, required this.lng, this.label});
  final double lat;
  final double lng;
  final String? label;
  @override
  bool operator ==(Object other) => other is NavTarget && other.lat == lat && other.lng == lng;
  @override
  int get hashCode => Object.hash(lat, lng);
}

@immutable
class NavState {
  const NavState({
    this.route = const [],
    this.cumulative = const [],
    this.steps = const [],
    this.traversed = const [],
    this.remaining = const [],
    this.remainingMeters,
    this.remainingSeconds,
    this.nextStep,
    this.thenStep,
    this.metersToManeuver,
    this.offRoute = false,
    this.rerouting = false,
    this.approximate = false,
    this.error,
    this.loading = true,
  });
  final List<GeoPoint> route;
  final List<double> cumulative;
  final List<RouteStep> steps;
  final List<GeoPoint> traversed;
  final List<GeoPoint> remaining;
  final int? remainingMeters;
  final int? remainingSeconds;
  final RouteStep? nextStep;
  final RouteStep? thenStep;
  final int? metersToManeuver;
  final bool offRoute;
  final bool rerouting;
  final bool approximate;
  final Object? error;
  final bool loading;
  bool get hasRoute => route.length >= 2;

  NavState copyWith({
    List<GeoPoint>? route,
    List<double>? cumulative,
    List<RouteStep>? steps,
    List<GeoPoint>? traversed,
    List<GeoPoint>? remaining,
    int? remainingMeters,
    int? remainingSeconds,
    RouteStep? nextStep,
    RouteStep? thenStep,
    int? metersToManeuver,
    bool? offRoute,
    bool? rerouting,
    bool? approximate,
    Object? error,
    bool? loading,
    bool clearSteps = false,
  }) =>
      NavState(
        route: route ?? this.route,
        cumulative: cumulative ?? this.cumulative,
        steps: steps ?? this.steps,
        traversed: traversed ?? this.traversed,
        remaining: remaining ?? this.remaining,
        remainingMeters: remainingMeters ?? this.remainingMeters,
        remainingSeconds: remainingSeconds ?? this.remainingSeconds,
        nextStep: clearSteps ? null : nextStep ?? this.nextStep,
        thenStep: clearSteps ? null : thenStep ?? this.thenStep,
        metersToManeuver: clearSteps ? null : metersToManeuver ?? this.metersToManeuver,
        offRoute: offRoute ?? this.offRoute,
        rerouting: rerouting ?? this.rerouting,
        approximate: approximate ?? this.approximate,
        error: error,
        loading: loading ?? this.loading,
      );
}

class NavigationController extends Notifier<NavState> {
  NavigationController(this.target);
  final NavTarget target;

  static const offRouteMeters = 60.0;
  static const offRouteFor = Duration(seconds: 8);
  static const minReroute = Duration(seconds: 20);
  static const minRerouteApproximate = Duration(seconds: 60);

  DateTime? _offSince;
  DateTime? _lastRoute;
  GeoPoint? _last;
  double _lastSpeed = 0;
  // distance along the route at each step's maneuver, for "in 250 m"
  List<double> _stepAlong = const [];
  DateTime Function() now = DateTime.now;

  @override
  NavState build() => const NavState();

  /// Start (or restart) from [from]. Call once with the first fix; later fixes go to [update].
  Future<void> start(GeoPoint from) async {
    _last = from;
    await _fetch(from);
  }

  Future<void> _fetch(GeoPoint from) async {
    state = state.copyWith(loading: !state.hasRoute, rerouting: state.hasRoute, error: null);
    _lastRoute = now();
    try {
      final r = await ref.read(routeFetcherProvider)(fromLat: from.lat, fromLng: from.lng, toLat: target.lat, toLng: target.lng, steps: true);
      final pts = r.polyline6.isEmpty ? [from, (lat: target.lat, lng: target.lng)] : decodePolyline6(r.polyline6);
      final cum = cumulativeMeters(pts);
      _stepAlong = r.steps.map((s) => projectOntoPolyline(pts, (lat: s.lat, lng: s.lng), cumulative: cum).alongMeters).toList(growable: false);
      state = NavState(route: pts, cumulative: cum, steps: r.steps, remaining: pts, remainingMeters: r.distanceMeters, remainingSeconds: r.durationSeconds, approximate: r.approximate, loading: false);
      _offSince = null;
      update(from, speed: _lastSpeed);
    } catch (e) {
      state = state.copyWith(loading: false, rerouting: false, error: e);
    }
  }

  /// A new position of the car. [speed] in m/s, for the time left.
  void update(GeoPoint p, {double? speed}) {
    _last = p;
    if (speed != null) _lastSpeed = speed;
    if (!state.hasRoute) return;
    final pr = projectOntoPolyline(state.route, p, cumulative: state.cumulative);
    final total = state.cumulative.last;
    final left = (total - pr.alongMeters).clamp(0.0, total);
    // steps whose maneuver is still ahead
    RouteStep? next, then;
    int? toManeuver;
    for (var i = 0; i < state.steps.length; i++) {
      if (_stepAlong[i] >= pr.alongMeters - 15 && state.steps[i].type != 'depart') {
        next = state.steps[i];
        toManeuver = (_stepAlong[i] - pr.alongMeters).clamp(0.0, double.infinity).round();
        then = i + 1 < state.steps.length ? state.steps[i + 1] : null;
        break;
      }
    }
    final off = pr.offMeters > offRouteMeters;
    final t = now();
    if (off) {
      _offSince ??= t;
    } else {
      _offSince = null;
    }
    // speed for the remaining time: measured when moving, else the route's average
    final avg = state.remainingMeters != null && state.remainingSeconds != null && state.remainingSeconds! > 0 ? state.remainingMeters! / state.remainingSeconds! : 8.0;
    final mps = _lastSpeed > 1.5 ? (_lastSpeed * 0.5 + avg * 0.5) : avg;
    state = state.copyWith(
      traversed: sliceTo(state.route, pr),
      remaining: sliceFrom(state.route, pr),
      remainingMeters: left.round(),
      remainingSeconds: (left / (mps <= 0 ? 8 : mps)).round(),
      nextStep: next,
      thenStep: then,
      metersToManeuver: toManeuver,
      clearSteps: next == null,
      offRoute: off,
    );
    if (off && _offSince != null && t.difference(_offSince!) >= offRouteFor) {
      final minGap = state.approximate ? minRerouteApproximate : minReroute;
      if (_lastRoute == null || t.difference(_lastRoute!) >= minGap) {
        _fetch(p);
      }
    }
  }

  Future<void> retry() async {
    final p = _last;
    if (p != null) await _fetch(p);
  }
}

final navigationProvider = NotifierProvider.family<NavigationController, NavState, NavTarget>(NavigationController.new);
