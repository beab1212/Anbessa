// The rider's trip (workflows 05 D–E, 06, 07): finding a driver → driver assigned (name, photo,
// car, live position gliding along the road) → arrived (PIN) → on the way → done (payment,
// rating). One map; the sheet at the bottom changes with the stage.

import 'dart:async';

import 'package:confetti/confetti.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:share_plus/share_plus.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/network/providers.dart';
import '../../../core/router/routes.dart';
import '../../config/client_config_provider.dart';
import '../../maps/anbessa_map.dart';
import '../../maps/route_layer.dart' show toGeoPoints;
import 'active_trip_controller.dart';
import 'cancel_sheet.dart';
import 'trip_eta_controller.dart';

const _cancelFeeMinor = 3000;

class RiderTripScreen extends ConsumerStatefulWidget {
  const RiderTripScreen({super.key, required this.tripId});
  final String tripId;
  @override
  ConsumerState<RiderTripScreen> createState() => _RiderTripScreenState();
}

class _RiderTripScreenState extends ConsumerState<RiderTripScreen> with SingleTickerProviderStateMixin {
  late final MarkerAnimator _car = MarkerAnimator(vsync: this);
  late final ConfettiController _confetti = ConfettiController(duration: const Duration(seconds: 2));
  Timer? _tick;
  DateTime _now = DateTime.now().toUtc();
  bool _busy = false;
  Object? _error;
  // the sheet height goes straight to the map (no rebuild of this screen while it's dragged)
  final _sheetHeight = ValueNotifier<double>(0);
  RiderStage? _lastStage;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() => _now = DateTime.now().toUtc()));
  }

  @override
  void dispose() {
    _tick?.cancel();
    _car.dispose();
    _sheetHeight.dispose();
    _confetti.dispose();
    super.dispose();
  }

  Future<void> _cancel(Trip t) async {
    final free = riderCancelIsFree(t, _now);
    final reason = await showCancelSheet(context, free: free, feeMinor: _cancelFeeMinor);
    if (reason == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final u = await ref.read(apisProvider).trips.cancel(t.id, reason, idempotencyKey: newIdempotencyKey());
      ref.read(activeTripProvider.notifier).replace(u);
    } catch (e) {
      Haptics.error();
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _onStage(RiderStage stage) {
    if (_lastStage == stage) return;
    final first = _lastStage == null;
    _lastStage = stage;
    if (first) return;
    switch (stage) {
      case RiderStage.driverAssigned || RiderStage.inTrip:
        Haptics.success();
      case RiderStage.driverArrived:
        Haptics.offer();
        showToast(context, context.l10n.driverArrivedLede, tone: NoticeTone.ok, icon: Icons.directions_car);
      case RiderStage.completed:
        Haptics.success();
        _confetti.play();
      case RiderStage.cancelled:
        Haptics.error();
      default:
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    // dispatch gave the trip to another driver
    ref.listen(activeTripProvider, (prev, next) {
      final before = prev?.value;
      final now = next.value;
      if (before == null || now == null || before.id != widget.tripId || now.id != widget.tripId) return;
      final was = before.driver?.userId;
      final isNow = now.driver?.userId;
      if (was != null && isNow != null && was != isNow) {
        Haptics.offer();
        showToast(context, l.driverChanged, tone: NoticeTone.info);
      }
    });
    final tripAsync = ref.watch(tripProvider(widget.tripId));
    final t = tripAsync.value;
    if (t == null) {
      return Scaffold(appBar: AppBar(), body: tripAsync.hasError ? Padding(padding: const EdgeInsets.all(16), child: Problem(tripAsync.error, describe: (e) => describeError(l, e))) : const Padding(padding: EdgeInsets.all(16), child: SkeletonList(rows: 3)));
    }
    final stage = riderStageOf(t);
    WidgetsBinding.instance.addPostFrameCallback((_) => _onStage(stage));
    final parties = t.driver == null ? null : ref.watch(tripPartiesProvider(t.id)).value;
    final tracking = t.driver != null && t.isActive;
    // the animator glides the car on the map; this screen only rebuilds per sample (for the ETA)
    ref.listen(driverLiveProvider(t.id), (_, next) {
      final live = next.value;
      if (live != null && tracking) _car.push((lat: live.lat, lng: live.lng), heading: live.heading, speed: live.speed, at: live.at);
    });
    final live = tracking ? ref.watch(driverLiveProvider(t.id)).value : null;
    if (live != null && _car.pose == null) {
      // the first sample arrived before the listener: start the animator from it
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _car.pose == null) _car.push((lat: live.lat, lng: live.lng), heading: live.heading, speed: live.speed, at: live.at);
      });
    }
    final pinOn = ref.watch(featureProvider(Feature.tripPin));
    final sosOn = ref.watch(featureProvider(Feature.sos));
    final pickup = LatLng(t.pickup.lat, t.pickup.lng);
    final dropoff = LatLng(t.dropoff.lat, t.dropoff.lng);
    final carPt = live == null ? null : LatLng(live.lat, live.lng);
    final carStale = live != null && _car.isStale;

    // the car's road to its target, refreshed by the ETA controller
    final target = stage == RiderStage.inTrip ? (lat: t.dropoff.lat, lng: t.dropoff.lng) : (lat: t.pickup.lat, lng: t.pickup.lng);
    if (live != null && (stage == RiderStage.driverAssigned || stage == RiderStage.inTrip)) {
      WidgetsBinding.instance.addPostFrameCallback((_) => ref.read(tripEtaProvider(t.id).notifier).track((lat: live.lat, lng: live.lng), target));
    }
    final eta = ref.watch(tripEtaProvider(t.id));
    final tripLine = RouteLine.fromPolyline6(t.route.polyline, kind: stage == RiderStage.driverAssigned ? RouteKind.secondary : RouteKind.primary);
    final carLine = eta != null && eta.polyline6.isNotEmpty && carPt != null && (stage == RiderStage.driverAssigned || stage == RiderStage.inTrip)
        ? RouteLine.fromPolyline6(eta.polyline6)
        : (carPt != null && stage == RiderStage.driverAssigned ? RouteLine.straight(carPt, pickup) : null);
    final routes = [
      if (!tripLine.isEmpty) tripLine else if (stage != RiderStage.driverAssigned) RouteLine.straight(pickup, dropoff),
      ?carLine,
    ];
    // the car glides along the road it is on (its road to the target, or the trip's road)
    final carRoad = carLine != null && carLine.kind == RouteKind.primary ? carLine : (stage == RiderStage.inTrip && !tripLine.isEmpty ? tripLine : null);
    _car.route = carRoad == null ? null : toGeoPoints(carRoad.points);
    // fitted when the stage changes or the car's road first arrives; not as the car moves
    final fit = switch (stage) {
      RiderStage.driverAssigned => [pickup, ?carPt],
      RiderStage.driverArrived => [pickup, ?carPt],
      RiderStage.inTrip => [?carPt, dropoff],
      _ => [pickup, dropoff],
    };
    final etaSeconds = eta?.seconds ?? (carPt == null ? null : (haversineMeters(carPt.latitude, carPt.longitude, target.lat, target.lng) * 1.35 / 6.1).round());
    final carLabel = carPt != null && etaSeconds != null && (stage == RiderStage.driverAssigned || stage == RiderStage.inTrip) ? l.etaMinutes((etaSeconds / 60).ceil().clamp(1, 99)) : null;
    final top = MediaQuery.paddingOf(context).top;

    return Scaffold(
      body: Stack(
        children: [
          AnbessaMap(
            fit: fit,
            fitKey: (stage, carLine != null),
            pickup: pickup,
            dropoff: dropoff,
            driverCar: tracking ? _car : null,
            driverCarLabel: carLabel,
            routes: routes,
            topInset: top + 64,
            sheetHeight: _sheetHeight,
            overlays: [
              if (stage == RiderStage.finding) MapOverlay(point: pickup, size: const Size(160, 160), child: RadarPulse(color: c.accent, size: 160)),
            ],
          ),
          Positioned(
            top: top + 8,
            left: 12,
            right: 12,
            child: Row(
              children: [
                if (!t.isActive) MapControlButton(icon: Icons.arrow_back, tooltip: l.back, onTap: () => context.go(Routes.riderHome)),
                // share and SOS sit on the right; at large text SOS wraps under share
                Expanded(
                  child: Wrap(
                    alignment: WrapAlignment.end,
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      if (t.isActive && t.status != TripStatus.requested) _ShareButton(tripId: t.id),
                      // SOS on a trip with a driver, and for 30 min after drop-off (support-service's window)
                      if (sosOn && sosAvailable(t, DateTime.now()))
                        // the word is the signal (Material's sos icon is the same letters again)
                        FilledButton(
                          style: FilledButton.styleFrom(backgroundColor: c.danger, foregroundColor: Colors.white, minimumSize: const Size(64, 48), padding: const EdgeInsets.symmetric(horizontal: 18)),
                          onPressed: () => context.push('${Routes.sos}?trip=${t.id}'),
                          child: Text(l.sos),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          Align(alignment: Alignment.topCenter, child: ConfettiWidget(confettiController: _confetti, blastDirectionality: BlastDirectionality.explosive, numberOfParticles: 24, colors: [c.accent, c.success, c.info])),
          AppSheet(
            snaps: const [0.42, 0.8],
            onHeightChanged: (h) => _sheetHeight.value = h,
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
            builder: (context, _) => AnimatedSwitcherX(
              child: KeyedSubtree(
                key: ValueKey(stage),
                child: switch (stage) {
                  RiderStage.finding => _Finding(trip: t, now: _now, busy: _busy, error: _error, onCancel: () => _cancel(t)),
                  RiderStage.driverAssigned || RiderStage.driverArrived => _DriverCard(
                      trip: t, parties: parties, arrived: stage == RiderStage.driverArrived, stale: carStale, hasPosition: live != null, etaSeconds: etaSeconds, now: _now, pinOn: pinOn, busy: _busy, error: _error, onCancel: () => _cancel(t)),
                  RiderStage.inTrip => _InTrip(trip: t, parties: parties, etaSeconds: etaSeconds),
                  RiderStage.completed => _Ended(trip: t, completed: true),
                  RiderStage.cancelled => _Ended(trip: t, completed: false),
                  RiderStage.unknown => Text(tripStatusLabel(l, t.status)),
                },
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// matched → on the way → arrived → riding
class _Progress extends StatelessWidget {
  const _Progress({required this.step});
  final int step;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final labels = [l.progressMatched, l.progressEnRoute, l.progressArrived, l.progressRiding];
    return Column(
      children: [
        Row(
          children: [
            for (var i = 0; i < 4; i++) ...[
              if (i > 0) const SizedBox(width: 4),
              Expanded(
                child: AnimatedContainer(
                  duration: AnbessaMotion.of(context, AnbessaMotion.slow),
                  height: 4,
                  decoration: BoxDecoration(color: i <= step ? c.accent : c.border, borderRadius: BorderRadius.circular(2)),
                ),
              ),
            ],
          ],
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            for (var i = 0; i < 4; i++)
              Expanded(child: Text(labels[i], textAlign: i == 0 ? TextAlign.start : i == 3 ? TextAlign.end : TextAlign.center, style: AnbessaType.caption.copyWith(color: i == step ? c.text : c.muted, fontWeight: i == step ? FontWeight.w600 : FontWeight.w400, fontSize: 11), maxLines: 1, overflow: TextOverflow.ellipsis)),
          ],
        ),
      ],
    );
  }
}

class _Finding extends StatelessWidget {
  const _Finding({required this.trip, required this.now, required this.busy, required this.error, required this.onCancel});
  final Trip trip;
  final DateTime now;
  final bool busy;
  final Object? error;
  final VoidCallback onCancel;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final waited = now.difference(trip.times.requestedAt);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(children: [Flexible(child: StatusPill(l.statusRequested, tone: Tone.amber, pulse: true)), const SizedBox(width: 8), MonoText(mmss(waited), style: TextStyle(color: c.muted))]),
        const SizedBox(height: 12),
        Text(l.findingDriver, style: AnbessaType.h2.copyWith(color: c.text)),
        const SizedBox(height: 4),
        Text(l.findingDriverLede, style: AnbessaType.body2.copyWith(color: c.text2)),
        const SizedBox(height: 14),
        Row(
          children: [
            Expanded(child: Text(trip.dropoff.address ?? l.dropoffLabel, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.body.copyWith(fontWeight: FontWeight.w500))),
            MoneyText(trip.fare.estimateMinor, locale: context.localeTag, style: AnbessaType.title),
          ],
        ),
        const SizedBox(height: 14),
        Problem(error, describe: (e) => describeError(l, e)),
        OutlinedButton(onPressed: busy ? null : onCancel, child: Text(l.cancelTrip)),
      ],
    );
  }
}

class _DriverCard extends StatelessWidget {
  const _DriverCard({required this.trip, required this.parties, required this.arrived, required this.stale, required this.hasPosition, required this.etaSeconds, required this.now, required this.pinOn, required this.busy, required this.error, required this.onCancel});
  final Trip trip;
  final TripParties? parties;
  final bool arrived;
  final bool stale;
  final bool hasPosition;
  final int? etaSeconds;
  final DateTime now;
  final bool pinOn;
  final bool busy;
  final Object? error;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final name = parties?.driverName ?? l.driverLabel;
    final free = riderCancelIsFree(trip, now);
    final step = arrived ? 2 : (trip.status == TripStatus.enRoute ? 1 : 0);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: Text(arrived ? l.driverArrived(name) : l.driverOnTheWay(name), style: AnbessaType.h2.copyWith(color: c.text), maxLines: 3, overflow: TextOverflow.ellipsis)),
            if (!arrived && etaSeconds != null) EtaBadge(seconds: etaSeconds, minuteLabel: (m) => l.etaMinutes(m), large: true, icon: Icons.schedule),
          ],
        ),
        if (hasPosition) Padding(padding: const EdgeInsets.only(top: 4), child: Text(stale ? l.positionStale(since(trip.times.matchedAt ?? trip.times.requestedAt, now)) : l.liveTracking, style: AnbessaType.caption.copyWith(color: stale ? c.warning : c.success, fontWeight: FontWeight.w600))),
        const SizedBox(height: 14),
        _Progress(step: step),
        const SizedBox(height: 16),
        Row(
          children: [
            AvatarImage(src: parties?.driverPhoto, name: name, size: 56, ring: true),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(name, style: AnbessaType.title.copyWith(color: c.text), maxLines: 1, overflow: TextOverflow.ellipsis),
                  const SizedBox(height: 2),
                  RatingSummary(average: parties?.driverRating, count: parties?.driverRatingCount ?? 0, newLabel: l.newDriver),
                  const SizedBox(height: 2),
                  Text(parties?.vehicle?.label ?? l.vehicleLabel, style: AnbessaType.caption.copyWith(color: c.text2), maxLines: 1, overflow: TextOverflow.ellipsis),
                ],
              ),
            ),
            if (parties?.vehicle != null)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(AnbessaRadius.sm), border: Border.all(color: c.borderStrong, width: 1.5)),
                child: MonoText(parties!.vehicle!.plateNumber, style: AnbessaType.title.copyWith(color: c.text, letterSpacing: 1)),
              ),
          ],
        ),
        if (pinOn && trip.pin != null) ...[
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(AnbessaRadius.md)),
            child: Row(
              children: [
                Expanded(child: Text(l.tellDriverPin, style: AnbessaType.body2.copyWith(color: c.text2))),
                const SizedBox(width: 10),
                PinDisplay(trip.pin!, size: 36),
              ],
            ),
          ),
        ],
        const SizedBox(height: 14),
        Row(
          children: [
            Expanded(child: _Fact(label: l.fareLabel, value: birr(trip.fare.payableMinor, locale: context.localeTag))),
            Expanded(child: _Fact(label: l.paymentMethod, value: paymentMethodLabel(l, trip.paymentMethod))),
          ],
        ),
        const SizedBox(height: 12),
        Problem(error, describe: (e) => describeError(l, e)),
        OutlinedButton(onPressed: busy ? null : onCancel, child: Text(l.cancelTrip)),
        if (!free) Padding(padding: const EdgeInsets.only(top: 6), child: Text(l.cancelFeeWarning(birr(_cancelFeeMinor, locale: context.localeTag)), style: AnbessaType.caption.copyWith(color: c.muted))),
      ],
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.label, required this.value});
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [Text(label, style: AnbessaType.caption.copyWith(color: c.muted)), Text(value, style: AnbessaType.body.copyWith(fontWeight: FontWeight.w600, color: c.text, fontFeatures: AnbessaType.tabular))],
    );
  }
}

