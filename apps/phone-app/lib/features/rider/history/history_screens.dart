// Past trips (both sides), grouped by day with a period filter, and one trip's receipt.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:share_plus/share_plus.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/network/providers.dart';
import '../../../core/router/routes.dart';
import '../../../core/session/session_controller.dart';
import '../../config/client_config_provider.dart';
import '../../maps/anbessa_map.dart';
import '../../support/support_repository.dart';
import '../../support/support_widgets.dart';
import '../payments/pay_screen.dart';
import '../scheduled/scheduled_rides_controller.dart';
import '../scheduled/scheduled_rides_screen.dart';
import '../trip/active_trip_controller.dart';

class TripHistory extends AsyncNotifier<({List<Trip> trips, String? next})> {
  TripHistory(this.arg);
  /// rider | driver
  final String arg;
  bool _loadingMore = false;
  @override
  Future<({List<Trip> trips, String? next})> build() => ref.read(apisProvider).trips.list(as: arg);

  Future<void> more() async {
    final cur = state.value;
    if (cur == null || cur.next == null || _loadingMore) return;
    _loadingMore = true;
    try {
      final page = await ref.read(apisProvider).trips.list(as: arg, before: cur.next);
      state = AsyncData((trips: [...cur.trips, ...page.trips], next: page.next));
    } finally {
      _loadingMore = false;
    }
  }

  Future<void> refresh() async => state = AsyncData(await ref.read(apisProvider).trips.list(as: arg));
}

final tripHistoryProvider = AsyncNotifierProvider.family<TripHistory, ({List<Trip> trips, String? next}), String>(TripHistory.new);

enum HistoryPeriod { all, week, month }

class HistoryScreen extends ConsumerStatefulWidget {
  const HistoryScreen({super.key, required this.as, required this.receiptRoute});
  /// rider | driver
  final String as;
  final String Function(String id) receiptRoute;
  @override
  ConsumerState<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends ConsumerState<HistoryScreen> {
  late String _as = widget.as;
  HistoryPeriod _period = HistoryPeriod.all;
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (_scroll.position.extentAfter < 400) ref.read(tripHistoryProvider(_as).notifier).more();
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final session = ref.watch(currentSessionProvider);
    final both = session?.canDrive ?? false;
    final h = ref.watch(tripHistoryProvider(_as));
    // the rider's upcoming scheduled rides sit above the past trips
    final rider = _as == 'rider';
    final now = DateTime.now();
    final since = switch (_period) {
      HistoryPeriod.week => now.subtract(const Duration(days: 7)),
      HistoryPeriod.month => DateTime(now.year, now.month - 1, now.day),
      HistoryPeriod.all => null,
    };
    final trips = (h.value?.trips ?? const <Trip>[]).where((t) => since == null || t.times.requestedAt.isAfter(since)).toList();
    // group by day
    final groups = <String, List<Trip>>{};
    for (final t in trips) {
      groups.putIfAbsent(_dayLabel(l, t.times.requestedAt, now), () => []).add(t);
    }
    return Scaffold(
      appBar: AppBar(title: Text(l.activityTitle)),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
            child: Column(
              children: [
                if (both) ...[
                  PillTabs<String>(items: [('rider', l.asRider), ('driver', l.asDriver)], selected: _as, onChanged: (v) => setState(() => _as = v)),
                  const SizedBox(height: 8),
                ],
                PillTabs<HistoryPeriod>(items: [(HistoryPeriod.all, l.filterAll), (HistoryPeriod.week, l.filterThisWeek), (HistoryPeriod.month, l.filterThisMonth)], selected: _period, onChanged: (v) => setState(() => _period = v)),
              ],
            ),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: () async {
                if (rider) ref.read(scheduledRidesProvider.notifier).refresh();
                await ref.read(tripHistoryProvider(_as).notifier).refresh();
              },
              child: h.isLoading && trips.isEmpty
                  ? const Padding(padding: EdgeInsets.symmetric(horizontal: 16), child: SkeletonList(rows: 6))
                  : h.hasError && trips.isEmpty
                      ? ListView(children: [Padding(padding: const EdgeInsets.all(16), child: Problem(h.error, describe: (e) => describeError(l, e), onRetry: () => ref.read(tripHistoryProvider(_as).notifier).refresh(), retryLabel: l.retry))])
                      : trips.isEmpty
                          ? ListView(padding: const EdgeInsets.symmetric(horizontal: 16), children: [if (rider) const UpcomingRidesSection(), const SizedBox(height: 60), IllustratedEmpty(illustration: AnbessaIllustration.noTrips, title: l.noTrips, body: l.noTripsLede)])
                          : ListView(
                              controller: _scroll,
                              padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                              children: [
                                if (rider) const UpcomingRidesSection(),
                                for (final e in groups.entries) ...[
                                  Padding(padding: const EdgeInsets.fromLTRB(4, 14, 4, 6), child: Text(e.key, style: AnbessaType.label.copyWith(color: c.muted, letterSpacing: 0.4))),
                                  SectionGroup(
                                    margin: EdgeInsets.zero,
                                    children: [for (final t in e.value) _TripRow(trip: t, driverSide: _as == 'driver', onTap: () => context.push(widget.receiptRoute(t.id)))],
                                  ),
                                ],
                                if (h.value?.next != null) const Padding(padding: EdgeInsets.all(16), child: Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)))),
                              ],
                            ),
            ),
          ),
        ],
      ),
    );
  }

  String _dayLabel(AppLocalizations l, DateTime at, DateTime now) {
    final d = toAddis(at), n = toAddis(now);
    if (d.year == n.year && d.month == n.month && d.day == n.day) return l.today;
    final y = n.subtract(const Duration(days: 1));
    if (d.year == y.year && d.month == y.month && d.day == y.day) return l.yesterday;
    return dayOf(at, locale: context.localeTag);
  }
}

