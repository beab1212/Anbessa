// Is the rider's last trip still waiting to be paid? Drives the dot on the Activity tab: the
// latest trip, if it ended digitally in the last day, and its fare payment is open or failed.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/network/providers.dart';
import '../trip/active_trip_controller.dart';

const _lookBack = Duration(hours: 24);

/// What of the active trip matters to the badge: which trip, and whether it is still live. A
/// trip:status (matched → en route → in progress) or a location update leaves this unchanged;
/// the trip ending (or going away, or another trip starting) changes it.
typedef PaymentDueKey = ({String? tripId, bool live});

PaymentDueKey paymentDueKeyOf(AsyncValue<Trip?> a) {
  final t = a.value;
  final live = t?.isActive ?? false;
  // an ended trip and no trip are the same to the badge (clearing a seen trip doesn't re-check)
  return (tripId: live ? t!.id : null, live: live);
}

final paymentDueProvider = FutureProvider<bool>((ref) async {
  // re-check only when a trip ends or the trip changes; a paid trip invalidates this (pay_screen)
  ref.watch(activeTripProvider.select(paymentDueKeyOf));
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