class _InTrip extends StatelessWidget {
  const _InTrip({required this.trip, required this.parties, required this.etaSeconds});
  final Trip trip;
  final TripParties? parties;
  final int? etaSeconds;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final name = parties?.driverName ?? l.driverLabel;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(child: Text(l.inTrip(trip.dropoff.address ?? l.dropoffLabel), style: AnbessaType.h2.copyWith(color: c.text), maxLines: 2, overflow: TextOverflow.ellipsis)),
            if (etaSeconds != null) EtaBadge(seconds: etaSeconds, minuteLabel: (m) => l.etaMinutes(m), large: true, icon: Icons.flag_outlined),
          ],
        ),
        const SizedBox(height: 14),
        const _Progress(step: 3),
        const SizedBox(height: 16),
        Row(
          children: [
            AvatarImage(src: parties?.driverPhoto, name: name, size: 40),
            const SizedBox(width: 10),
            Expanded(child: Text('$name · ${parties?.vehicle?.plateNumber ?? ''}', style: AnbessaType.body.copyWith(color: c.text2), maxLines: 1, overflow: TextOverflow.ellipsis)),
          ],
        ),
        const SizedBox(height: 14),
        Row(
          children: [
            Expanded(child: _Fact(label: l.fareLabel, value: birr(trip.fare.payableMinor, locale: context.localeTag))),
            Expanded(child: _Fact(label: l.paymentMethod, value: paymentMethodLabel(l, trip.paymentMethod))),
          ],
        ),
      ],
    );
  }
}

