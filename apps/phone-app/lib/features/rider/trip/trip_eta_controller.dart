// The road and the time from the car to its target (the pickup, then the drop-off), refreshed
// every 30 s or when the target changes. Feeds the ETA badge and the line on the rider's map.

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../maps/nav/navigation_controller.dart';

@immutable
class TripEta {
  const TripEta({required this.seconds, required this.meters, required this.polyline6, required this.approximate, required this.at});
  final int seconds;
  final int meters;
  final String polyline6;
  final bool approximate;
  final DateTime at;
}

class TripEtaController extends Notifier<TripEta?> {
  TripEtaController(this.tripId);
  final String tripId;
  static const refreshEvery = Duration(seconds: 30);
  GeoPoint? _target;
  DateTime? _fetchedAt;
  bool _busy = false;

  @override
  TripEta? build() => null;

  /// Call with each new car position; it decides whether a new route is worth asking for.
  Future<void> track(GeoPoint from, GeoPoint to) async {
    final targetChanged = _target == null || geoDistanceMeters(_target!, to) > 20;
    final stale = _fetchedAt == null || DateTime.now().difference(_fetchedAt!) > refreshEvery;
    if (_busy || (!targetChanged && !stale)) return;
    _busy = true;
    _target = to;
    try {
      final r = await ref.read(routeFetcherProvider)(fromLat: from.lat, fromLng: from.lng, toLat: to.lat, toLng: to.lng, steps: false);
      _fetchedAt = DateTime.now();
      state = TripEta(seconds: r.durationSeconds, meters: r.distanceMeters, polyline6: r.polyline6, approximate: r.approximate, at: _fetchedAt!);
    } catch (_) {
      // keep the last answer; a straight-line guess is shown by the screen when there's none
      _fetchedAt = DateTime.now().subtract(refreshEvery - const Duration(seconds: 10));
    } finally {
      _busy = false;
    }
  }

  void reset() {
    _target = null;
    _fetchedAt = null;
    state = null;
  }
}

final tripEtaProvider = NotifierProvider.family<TripEtaController, TripEta?, String>(TripEtaController.new);