class _TripRow extends StatelessWidget {
  const _TripRow({required this.trip, required this.onTap, this.driverSide = false});
  final Trip trip;
  /// drivers see the fare their earning is based on; riders what they paid
  final bool driverSide;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final cancelled = trip.status == TripStatus.cancelled;
    final amount = cancelled ? (trip.cancellation?.feeMinor ?? 0) : (driverSide ? trip.fare.chargedMinor : trip.fare.payableMinor);
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(trip.dropoff.address ?? trip.vehicleType, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.body.copyWith(fontWeight: FontWeight.w500, color: c.text)),
                  const SizedBox(height: 2),
                  Row(children: [Text(clockOf(trip.times.requestedAt), style: AnbessaType.caption.copyWith(color: c.muted, fontFeatures: AnbessaType.tabular)), const SizedBox(width: 6), Flexible(child: StatusPill(tripStatusLabel(l, trip.status), tone: cancelled ? Tone.red : trip.status == TripStatus.completed ? Tone.green : Tone.blue))]),
                ],
              ),
            ),
            const SizedBox(width: 8),
            MoneyText(amount, locale: context.localeTag, style: AnbessaType.body.copyWith(fontWeight: FontWeight.w700, color: cancelled ? c.muted : c.text)),
          ],
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
    final parties = t?.driver == null ? null : ref.watch(tripPartiesProvider(tripId)).value;
    final supportOn = ref.watch(featureProvider(Feature.support));
    // the rider's report about this trip, if there is one (support-service keeps one live per trip)
    final report = supportOn && !asDriver ? ref.watch(myLostItemsProvider).value?.where((i) => i.tripId == tripId && i.isRider).firstOrNull : null;
    return Scaffold(
      appBar: AppBar(
        title: Text(l.receiptTitle),
        actions: [
          if (t != null)
            IconButton(
              tooltip: l.shareReceipt,
              icon: const Icon(Icons.share_outlined),
              onPressed: () => SharePlus.instance.share(ShareParams(text: l.receiptShareText(dayAndTime(t.times.requestedAt, locale: context.localeTag), t.pickup.address ?? '—', t.dropoff.address ?? '—', birr(asDriver ? t.fare.chargedMinor : t.fare.payableMinor, locale: context.localeTag), shortId(t.id)))),
            ),
        ],
      ),
      body: t == null
          ? (tripAsync.hasError ? Padding(padding: const EdgeInsets.all(16), child: Problem(tripAsync.error, describe: (e) => describeError(l, e))) : const Padding(padding: EdgeInsets.all(16), child: Column(children: [SkeletonCard(height: 180), SizedBox(height: 12), SkeletonCard(height: 220)])))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                SizedBox(
                  height: 190,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(AnbessaRadius.lg),
                    child: AnbessaMap(
                      fit: [LatLng(t.pickup.lat, t.pickup.lng), LatLng(t.dropoff.lat, t.dropoff.lng)],
                      pickup: LatLng(t.pickup.lat, t.pickup.lng),
                      dropoff: LatLng(t.dropoff.lat, t.dropoff.lng),
                      routes: [t.route.polyline == null ? RouteLine.straight(LatLng(t.pickup.lat, t.pickup.lng), LatLng(t.dropoff.lat, t.dropoff.lng)) : RouteLine.fromPolyline6(t.route.polyline)],
                      interactive: false,
                      showControls: false,
                      padding: const EdgeInsets.all(32),
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                Row(children: [StatusPill(tripStatusLabel(l, t.status), tone: t.status == TripStatus.completed ? Tone.green : t.status == TripStatus.cancelled ? Tone.red : Tone.blue), const SizedBox(width: 8), Expanded(child: Text(dayAndTime(t.times.requestedAt, locale: context.localeTag), textAlign: TextAlign.end, style: AnbessaType.caption.copyWith(color: c.muted)))]),
                const SizedBox(height: 12),
                if (parties != null && (parties.driverName != null || parties.vehicle != null))
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Row(
                      children: [
                        AvatarImage(src: parties.driverPhoto, name: parties.driverName ?? l.driverLabel, size: 40),
                        const SizedBox(width: 10),
                        Expanded(child: Text('${parties.driverName ?? l.driverLabel} · ${parties.vehicle?.label ?? ''} ${parties.vehicle?.plateNumber ?? ''}', style: AnbessaType.body2.copyWith(color: c.text2), maxLines: 2)),
                      ],
                    ),
                  ),
                SectionCard(
                  title: l.tripTimeline,
                  child: Column(
                    children: [
                      _TimeRow(l.requestedAtLabel, t.times.requestedAt),
                      if (t.times.startedAt != null) _TimeRow(l.startedAtLabel, t.times.startedAt!),
                      if (t.times.completedAt != null) _TimeRow(l.completedAtLabel, t.times.completedAt!),
                      if (t.times.cancelledAt != null) _TimeRow(l.cancelledAtLabel, t.times.cancelledAt!),
                      if (t.route.distanceMeters != null || t.route.estDistanceMeters > 0) KeyValue(l.distanceFare, Text(km(t.route.distanceMeters ?? t.route.estDistanceMeters))),
                    ],
                  ),
                ),
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
                if (supportOn && t.status != TripStatus.unknown) ...[
                  const SizedBox(height: 12),
                  SectionGroup(
                    title: l.receiptHelpTitle,
                    margin: EdgeInsets.zero,
                    children: [
                      if (report != null)
                        SettingsTile(
                          icon: Icons.backpack_outlined,
                          title: l.lostItemTitle,
                          subtitle: report.description,
                          trailing: StatusPill(lostItemStatusLabel(l, report.status), tone: lostItemStatusTone(report.status)),
                          onTap: () => context.push(Routes.lostItem(report.id)),
                        )
                      else if (!asDriver && lostItemReportable(t, DateTime.now()))
                        SettingsTile(icon: Icons.backpack_outlined, title: l.reportLostItem, subtitle: l.reportLostItemLede, onTap: () => context.push(Routes.lostItemReport(t.id))),
                      SettingsTile(icon: Icons.help_outline, title: l.receiptGetHelp, onTap: () => context.push(Routes.supportNewAbout(t.id))),
                    ],
                  ),
                ],
              ],
            ),
    );
  }
}

class _TimeRow extends StatelessWidget {
  const _TimeRow(this.label, this.at);
  final String label;
  final DateTime at;
  @override
  Widget build(BuildContext context) => KeyValue(label, Text(dayAndTime(at, locale: context.localeTag)));
}
