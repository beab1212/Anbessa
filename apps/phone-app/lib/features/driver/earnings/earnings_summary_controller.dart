// What the driver made today / this week / this month (payment-service earnings summary).

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/network/providers.dart';
import '../../../core/session/session_controller.dart';

class EarningsSummaryController extends AsyncNotifier<EarningsSummary> {
  EarningsSummaryController(this.period);
  /// today | week | month
  final String period;
  @override
  Future<EarningsSummary> build() async {
    if (ref.watch(currentSessionProvider)?.canDrive != true) return EarningsSummary.empty;
    return ref.read(apisProvider).payments.earnings(period: period);
  }

  Future<void> refresh() async {
    try {
      state = AsyncData(await ref.read(apisProvider).payments.earnings(period: period));
    } catch (e, st) {
      if (state.value == null) state = AsyncError(e, st);
    }
  }
}

final earningsSummaryProvider = AsyncNotifierProvider.family<EarningsSummaryController, EarningsSummary, String>(EarningsSummaryController.new);
