// The trip in progress, for either side: loaded from GET /api/trips/active at boot, updated by
// every `trip:status` event, refetched when the socket reconnects or the app resumes (events may
// have been missed). Also the other side's name and car (/parties) and the driver's live position.
// A dispatcher can move a matched trip to another driver: the old driver gets `trip:reassigned`
// (the trip leaves them), the rider a `trip:status` with the new driver (their parties refetch).

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/network/providers.dart';
import '../../../core/realtime/realtime_hub.dart';
import '../../../core/session/session_controller.dart';

class ActiveTripController extends AsyncNotifier<Trip?> {
  StreamSubscription<RealtimeEvent>? _events;
  StreamSubscription<RealtimeState>? _states;

  @override
  Future<Trip?> build() async {
    final session = ref.watch(currentSessionProvider);
    if (session == null) return null;
    final hub = ref.watch(realtimeHubProvider);
    _events?.cancel();
    _events = hub.events.listen((e) {
      if (e is TripStatusEvent) _apply(e.trip);
      if (e is TripReassignedEvent) _reassigned(e);
    });
    _states?.cancel();
    _states = hub.states.listen((s) {
      if (s == RealtimeState.connected) refresh();
    });
    ref.onDispose(() {
      _events?.cancel();
      _states?.cancel();
    });
    try {
      return await ref.read(apisProvider).trips.active();
    } on AppError catch (e) {
      if (e.isNetwork) return state.value; // keep the last trip while offline
      rethrow;
    }
  }

  void _apply(Trip t) {
    final current = state.value;
    if (current != null && current.id != t.id && current.isActive) return; // another trip's event (stale)
    // another driver now (reassigned by dispatch): the name, photo and car are someone else's
    if (current?.id == t.id && current?.driver?.userId != null && current?.driver?.userId != t.driver?.userId) ref.invalidate(tripPartiesProvider(t.id));
    state = AsyncData(t); // ended trips stay until the screen is done with them
  }

  /// This driver's trip went to someone else: it isn't theirs to show any more.
  void _reassigned(TripReassignedEvent e) {
    if (state.value?.id != e.tripId) return;
    ref.read(tripReassignedProvider.notifier).set(e);
    state = const AsyncData(null);
  }

  /// A trip the app just created or acted on.
  void set(Trip t) => state = AsyncData(t);

  /// The ended trip was seen (rated, receipt closed): back to no active trip.
  void clearIfEnded() {
    final t = state.value;
    if (t != null && !t.isActive) state = const AsyncData(null);
  }

  Future<void> refresh() async {
    try {
      final t = await ref.read(apisProvider).trips.active();
      if (t != null) {
        state = AsyncData(t);
      } else if (state.value?.isActive ?? false) {
        // it ended while we were away: fetch its final state
        final ended = await ref.read(apisProvider).trips.get(state.value!.id);
        state = AsyncData(ended);
      }
    } catch (_) {}
  }

  /// Apply a transition's result (driver actions, cancel).
  void replace(Trip t) => state = AsyncData(t);
}

final activeTripProvider = AsyncNotifierProvider<ActiveTripController, Trip?>(ActiveTripController.new);

/// The last `trip:reassigned` that took the active trip away (the driver trip screen leaves and
/// says so, then clears it).
class TripReassigned extends Notifier<TripReassignedEvent?> {
  @override
  TripReassignedEvent? build() => null;
  void set(TripReassignedEvent? e) => state = e;
}

final tripReassignedProvider = NotifierProvider<TripReassigned, TripReassignedEvent?>(TripReassigned.new);

/// One trip by id: the active one when it matches, else fetched (history, receipts).
final tripProvider = FutureProvider.family<Trip, String>((ref, id) async {
  final active = ref.watch(activeTripProvider).value;
  if (active?.id == id) return active!;
  return ref.read(apisProvider).trips.get(id);
});

/// The other side's name and car.
final tripPartiesProvider = FutureProvider.family<TripParties, String>((ref, tripId) => ref.read(apisProvider).trips.parties(tripId));

@immutable
class DriverLive {
  const DriverLive({required this.lat, required this.lng, this.heading, this.speed, required this.at});
  final double lat;
  final double lng;
  final double? heading;
  /// m/s, when the socket carried it (polled positions don't)
  final double? speed;
  final DateTime at;
}

/// The driver's live position on a trip: the socket room, with an HTTP poll every 5 s while the
/// room isn't joined. The gateway admits the trip's rider only once location-service has the
/// match (from Kafka), which can trail the `trip:status` that made us ask, so a refused join is
/// retried on the same 5 s beat.
final driverLiveProvider = StreamProvider.family<DriverLive, String>((ref, tripId) {
  final hub = ref.watch(realtimeHubProvider);
  final api = ref.read(apisProvider).locations;
  final ctrl = StreamController<DriverLive>();
  var joined = false;
  Future<void> join() async => joined = await hub.subscribeTrip(tripId);
  join();
  final sub = hub.events.listen((e) {
    if (e is DriverLocationEvent && e.tripId == tripId) ctrl.add(DriverLive(lat: e.lat, lng: e.lng, heading: e.heading, speed: e.speed, at: e.at));
  });
  // after a drop the hub rejoins its rooms; if that is refused too, the next tick asks again
  final states = hub.states.listen((s) {
    if (s != RealtimeState.connected) joined = false;
  });
  final poll = Timer.periodic(const Duration(seconds: 5), (_) async {
    if (hub.connected && joined) return;
    if (hub.connected) join();
    try {
      final p = await api.tripDriver(tripId);
      if (p != null) ctrl.add(DriverLive(lat: p.lat, lng: p.lng, heading: p.heading, at: p.at));
    } catch (_) {}
  });
  // a first fix without waiting for a ping
  api.tripDriver(tripId).then((p) {
    if (p != null && !ctrl.isClosed) ctrl.add(DriverLive(lat: p.lat, lng: p.lng, heading: p.heading, at: p.at));
  }).catchError((_) {});
  ref.onDispose(() {
    sub.cancel();
    states.cancel();
    poll.cancel();
    hub.unsubscribeTrip(tripId);
    ctrl.close();
  });
  return ctrl.stream;
});
