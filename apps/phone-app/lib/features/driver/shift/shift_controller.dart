// The driver's shift (workflow 04): what fleet-service knows about this driver, the car to go
// online with, the open session, and the location streamer that pings the gateway every ~4 s
// while online (10 s when standing still), counting rejections so the UI can warn about GPS.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/location/location_source.dart';
import '../../../core/network/providers.dart';
import '../../../core/realtime/realtime_hub.dart';
import '../../../core/session/session_controller.dart';

/// GET /api/fleet/drivers/me: profile + checklist, cars, open session.
class DriverHomeController extends AsyncNotifier<DriverHome> {
  @override
  Future<DriverHome> build() async {
    final session = ref.watch(currentSessionProvider);
    if (session == null) return DriverHome.empty;
    return ref.read(apisProvider).fleet.me();
  }

  Future<void> refresh() async {
    try {
      state = AsyncData(await ref.read(apisProvider).fleet.me());
    } catch (e, st) {
      if (state.value == null) state = AsyncError(e, st);
    }
  }

  void setSession(DrivingSession? s) {
    final cur = state.value ?? DriverHome.empty;
    state = AsyncData(DriverHome(driver: cur.driver, vehicles: cur.vehicles, fleetVehicles: cur.fleetVehicles, session: s));
  }
}

final driverHomeProvider = AsyncNotifierProvider<DriverHomeController, DriverHome>(DriverHomeController.new);

/// The driver's cars with whether each may go online now.
final drivableVehiclesProvider = FutureProvider<List<Vehicle>>((ref) {
  ref.watch(driverHomeProvider); // refetch when the home changes
  return ref.read(apisProvider).fleet.drivableVehicles();
});

@immutable
class ShiftState {
  const ShiftState({this.session, this.vehicle, this.busy = false, this.error, this.endedReason, this.pingsOk = 0, this.pingsRejected = 0, this.lastReason});
  final DrivingSession? session;
  final Vehicle? vehicle;
  final bool busy;
  final Object? error;
  /// why the last session ended on the server's side (CONNECTION_LOST, BALANCE_BLOCKED, …)
  final String? endedReason;
  final int pingsOk;
  final int pingsRejected;
  final String? lastReason;
  bool get online => session?.isOpen ?? false;
  bool get gpsPoor => pingsRejected >= 5 && pingsRejected > pingsOk;
  ShiftState copyWith({DrivingSession? session, Vehicle? vehicle, bool? busy, Object? error, String? endedReason, int? pingsOk, int? pingsRejected, String? lastReason, bool clearSession = false, bool clearError = false, bool clearEnded = false}) => ShiftState(
        session: clearSession ? null : (session ?? this.session), vehicle: vehicle ?? this.vehicle, busy: busy ?? this.busy, error: clearError ? null : (error ?? this.error),
        endedReason: clearEnded ? null : (endedReason ?? this.endedReason), pingsOk: pingsOk ?? this.pingsOk, pingsRejected: pingsRejected ?? this.pingsRejected, lastReason: lastReason ?? this.lastReason,
      );
}

class ShiftController extends Notifier<ShiftState> {
  static const _lastVehicleKey = 'last_vehicle_id';
  StreamSubscription<DevicePosition>? _positions;
  Timer? _resume;
  DateTime? _lastSent;
  DevicePosition? _last;
  String? _goOnlineKey;

  @override
  ShiftState build() {
    ref.onDispose(_stopStreaming);
    // follow the server's view of the session (boot, refresh, forced offline)
    ref.listen(driverHomeProvider, (prev, next) {
      final s = next.value?.session;
      if (s != null && s.isOpen) {
        if (!state.online) {
          state = state.copyWith(session: s, vehicle: next.value!.allVehicles.where((v) => v.id == s.vehicleId).firstOrNull, clearEnded: true);
          _startStreaming();
        }
      } else if (state.online && next.hasValue) {
        final reason = s?.endReason ?? prev?.value?.session?.endReason;
        state = state.copyWith(clearSession: true, endedReason: reason);
        _stopStreaming();
      }
    }, fireImmediately: true);
    // every 60 s while online, confirm the session is still open (forced offline, connection lost)
    final poll = Timer.periodic(const Duration(seconds: 60), (_) {
      if (state.online) ref.read(driverHomeProvider.notifier).refresh();
    });
    ref.onDispose(poll.cancel);
    return const ShiftState();
  }

