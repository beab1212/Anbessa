// The cars around the rider: polled while the home is on screen, each one glided to its new
// position by a MarkerAnimator (re-matched between polls by proximity, so a car that moved keeps
// its animator instead of blinking out and back).

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/network/providers.dart';
import 'anbessa_map.dart';
import 'marker_animator.dart';

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

  @override
  NearbyCarsState build() {
    ref.onDispose(() => _timer?.cancel());
    return const NearbyCarsState();
  }

  /// Keep polling around this point (call again when the person moves).
  void watch(double lat, double lng, {String? vehicleType}) {
    final p = (lat: lat, lng: lng);
    final moved = _around == null || geoDistanceMeters(_around!, p) > minMoveMeters || vehicleType != _vehicleType;
    _around = p;
    _vehicleType = vehicleType;
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

/// Glides the polled cars between positions. Owned by the screen (needs a ticker).
class CarsAnimator extends ChangeNotifier {
  CarsAnimator({required TickerProvider vsync}) {
    _ticker = vsync.createTicker((_) {
      for (final a in _cars) {
        a.advance();
      }
      notifyListeners();
    });
  }
  late final Ticker _ticker;
  final _cars = <MarkerAnimator>[];

  List<CarPose> get poses => [
        for (final a in _cars)
          if (a.pose != null) CarPose(position: LatLng(a.pose!.lat, a.pose!.lng), heading: a.pose!.heading),
      ];

  void update(List<NearbyCar> cars) {
    final remaining = List.of(_cars);
    final next = <MarkerAnimator>[];
    for (final c in cars) {
      final p = (lat: c.lat, lng: c.lng);
      MarkerAnimator? best;
      var bestD = 150.0;
      for (final a in remaining) {
        final d = a.pose == null ? double.infinity : geoDistanceMeters(a.pose!.point, p);
        if (d < bestD) {
          bestD = d;
          best = a;
        }
      }
      if (best != null) {
        remaining.remove(best);
      } else {
        best = MarkerAnimator(maxGlide: const Duration(seconds: 3), deadReckonFor: Duration.zero);
      }
      best.push(p, heading: c.heading);
      next.add(best);
    }
    for (final gone in remaining) {
      gone.dispose();
    }
    _cars
      ..clear()
      ..addAll(next);
    if (_cars.isNotEmpty && !_ticker.isActive) _ticker.start();
    if (_cars.isEmpty && _ticker.isActive) _ticker.stop();
    notifyListeners();
  }

  @override
  void dispose() {
    _ticker.dispose();
    for (final a in _cars) {
      a.dispose();
    }
    super.dispose();
  }
}
