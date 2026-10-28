// Activity (both sides, the kit's Activity tab): Ongoing / Scheduled / Completed / Cancelled chips over
// the trips, a period and role menu under ⋮, and one trip's ride details.

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
import '../../../core/ux/kit_group.dart';
import '../../bootstrap/gates.dart' show AnbessaLogo;
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

/// One day of past trips (the day in Addis Ababa), newest first as the list comes.
typedef TripDay = ({DateTime day, DateTime firstAt, List<Trip> trips});

/// The loaded history filtered by period and grouped by day. Worked out here, once per page
/// loaded or filter change, instead of on every build of the screen.
final historyDaysProvider = Provider.family<List<TripDay>, ({String as, HistoryPeriod period})>((ref, arg) {
  final trips = ref.watch(tripHistoryProvider(arg.as).select((h) => h.value?.trips)) ?? const <Trip>[];
  return groupTripsByDay(trips, period: arg.period, now: DateTime.now());
});

List<TripDay> groupTripsByDay(List<Trip> trips, {HistoryPeriod period = HistoryPeriod.all, required DateTime now}) {
  final since = switch (period) {
    HistoryPeriod.week => now.subtract(const Duration(days: 7)),
    HistoryPeriod.month => DateTime(now.year, now.month - 1, now.day),
    HistoryPeriod.all => null,
  };
  final days = <DateTime, List<Trip>>{};
  final first = <DateTime, DateTime>{};
  for (final t in trips) {
    final at = t.times.requestedAt;
    if (since != null && !at.isAfter(since)) continue;
    final d = toAddis(at);
    final key = DateTime.utc(d.year, d.month, d.day);
    first.putIfAbsent(key, () => at);
    days.putIfAbsent(key, () => []).add(t);
  }
  return [for (final e in days.entries) (day: e.key, firstAt: first[e.key]!, trips: List.unmodifiable(e.value))];
}

/// The Activity filter chips (GoRide's Ongoing / Scheduled / Completed / Canceled).
enum ActivityTab { ongoing, scheduled, completed, canceled }

/// The amount a past trip shows: what the rider paid (or the cancellation fee), what the
/// driver's earning is based on (or the compensation for a cancelled trip).
int tripAmountOf(Trip t, {required bool driverSide}) {
  if (t.status == TripStatus.cancelled) return driverSide ? (t.cancellation?.driverCompensationMinor ?? 0) : (t.cancellation?.feeMinor ?? 0);
  return driverSide ? t.fare.chargedMinor : t.fare.payableMinor;
}

