// The cars around the rider: polled while the home is on screen (paused while it is covered),
// each one glided to its new position by a MarkerAnimator (re-matched between polls by
// proximity, so a car that moved keeps its animator instead of blinking out and back). A car
// that appears fades in and one that leaves fades out. The animator publishes one list of
// frames per tick (a ValueListenable the map draws natively), never a screen rebuild, and its
// ticker stops when nothing moves or while it is paused.

import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/network/providers.dart';
import 'anbessa_map.dart';

@immutable
class NearbyCarsState {
  const NearbyCarsState({this.data = NearbyCars.none, this.loading = false, this.error});
  final NearbyCars data;
  final bool loading;
  final Object? error;
}

class NearbyCarsController extends Notifier<NearbyCarsState> {
  static const interval = Duration(seconds: 10);
  static const minMoveMeters = 150.0;
  Timer? _timer;
  GeoPoint? _around;
  String? _vehicleType;
  bool _paused = false;

  @override
  NearbyCarsState build() {
    ref.onDispose(() => _timer?.cancel());
    return const NearbyCarsState();
  }

  bool get paused => _paused;

  /// Keep polling around this point (call again when the person moves).
  void watch(double lat, double lng, {String? vehicleType}) {
    final p = (lat: lat, lng: lng);
    final moved = _around == null || geoDistanceMeters(_around!, p) > minMoveMeters || vehicleType != _vehicleType;
    _around = p;
    _vehicleType = vehicleType;
    if (_paused) return;
    if (_timer == null) {
      _timer = Timer.periodic(interval, (_) => _poll());
      _poll();
    } else if (moved) {
      _poll();
    }
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  /// The home is covered (another screen on top): stop polling but remember where.
  void pause() {
    _paused = true;
    stop();
  }

  /// The home is visible again: poll at once and keep polling.
  void resume() {
    if (!_paused) return;
    _paused = false;
    final p = _around;
    if (p != null) watch(p.lat, p.lng, vehicleType: _vehicleType);
  }

  Future<void> _poll() async {
    final p = _around;
    if (p == null) return;
    state = NearbyCarsState(data: state.data, loading: state.data.cars.isEmpty);
    try {
      final r = await ref.read(apisProvider).locations.nearby(p.lat, p.lng, vehicleType: _vehicleType);
      state = NearbyCarsState(data: r);
    } catch (e) {
      state = NearbyCarsState(data: state.data, error: e);
    }
  }
}

final nearbyCarsProvider = NotifierProvider<NearbyCarsController, NearbyCarsState>(NearbyCarsController.new);

class _Car {
  _Car(this.id, this.anim, this.born);
  final int id;
  final MarkerAnimator anim;
  final DateTime born;
  DateTime? leaving;
}

/// Glides the polled cars between positions. Owned by the screen (needs a ticker); the map
/// listens to [frames].
class CarsAnimator {
  CarsAnimator({required TickerProvider vsync, DateTime Function()? now, this.fade = const Duration(milliseconds: 400)}) : _now = now ?? DateTime.now {
    _ticker = vsync.createTicker((_) => tick());
  }
  final DateTime Function() _now;
  final Duration fade;
  late final Ticker _ticker;
  final _cars = <_Car>[];
  int _nextId = 0;
  bool _paused = false;

  final _frames = ValueNotifier<List<NearbyCarFrame>>(const []);
  /// The cars as drawn this frame (one new list per tick while anything moves).
  ValueListenable<List<NearbyCarFrame>> get frames => _frames;

  /// The first car still on the map (the nearest, as the server sorts them).
  CarPose? get lead {
    for (final c in _cars) {
      final p = c.anim.pose;
      if (c.leaving == null && p != null) return CarPose(position: LatLng(p.lat, p.lng), heading: p.heading);
    }
    return null;
  }

  /// Older form: the cars as poses.
  List<CarPose> get poses => [
        for (final c in _cars)
          if (c.leaving == null && c.anim.pose != null) CarPose(position: LatLng(c.anim.pose!.lat, c.anim.pose!.lng), heading: c.anim.pose!.heading),
      ];

  bool get isTicking => _ticker.isActive;

  /// The map is covered: stop animating (positions jump to their latest when resumed).
  set paused(bool v) {
    if (v == _paused) return;
    _paused = v;
    if (v) {
      if (_ticker.isActive) _ticker.stop();
    } else {
      _start();
    }
  }

  bool get paused => _paused;

  void update(List<NearbyCar> cars) {
    final now = _now();
    final remaining = [for (final c in _cars) if (c.leaving == null) c];
    final next = <_Car>[];
    for (final car in cars) {
      final p = (lat: car.lat, lng: car.lng);
      _Car? best;
      var bestD = 150.0;
      for (final c in remaining) {
        final d = c.anim.pose == null ? double.infinity : geoDistanceMeters(c.anim.pose!.point, p);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best != null) {
        remaining.remove(best);
      } else {
        best = _Car(_nextId++, MarkerAnimator(now: _now, maxGlide: const Duration(seconds: 3), deadReckonFor: Duration.zero), now);
      }
      best.anim.push(p, heading: car.heading, at: now);
      next.add(best);
    }
    for (final gone in remaining) {
      gone.leaving = now;
    }
    // the ones fading out stay at the end until they're gone
    final fading = [for (final c in _cars) if (c.leaving != null) c];
    _cars
      ..clear()
      ..addAll(next)
      ..addAll(fading);
    _publish(now);
    _start();
  }

  void _start() {
    if (!_paused && _cars.isNotEmpty && !_ticker.isActive) _ticker.start();
  }

  /// One frame (the ticker calls it; tests call it by hand).
  void tick([DateTime? at]) {
    final now = at ?? _now();
    for (final c in _cars) {
      c.anim.advance(now);
    }
    _cars.removeWhere((c) {
      final gone = c.leaving != null && now.difference(c.leaving!) >= fade;
      if (gone) c.anim.dispose();
      return gone;
    });
    final busy = _cars.any((c) => c.anim.isAnimating || now.difference(c.born) < fade || c.leaving != null);
    _publish(now);
    if (!busy && _ticker.isActive) _ticker.stop();
  }

  void _publish(DateTime now) {
    final fadeMs = max(1, fade.inMilliseconds);
    _frames.value = [
      for (final c in _cars)
        if (c.anim.pose != null)
          NearbyCarFrame(
            id: c.id,
            lat: c.anim.pose!.lat,
            lng: c.anim.pose!.lng,
            bearing: c.anim.pose!.heading,
            opacity: c.leaving != null ? (1 - now.difference(c.leaving!).inMilliseconds / fadeMs).clamp(0.0, 1.0) : (now.difference(c.born).inMilliseconds / fadeMs).clamp(0.0, 1.0),
          ),
    ];
  }

  void dispose() {
    _ticker.dispose();
    for (final c in _cars) {
      c.anim.dispose();
    }
    _frames.dispose();
  }
}