  String? get lastVehicleId => ref.read(prefsProvider).getString(_lastVehicleKey);

  Future<void> goOnline(Vehicle v) async {
    state = state.copyWith(busy: true, clearError: true, clearEnded: true, vehicle: v);
    _goOnlineKey ??= newIdempotencyKey();
    try {
      final src = ref.read(locationSourceProvider);
      final perm = await src.ensurePermission(LocationProfile.driverOnline);
      if (perm != LocationPermissionState.granted) {
        state = state.copyWith(busy: false, error: AppError(status: 0, code: perm == LocationPermissionState.serviceOff ? 'location_off' : 'location_denied', message: ''));
        return;
      }
      final s = await ref.read(apisProvider).fleet.goOnline(v.id, idempotencyKey: _goOnlineKey!);
      _goOnlineKey = null;
      await ref.read(prefsProvider).setString(_lastVehicleKey, v.id);
      state = state.copyWith(session: s, vehicle: v, busy: false, pingsOk: 0, pingsRejected: 0);
      ref.read(driverHomeProvider.notifier).setSession(s);
      _startStreaming();
    } on AppError catch (e) {
      if (e.code != ErrorCodes.network && e.code != ErrorCodes.timeout) _goOnlineKey = null;
      if (e.code == ErrorCodes.alreadyOnline) {
        await ref.read(driverHomeProvider.notifier).refresh();
      }
      state = state.copyWith(busy: false, error: e);
    } catch (e) {
      state = state.copyWith(busy: false, error: e);
    }
  }

  Future<void> goOffline() async {
    state = state.copyWith(busy: true, clearError: true);
    try {
      await ref.read(apisProvider).fleet.goOffline();
    } on AppError catch (e) {
      if (!e.isNotFound) {
        state = state.copyWith(busy: false, error: e);
        return;
      }
    }
    _stopStreaming();
    state = state.copyWith(busy: false, clearSession: true, clearEnded: true);
    ref.read(driverHomeProvider.notifier).setSession(null);
  }

  void _startStreaming() {
    _positions?.cancel();
    final src = ref.read(locationSourceProvider);
    _positions = src.watch(LocationProfile.driverOnline).listen(_onPosition, onError: (_) {});
    // when standing still the stream may go quiet: keep a heartbeat every 10 s
    _resume?.cancel();
    _resume = Timer.periodic(const Duration(seconds: 10), (_) {
      if (_last != null && (_lastSent == null || DateTime.now().difference(_lastSent!) >= const Duration(seconds: 10))) _send(_last!);
    });
  }

  void _stopStreaming() {
    _positions?.cancel();
    _positions = null;
    _resume?.cancel();
    _resume = null;
  }

  void _onPosition(DevicePosition p) {
    _last = p;
    ref.read(lastPositionProvider.notifier).set(p);
    final moving = (p.speed ?? 0) > 1;
    final interval = moving ? const Duration(seconds: 4) : const Duration(seconds: 10);
    if (_lastSent != null && DateTime.now().difference(_lastSent!) < interval) return;
    _send(p);
  }

  Future<void> _send(DevicePosition p) async {
    if (!state.online) return;
    _lastSent = DateTime.now();
    final ack = await ref.read(realtimeHubProvider).sendLocation(p.toPing());
    if (ack.accepted) {
      state = state.copyWith(pingsOk: state.pingsOk + 1, pingsRejected: 0, lastReason: '');
    } else if (ack.reason != 'offline' && ack.reason != 'too_frequent' && ack.reason != 'timeout') {
      state = state.copyWith(pingsRejected: state.pingsRejected + 1, lastReason: ack.reason);
    }
  }
}

final shiftProvider = NotifierProvider<ShiftController, ShiftState>(ShiftController.new);
