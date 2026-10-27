// The rider's upcoming scheduled rides (workflow 12): GET /api/trips/scheduled?status=upcoming,
// refreshed on every `scheduled:status` push and when the socket reconnects. When a booking is
// dispatched the trip it created becomes the active trip (the router then opens it).

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/network/providers.dart';
import '../../../core/realtime/realtime_hub.dart';
import '../../../core/session/session_controller.dart';
import '../../config/client_config_provider.dart';
import '../trip/active_trip_controller.dart';

class ScheduledRidesController extends AsyncNotifier<List<ScheduledTrip>> {
  StreamSubscription<RealtimeEvent>? _events;
  StreamSubscription<RealtimeState>? _states;

  @override
  Future<List<ScheduledTrip>> build() async {
    final session = ref.watch(currentSessionProvider);
    if (session == null || !ref.watch(featureProvider(Feature.scheduledRides))) return const [];
    final hub = ref.watch(realtimeHubProvider);
    _events?.cancel();
    _events = hub.events.listen((e) {
      if (e is! ScheduledStatusEvent) return;
      if (e.status == ScheduledStatus.dispatched && e.tripId != null) {
        ref.read(activeTripProvider.notifier).refresh();
      }
      refresh();
    });
    _states?.cancel();
    _states = hub.states.listen((s) {
      if (s == RealtimeState.connected) refresh();
    });
    ref.onDispose(() {
      _events?.cancel();
      _states?.cancel();
    });
    return ref.read(apisProvider).trips.scheduled();
  }

  Future<void> refresh() async {
    try {
      state = AsyncData(await ref.read(apisProvider).trips.scheduled());
    } catch (e, st) {
      if (state.value == null) state = AsyncError(e, st);
    }
  }

  /// A booking the app just made, shown before the next refresh.
  void added(ScheduledTrip s) {
    final list = [...?state.value?.where((x) => x.id != s.id), s]..sort((a, b) => a.scheduledFor.compareTo(b.scheduledFor));
    state = AsyncData(list);
  }

  /// Free before dispatch; the cancelled booking leaves the upcoming list.
  Future<void> cancel(String id) async {
    final s = await ref.read(apisProvider).trips.cancelScheduled(id);
    state = AsyncData([...?state.value?.where((x) => x.id != id), if (s.upcoming) s]);
  }
}

final scheduledRidesProvider = AsyncNotifierProvider<ScheduledRidesController, List<ScheduledTrip>>(ScheduledRidesController.new);