class _Ended extends ConsumerWidget {
  const _Ended({required this.trip, required this.completed});
  final Trip trip;
  final bool completed;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final cancelledBy = trip.cancellation?.by.name ?? '';
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(child: Text(completed ? l.tripCompleted : l.tripCancelled, style: AnbessaType.h2.copyWith(color: c.text))),
          ],
        ),
        if (!completed) ...[
          const SizedBox(height: 8),
          Text(trip.cancellation?.reason == 'NO_DRIVER_FOUND' ? l.noDriverFound : l.cancelledBy(cancelledBy), style: AnbessaType.body2.copyWith(color: c.text2)),
          if ((trip.cancellation?.feeMinor ?? 0) > 0) Text(l.cancelFeeWarning(birr(trip.cancellation!.feeMinor, locale: context.localeTag)), style: AnbessaType.body2.copyWith(color: c.warning)),
        ],
        if (completed) ...[
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(AnbessaRadius.md)),
            child: Row(
              children: [
                Expanded(child: Text(l.totalLabel, style: AnbessaType.body.copyWith(color: c.text2))),
                AnimatedMoney(trip.fare.payableMinor, locale: context.localeTag, style: AnbessaType.h1.copyWith(color: c.text)),
              ],
            ),
          ),
          if (trip.fare.promoDiscountMinor > 0)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text('${promoLabel(l, trip.fare)} · −${birr(trip.fare.promoDiscountMinor, locale: context.localeTag)}', style: AnbessaType.caption.copyWith(color: c.success)),
            ),
          const SizedBox(height: 6),
          Text(l.paidBy(paymentMethodLabel(l, trip.paymentMethod)), style: AnbessaType.caption.copyWith(color: c.muted)),
        ],
        const SizedBox(height: 16),
        if (completed) PrimaryButton(label: trip.isDigital ? l.payTitle : l.receiptTitle, icon: trip.isDigital ? Icons.payments_outlined : Icons.receipt_long_outlined, onPressed: () => context.go(Routes.riderPay(trip.id))),
        if (!completed)
          PrimaryButton(
            label: l.done,
            onPressed: () {
              ref.read(activeTripProvider.notifier).clearIfEnded();
              context.go(Routes.riderHome);
            },
          ),
      ],
    );
  }
}

