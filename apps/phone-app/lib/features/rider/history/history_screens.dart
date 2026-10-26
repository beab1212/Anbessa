// Past trips (both sides) and one trip's receipt.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/network/providers.dart';
import '../../maps/anbessa_map.dart';
import '../payments/pay_screen.dart';
import '../trip/active_trip_controller.dart';

class TripHistory extends AsyncNotifier<({List<Trip> trips, String? next})> {
  TripHistory(this.arg);
  /// rider | driver
  final String arg;
  @override
  Future<({List<Trip> trips, String? next})> build() => ref.read(apisProvider).trips.list(as: arg);

  Future<void> more() async {
    final cur = state.value;
    if (cur == null || cur.next == null) return;
    final page = await ref.read(apisProvider).trips.list(as: arg, before: cur.next);
    state = AsyncData((trips: [...cur.trips, ...page.trips], next: page.next));
  }

  Future<void> refresh() async => state = AsyncData(await ref.read(apisProvider).trips.list(as: arg));
}

final tripHistoryProvider = AsyncNotifierProvider.family<TripHistory, ({List<Trip> trips, String? next}), String>(TripHistory.new);

class HistoryScreen extends ConsumerWidget {
  const HistoryScreen({super.key, required this.as, required this.receiptRoute});
  /// rider | driver
  final String as;
  final String Function(String id) receiptRoute;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final h = ref.watch(tripHistoryProvider(as));
    final trips = h.value?.trips ?? const <Trip>[];
    return Scaffold(
      appBar: AppBar(title: Text(l.activityTitle)),
      body: RefreshIndicator(
        onRefresh: () => ref.read(tripHistoryProvider(as).notifier).refresh(),
        child: h.isLoading && trips.isEmpty
            ? const Center(child: CircularProgressIndicator())
            : trips.isEmpty
                ? ListView(children: [const SizedBox(height: 80), EmptyState(icon: Icons.receipt_long_outlined, title: l.noTrips, body: l.noTripsLede)])
                : ListView.separated(
                    itemCount: trips.length + (h.value?.next != null ? 1 : 0),
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (context, i) {
                      if (i == trips.length) {
                        return TextButton(onPressed: () => ref.read(tripHistoryProvider(as).notifier).more(), child: Text(l.next));
                      }
                      final t = trips[i];
                      return ListTile(
                        leading: Icon(t.status == TripStatus.cancelled ? Icons.cancel_outlined : Icons.directions_car, color: t.status == TripStatus.cancelled ? c.danger : c.accentStrong),
                        title: Text(t.dropoff.address ?? t.vehicleType, maxLines: 1, overflow: TextOverflow.ellipsis),
                        subtitle: Text('${dayAndTime(t.times.requestedAt, locale: context.localeTag)} · ${tripStatusLabel(l, t.status)}'),
                        trailing: MoneyText(t.status == TripStatus.cancelled ? (t.cancellation?.feeMinor ?? 0) : t.fare.chargedMinor, locale: context.localeTag, style: const TextStyle(fontWeight: FontWeight.w600)),
                        onTap: () => context.push(receiptRoute(t.id)),
                      );
                    },
                  ),
      ),
    );
  }
}

class ReceiptScreen extends ConsumerWidget {
  const ReceiptScreen({super.key, required this.tripId, required this.asDriver});
  final String tripId;
  final bool asDriver;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final tripAsync = ref.watch(tripProvider(tripId));
    final t = tripAsync.value;
    final money = asDriver ? ref.watch(tripPaymentsProvider(tripId)).value : null;
    final settlement = money?.settlements.where((s) => s.purpose == 'TRIP_FARE').firstOrNull;
    return Scaffold(
      appBar: AppBar(title: Text(l.receiptTitle)),
      body: t == null
          ? (tripAsync.hasError ? Padding(padding: const EdgeInsets.all(16), child: Problem(tripAsync.error, describe: (e) => describeError(l, e))) : const Center(child: CircularProgressIndicator()))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                SizedBox(
                  height: 180,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(anbessaRadiusLg),
                    child: AnbessaMap(fit: [LatLng(t.pickup.lat, t.pickup.lng), LatLng(t.dropoff.lat, t.dropoff.lng)], pickup: LatLng(t.pickup.lat, t.pickup.lng), dropoff: LatLng(t.dropoff.lat, t.dropoff.lng), line: [LatLng(t.pickup.lat, t.pickup.lng), LatLng(t.dropoff.lat, t.dropoff.lng)], interactive: false),
                  ),
                ),
                const SizedBox(height: 12),
                Row(children: [StatusPill(tripStatusLabel(l, t.status), tone: t.status == TripStatus.completed ? Tone.green : t.status == TripStatus.cancelled ? Tone.red : Tone.blue), const Spacer(), Text(dayAndTime(t.times.requestedAt, locale: context.localeTag), style: TextStyle(color: c.muted))]),
                const SizedBox(height: 12),
                ReceiptCard(trip: t),
                if (settlement != null) ...[
                  const SizedBox(height: 12),
                  SectionCard(
                    title: l.yourBalanceChange,
                    child: Column(
                      children: [
                        KeyValue(l.commissionLabel, MoneyText(settlement.commissionMinor, locale: context.localeTag)),
                        KeyValue(l.vatLabel, MoneyText(settlement.vatMinor, locale: context.localeTag)),
                        KeyValue(l.yourBalanceChange, MoneyText(settlement.earningsMinor, locale: context.localeTag, signed: true, style: TextStyle(fontWeight: FontWeight.w700, color: settlement.earningsMinor < 0 ? c.danger : c.success))),
                      ],
                    ),
                  ),
                ],
              ],
            ),
    );
  }
}