/// "28 Oct 2026 · 14:05", the kit's date line under a trip.
String tripWhen(DateTime at, String locale) => '${dayOf(at, locale: locale)} · ${clockOf(at)}';

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
  // null until the person picks a chip: then the first one with something in it
  ActivityTab? _tab;
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

  String _tabLabel(AppLocalizations l, ActivityTab t) => switch (t) {
        ActivityTab.ongoing => l.actOngoing,
        ActivityTab.scheduled => l.actScheduled,
        ActivityTab.completed => l.actCompleted,
        ActivityTab.canceled => l.actCanceled,
      };

  void _openTrip(Trip t) => context.go(_as == 'driver' ? Routes.driverTrip(t.id) : Routes.riderTrip(t.id));

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final session = ref.watch(currentSessionProvider);
    final both = session?.canDrive ?? false;
    final h = ref.watch(tripHistoryProvider(_as));
    final rider = _as == 'rider';
    final scheduledOn = rider && ref.watch(featureProvider(Feature.scheduledRides));
    final scheduled = scheduledOn ? (ref.watch(scheduledRidesProvider).value ?? const <ScheduledTrip>[]) : const <ScheduledTrip>[];
    final days = ref.watch(historyDaysProvider((as: _as, period: _period)));
    final active = ref.watch(activeTripProvider).value;
    final me = session?.userId;
    final mine = active != null && active.isActive && (rider ? active.riderUserId == me : active.driver?.userId == me);
    final ongoing = <Trip>[
      if (mine) active,
      for (final d in days)
        for (final t in d.trips)
          if (t.isActive && t.id != active?.id) t,
    ];
    final tabs = [ActivityTab.ongoing, if (scheduledOn) ActivityTab.scheduled, ActivityTab.completed, ActivityTab.canceled];
    var tab = _tab ?? (ongoing.isNotEmpty ? ActivityTab.ongoing : scheduled.isNotEmpty ? ActivityTab.scheduled : ActivityTab.completed);
    if (!tabs.contains(tab)) tab = ActivityTab.completed;
    final trips = switch (tab) {
      ActivityTab.ongoing => ongoing,
      ActivityTab.scheduled => const <Trip>[],
      ActivityTab.completed => [for (final d in days) ...d.trips.where((t) => t.status == TripStatus.completed)],
      ActivityTab.canceled => [for (final d in days) ...d.trips.where((t) => t.status == TripStatus.cancelled)],
    };
    final hasMore = h.value?.next != null && tab != ActivityTab.ongoing && tab != ActivityTab.scheduled;
    final loading = h.isLoading && h.value == null;

    Widget body;
    if (tab == ActivityTab.scheduled) {
      body = const ScheduledRideList(key: ValueKey('scheduled'));
    } else if (loading && trips.isEmpty) {
      body = const Padding(padding: EdgeInsets.symmetric(horizontal: AnbessaSpace.page), child: SkeletonList(rows: 6));
    } else if (h.hasError && h.value == null && trips.isEmpty) {
      body = ListView(children: [Padding(padding: const EdgeInsets.all(AnbessaSpace.page), child: Problem(h.error, describe: (e) => describeError(l, e), onRetry: () => ref.read(tripHistoryProvider(_as).notifier).refresh(), retryLabel: l.retry))]);
    } else if (trips.isEmpty && !hasMore) {
      final (illustration, title, lede) = switch (tab) {
        ActivityTab.ongoing => (AnbessaIllustration.carWaiting, l.actNoOngoing, l.actNoOngoingLede),
        ActivityTab.canceled => (AnbessaIllustration.noTrips, l.actNoCanceled, l.actNoCanceledLede),
        _ => (AnbessaIllustration.noTrips, l.noTrips, l.noTripsLede),
      };
      body = ListView(padding: const EdgeInsets.symmetric(horizontal: AnbessaSpace.page), children: [const SizedBox(height: 56), IllustratedEmpty(illustration: illustration, title: title, body: lede)]);
    } else {
      body = ListView.builder(
        key: PageStorageKey('activity-$_as-${tab.name}'),
        controller: _scroll,
        padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 24),
        itemCount: trips.length + (hasMore ? 1 : 0),
        itemBuilder: (context, i) {
          if (i >= trips.length) return _LoadMore(key: const ValueKey('more'), onShown: () => ref.read(tripHistoryProvider(_as).notifier).more());
          final t = trips[i];
          if (tab == ActivityTab.ongoing) return OngoingTripCard(key: ValueKey(t.id), trip: t, driverSide: !rider, onOpen: () => _openTrip(t));
          return ActivityTripRow(key: ValueKey(t.id), trip: t, driverSide: !rider, divider: i < trips.length - 1, onTap: () => context.push(widget.receiptRoute(t.id)));
        },
      );
    }

    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(
        title: l.tabActivity,
        leadingKind: TopBarLeading.none,
        leading: const Padding(padding: EdgeInsetsDirectional.only(start: AnbessaSpace.page), child: Align(alignment: AlignmentDirectional.centerStart, child: AnbessaLogo(size: 30))),
        actions: [
          PopupMenuButton<Object>(
            tooltip: l.actMore,
            icon: Icon(Icons.more_vert_rounded, color: c.text),
            onSelected: (v) => setState(() {
              if (v is HistoryPeriod) _period = v;
              if (v is String && v != _as) {
                _as = v;
                _tab = null;
              }
            }),
            itemBuilder: (_) => [
              for (final (p, label) in [(HistoryPeriod.all, l.filterAll), (HistoryPeriod.week, l.filterThisWeek), (HistoryPeriod.month, l.filterThisMonth)]) CheckedPopupMenuItem<Object>(value: p, checked: _period == p, child: Text(label)),
              if (both) ...[
                const PopupMenuDivider(),
                for (final (v, label) in [('rider', l.asRider), ('driver', l.asDriver)]) CheckedPopupMenuItem<Object>(value: v, checked: _as == v, child: Text(label)),
              ],
            ],
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 4, bottom: 12),
            child: ChipRow(
              children: [
                for (final t in tabs)
                  OutlineChip(
                    label: _tabLabel(l, t),
                    selected: t == tab,
                    onTap: () {
                      Haptics.selection();
                      setState(() => _tab = t);
                    },
                  ),
              ],
            ),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: () async {
                if (scheduledOn) ref.read(scheduledRidesProvider.notifier).refresh();
                await ref.read(tripHistoryProvider(_as).notifier).refresh();
              },
              child: AnimatedSwitcherX(child: KeyedSubtree(key: ValueKey((_as, tab)), child: body)),
            ),
          ),
        ],
      ),
    );
  }
}