/// Share my trip: make (or reuse) the link and hand it to the share sheet; once shared, the same
/// button offers to stop.
class _ShareButton extends ConsumerStatefulWidget {
  const _ShareButton({required this.tripId});
  final String tripId;
  @override
  ConsumerState<_ShareButton> createState() => _ShareButtonState();
}

class _ShareButtonState extends ConsumerState<_ShareButton> {
  TripShare? _share;
  bool _busy = false;

  Future<void> _start() async {
    final l = context.l10n;
    setState(() => _busy = true);
    try {
      final s = await ref.read(apisProvider).trips.share(widget.tripId);
      if (!mounted) return;
      setState(() => _share = s);
      Haptics.light();
      await SharePlus.instance.share(ShareParams(text: l.shareTripText(s.url), subject: l.shareTrip));
    } catch (e) {
      if (mounted) showToast(context, describeError(l, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _menu() async {
    final l = context.l10n;
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: SectionGroup(
            margin: EdgeInsets.zero,
            children: [
              SettingsTile(icon: Icons.ios_share, title: l.shareTrip, onTap: () => Navigator.pop(ctx, 'again')),
              SettingsTile(icon: Icons.link_off, title: l.stopSharing, destructive: true, onTap: () => Navigator.pop(ctx, 'stop')),
            ],
          ),
        ),
      ),
    );
    if (!mounted || choice == null) return;
    if (choice == 'again') return _start();
    setState(() => _busy = true);
    try {
      await ref.read(apisProvider).trips.stopSharing(widget.tripId);
      if (!mounted) return;
      setState(() => _share = null);
      showToast(context, l.sharingStopped);
    } catch (e) {
      if (mounted) showToast(context, describeError(l, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final on = _share != null;
    return Semantics(
      button: true,
      label: on ? l.sharingOn : l.shareTrip,
      child: DecoratedBox(
        decoration: ShapeDecoration(shape: const StadiumBorder(), shadows: AnbessaElevation.floating(c.brightness)),
        child: Material(
          color: on ? c.primaryFill : c.surface,
          shape: StadiumBorder(side: BorderSide(color: on ? c.primaryFill : c.border)),
          child: InkWell(
            customBorder: const StadiumBorder(),
            onTap: _busy ? null : (on ? _menu : _start),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (_busy) ...[SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: on ? c.onAccent : c.text)), const SizedBox(width: 6)],
                  Text(on ? l.sharingOn : l.shareTrip, style: AnbessaType.label.copyWith(color: on ? c.onAccent : c.text)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
