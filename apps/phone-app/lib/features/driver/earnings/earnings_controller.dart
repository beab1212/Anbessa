// The driver's balance (Payment.md §5, §8, §9): loaded for the driver's city, refreshed on
// `balance:topped_up`, after trips settle, and every minute while the screen is open.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/network/providers.dart';
import '../../../core/realtime/realtime_hub.dart';
import '../../../core/session/session_controller.dart';
import '../../config/client_config_provider.dart';

class BalanceController extends AsyncNotifier<Balance?> {
  StreamSubscription<RealtimeEvent>? _sub;
  TopUp? lastTopUp;

  @override
  Future<Balance?> build() async {
    final session = ref.watch(currentSessionProvider);
    if (session == null || !session.canDrive) return null;
    _sub?.cancel();
    _sub = ref.watch(realtimeHubProvider).events.listen((e) {
      if (e is BalanceToppedUpEvent) {
        lastTopUp = e.topUp;
        refresh();
      }
      if (e is TripStatusEvent && (e.status == TripStatus.completed || e.status == TripStatus.cancelled)) Future.delayed(const Duration(seconds: 3), refresh);
    });
    ref.onDispose(() => _sub?.cancel());
    return _load();
  }

  Future<Balance?> _load({bool open = false}) async {
    final city = ref.read(currentCityProvider);
    return ref.read(apisProvider).payments.myBalance(cityId: city.id, open: open);
  }

  Future<void> refresh() async {
    try {
      state = AsyncData(await _load());
    } catch (_) {}
  }

  /// Opens the account (first top-up before any trip).
  Future<Balance> open() async {
    final b = await _load(open: true);
    state = AsyncData(b);
    return b!;
  }
}

final balanceProvider = AsyncNotifierProvider<BalanceController, Balance?>(BalanceController.new);

/// The driver's incentive programs in their city with their own progress
/// (GET /api/payments/incentives/me). Empty for riders; refreshed with the earnings screen.
final incentivesProvider = FutureProvider<List<Incentive>>((ref) async {
  final session = ref.watch(currentSessionProvider);
  if (session == null || !session.canDrive) return const [];
  final city = ref.watch(currentCityProvider);
  return ref.read(apisProvider).payments.myIncentives(cityId: city.id);
});
