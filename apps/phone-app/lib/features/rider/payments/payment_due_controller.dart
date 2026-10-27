// Is the rider's last trip still waiting to be paid? Drives the dot on the Activity tab: the
// latest trip, if it ended digitally in the last day, and its fare payment is open or failed.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/network/providers.dart';
import '../trip/active_trip_controller.dart';

const _lookBack = Duration(hours: 24);

final paymentDueProvider = FutureProvider<bool>((ref) async {
  ref.watch(activeTripProvider); // a trip ending (or a payment going through it) re-checks
  final apis = ref.read(apisProvider);
  try {
    final last = (await apis.trips.list(as: 'rider', limit: 1)).trips.firstOrNull;
    final ended = last?.times.completedAt;
    if (last == null || last.status != TripStatus.completed || !last.isDigital || ended == null) return false;
    if (DateTime.now().difference(ended) > _lookBack) return false;
    final fare = (await apis.payments.tripPayments(last.id)).fare;
    return fare != null && (fare.isOpen || fare.isOwed);
  } catch (_) {
    return false; // a badge is never worth an error
  }
});