/// The spinner at the end of a list; loads the next page once it is shown.
class _LoadMore extends StatefulWidget {
  const _LoadMore({super.key, required this.onShown});
  final VoidCallback onShown;
  @override
  State<_LoadMore> createState() => _LoadMoreState();
}

class _LoadMoreState extends State<_LoadMore> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.onShown();
    });
  }

  @override
  Widget build(BuildContext context) => const Padding(padding: EdgeInsets.all(16), child: Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))));
}

/// The vehicle in a hairline circle, in amber text colour (the kit's green car / scooter).
class TripVehicleIcon extends StatelessWidget {
  const TripVehicleIcon(this.code, {super.key});
  final String code;
  @override
  Widget build(BuildContext context) => ExcludeSemantics(child: CircleIcon(outlinedVehicleIcon(code), color: context.colors.accentText));
}

/// The kit draws its Activity vehicles as thin outlines: [vehicleIcon]'s classes, outlined.
IconData outlinedVehicleIcon(String code) => switch (vehicleIcon(code)) {
      Icons.airport_shuttle_rounded => Icons.airport_shuttle_outlined,
      Icons.electric_rickshaw_rounded => Icons.electric_rickshaw_outlined,
      Icons.two_wheeler_rounded => Icons.two_wheeler_outlined,
      Icons.electric_car_rounded => Icons.electric_car_outlined,
      _ => Icons.directions_car_outlined,
    };

/// One past trip: vehicle circle, where to, when, the amount and how it was paid (or, red,
/// that it was cancelled).
class ActivityTripRow extends StatelessWidget {
  const ActivityTripRow({super.key, required this.trip, required this.onTap, this.driverSide = false, this.divider = true});
  final Trip trip;
  /// drivers see the fare their earning is based on; riders what they paid
  final bool driverSide;
  final VoidCallback onTap;
  final bool divider;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final loc = context.localeTag;
    final t = trip;
    final cancelled = t.status == TripStatus.cancelled;
    final amount = tripAmountOf(t, driverSide: driverSide);
    final String sub;
    if (cancelled) {
      sub = driverSide ? (amount > 0 ? l.actCancelledCompensated : l.actCanceled) : (amount > 0 ? l.entryCancellationFee : l.actCancelledNoCharge);
    } else {
      sub = paymentMethodLabel(l, t.paymentMethod);
    }
    return ListRowTile(
      leading: TripVehicleIcon(t.vehicleType),
      title: t.dropoff.address ?? t.vehicleType,
      subtitle: tripWhen(t.times.requestedAt, loc),
      value: birr(amount, locale: loc),
      valueSub: sub,
      valueSubColor: cancelled ? c.danger : null,
      divider: divider,
      padding: const EdgeInsets.symmetric(vertical: 14),
      onTap: onTap,
    );
  }
}

/// A trip in progress: its row, the route card and "Track route" (opens the live trip).
class OngoingTripCard extends StatelessWidget {
  const OngoingTripCard({super.key, required this.trip, required this.onOpen, this.driverSide = false});
  final Trip trip;
  final bool driverSide;
  final VoidCallback onOpen;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final loc = context.localeTag;
    final t = trip;
    return Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ListRowTile(
            leading: TripVehicleIcon(t.vehicleType),
            title: t.dropoff.address ?? t.vehicleType,
            subtitle: tripWhen(t.times.requestedAt, loc),
            value: birr(tripAmountOf(t, driverSide: driverSide), locale: loc),
            valueSub: paymentMethodLabel(l, t.paymentMethod),
            onTap: onOpen,
          ),
          const SizedBox(height: 4),
          HairlineRouteCard(pickup: t.pickup.address ?? l.pickupLabel, dropoff: t.dropoff.address ?? l.dropoffLabel),
          const SizedBox(height: 16),
          PillButton(label: l.actTrackRoute, variant: PillVariant.outline, onPressed: onOpen),
        ],
      ),
    );
  }
}

/// [RoutePointsCard] flat on the page, inside a hairline box (the kit's route block in lists).
class HairlineRouteCard extends StatelessWidget {
  const HairlineRouteCard({super.key, required this.pickup, required this.dropoff});
  final String pickup;
  final String dropoff;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final card = RoutePointsCard(floating: false, points: [RoutePointsCard.pickup(pickup), RoutePointsCard.destination(dropoff)]);
    // the card draws its own hairline in dark mode
    if (c.isDark) return card;
    return DecoratedBox(
      position: DecorationPosition.foreground,
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(AnbessaRadius.md), border: Border.all(color: c.border)),
      child: card,
    );
  }
}

/// Ride details (the kit's "Ride Details"): the map, the trip's headline with its status, the
/// car class and price, the route, who drove, the times, the fare, the driver's settlement,
/// and help with the trip.
class ReceiptScreen extends ConsumerWidget {
  const ReceiptScreen({super.key, required this.tripId, required this.asDriver});
  final String tripId;
  final bool asDriver;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final loc = context.localeTag;
    final tripAsync = ref.watch(tripProvider(tripId));
    final t = tripAsync.value;
    final money = asDriver ? ref.watch(tripPaymentsProvider(tripId)).value : null;
    final settlement = money?.settlements.where((s) => s.purpose == 'TRIP_FARE').firstOrNull;
    final parties = t?.driver == null ? null : ref.watch(tripPartiesProvider(tripId)).value;
    final supportOn = ref.watch(featureProvider(Feature.support));
    final cfg = ref.watch(configProvider);
    // the rider's report about this trip, if there is one (support-service keeps one live per trip)
    final report = supportOn && !asDriver ? ref.watch(myLostItemsProvider).value?.where((i) => i.tripId == tripId && i.isRider).firstOrNull : null;
    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(
        title: l.actRideDetails,
        actions: [
          if (t != null)
            IconButton(
              tooltip: l.shareReceipt,
              icon: const Icon(Icons.ios_share_rounded),
              onPressed: () => SharePlus.instance.share(ShareParams(text: l.receiptShareText(dayAndTime(t.times.requestedAt, locale: loc), t.pickup.address ?? '—', t.dropoff.address ?? '—', birr(asDriver ? t.fare.chargedMinor : t.fare.payableMinor, locale: loc), shortId(t.id)))),
            ),
          const SizedBox(width: 8),
        ],
      ),
      body: t == null
          ? (tripAsync.hasError
              ? Padding(padding: const EdgeInsets.all(AnbessaSpace.page), child: Problem(tripAsync.error, describe: (e) => describeError(l, e)))
              : const Padding(padding: EdgeInsets.all(AnbessaSpace.page), child: Column(children: [SkeletonCard(height: 180), SizedBox(height: 12), SkeletonCard(height: 220)])))
          : ListView(
              padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 32),
              children: [
                SizedBox(
                  height: 180,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(AnbessaRadius.md),
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
                const SizedBox(height: 16),
                // the headline: where to, when, the status
                AppCard(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    children: [
                      Text(t.dropoff.address ?? l.dropoffLabel, textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis, style: AnbessaType.h2.copyWith(color: c.text)),
                      const SizedBox(height: 6),
                      Text(tripWhen(t.times.requestedAt, loc), textAlign: TextAlign.center, style: AnbessaType.caption.copyWith(color: c.muted)),
                      const SizedBox(height: 10),
                      OutlineBadge(_statusText(l, t.status), danger: t.status == TripStatus.cancelled),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                // the car class and the price (the kit's "GoRide Car … $10.00")
                AppCard(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  child: Row(
                    children: [
                      ExcludeSemantics(child: VehicleArt(t.vehicleType, width: 56)),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(cfg.vehicleTypes.where((v) => v.code == t.vehicleType).firstOrNull?.name ?? t.vehicleType, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.title.copyWith(color: c.text)),
                            const SizedBox(height: 4),
                            Text(l.tripOf(km(t.route.distanceMeters ?? t.route.estDistanceMeters), minutesOf(t.route.durationSeconds ?? t.route.estDurationSeconds)), maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.caption.copyWith(color: c.muted, fontFeatures: AnbessaType.tabular)),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),
                      // the price never squeezes the class away at large text sizes
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 120),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            FittedBox(fit: BoxFit.scaleDown, child: MoneyText(tripAmountOf(t, driverSide: asDriver), locale: loc, style: AnbessaType.title.copyWith(color: c.text))),
                            const SizedBox(height: 4),
                            Text(paymentMethodLabel(l, t.paymentMethod), maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.caption.copyWith(fontSize: 12, color: c.muted)),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                HairlineRouteCard(pickup: t.pickup.address ?? l.pickupLabel, dropoff: t.dropoff.address ?? l.dropoffLabel),
                if (parties != null && (parties.driverName != null || parties.riderName != null || parties.vehicle != null)) ...[
                  const SizedBox(height: 12),
                  AppCard(
                    padding: const EdgeInsets.all(14),
                    child: asDriver
                        ? DriverRow(name: parties.riderName ?? l.riderLabel, photo: parties.riderPhoto, subtitle: l.riderLabel)
                        : DriverRow(
                            name: parties.driverName ?? l.driverLabel,
                            photo: parties.driverPhoto,
                            rating: parties.driverRating?.toStringAsFixed(1),
                            subtitle: [parties.vehicle?.label, parties.vehicle?.plateNumber].whereType<String>().where((s) => s.isNotEmpty).join(' · '),
                          ),
                  ),
                ],
                const SizedBox(height: 12),
                KeyValueCard(
                  rows: [
                    KeyValueCard.row(l.requestedAtLabel, dayAndTime(t.times.requestedAt, locale: loc)),
                    if (t.times.startedAt != null) KeyValueCard.row(l.startedAtLabel, dayAndTime(t.times.startedAt, locale: loc)),
                    if (t.times.completedAt != null) KeyValueCard.row(l.completedAtLabel, dayAndTime(t.times.completedAt, locale: loc)),
                    if (t.times.cancelledAt != null) KeyValueCard.row(l.cancelledAtLabel, dayAndTime(t.times.cancelledAt, locale: loc)),
                    if (t.route.distanceMeters != null || t.route.estDistanceMeters > 0) KeyValueCard.row(l.distanceFare, km(t.route.distanceMeters ?? t.route.estDistanceMeters)),
                    KeyValueCard.row(l.tripIdLabel, shortId(t.id)),
                  ],
                ),
                const SizedBox(height: 12),
                KeyValueCard(
                  rows: [
                    KeyValueCard.row(l.fareLabel, birr(t.fare.estimateMinor, locale: loc)),
                    if ((t.fare.waitingFeeMinor ?? 0) > 0) KeyValueCard.row(l.waitingFeeLabel, birr(t.fare.waitingFeeMinor!, locale: loc)),
                    if (t.fare.promoDiscountMinor > 0) KeyValueCard.row(promoLabel(l, t.fare), birr(-t.fare.promoDiscountMinor, locale: loc), valueColor: c.success),
                    if (t.cancellation != null && t.cancellation!.feeMinor > 0) KeyValueCard.row(l.entryCancellationFee, birr(t.cancellation!.feeMinor, locale: loc)),
                    KeyValueCard.row(l.paymentMethod, paymentMethodLabel(l, t.paymentMethod)),
                  ],
                  total: KeyValueCard.row(l.totalLabel, birr(t.status == TripStatus.cancelled ? (t.cancellation?.feeMinor ?? 0) : t.fare.payableMinor, locale: loc)),
                ),
                if (settlement != null) ...[
                  const SizedBox(height: 12),
                  KeyValueCard(
                    rows: [
                      KeyValueCard.row(l.commissionLabel, birr(settlement.commissionMinor, locale: loc)),
                      KeyValueCard.row(l.vatLabel, birr(settlement.vatMinor, locale: loc)),
                    ],
                    total: KeyValueCard.row(l.yourBalanceChange, '${settlement.earningsMinor > 0 ? '+' : ''}${birr(settlement.earningsMinor, locale: loc)}', valueColor: settlement.earningsMinor < 0 ? c.danger : c.success),
                  ),
                ],
                if (supportOn && t.status != TripStatus.unknown) ...[
                  const SizedBox(height: 20),
                  Text(l.receiptHelpTitle, style: AnbessaType.title.copyWith(color: c.text)),
                  const SizedBox(height: 8),
                  AppCard(
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    child: Column(
                      children: [
                        if (report != null)
                          ListRowTile(
                            icon: Icons.backpack_outlined,
                            title: l.lostItemTitle,
                            subtitle: report.description,
                            valueSub: lostItemStatusLabel(l, report.status), valueSubColor: kitToneText(context, lostItemStatusTone(report.status)),
                            divider: true,
                            onTap: () => context.push(Routes.lostItem(report.id)),
                          )
                        else if (!asDriver && lostItemReportable(t, DateTime.now()))
                          ListRowTile(icon: Icons.backpack_outlined, title: l.reportLostItem, subtitle: l.reportLostItemLede, chevron: true, divider: true, onTap: () => context.push(Routes.lostItemReport(t.id))),
                        ListRowTile(icon: Icons.support_agent_rounded, title: l.receiptGetHelp, chevron: true, onTap: () => context.push(Routes.supportNewAbout(t.id))),
                      ],
                    ),
                  ),
                ],
              ],
            ),
    );
  }

  static String _statusText(AppLocalizations l, TripStatus s) => switch (s) {
        TripStatus.completed => l.actCompleted,
        TripStatus.cancelled => l.actCanceled,
        _ => l.actOngoing,
      };
}
