// The rider's trip (workflows 05 D–E, 06, 07): finding a driver → driver assigned (name, car,
// live position) → arrived (PIN) → on the way → done (payment, rating). One screen; the sheet at
// the bottom changes with the stage.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/network/providers.dart';
import '../../../core/router/routes.dart';
import '../../config/client_config_provider.dart';
import '../../maps/anbessa_map.dart';
import 'active_trip_controller.dart';

class RiderTripScreen extends ConsumerStatefulWidget {
  const RiderTripScreen({super.key, required this.tripId});
  final String tripId;
  @override
  ConsumerState<RiderTripScreen> createState() => _RiderTripScreenState();
}

class _RiderTripScreenState extends ConsumerState<RiderTripScreen> {
  Timer? _tick;
  DateTime _now = DateTime.now().toUtc();
  bool _busy = false;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() => _now = DateTime.now().toUtc()));
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  Future<void> _cancel(Trip t) async {
    final free = riderCancelIsFree(t, _now);
    final cfg = ref.read(configProvider);
    final reason = await showModalBottomSheet<CancelReason>(
      context: context,
      builder: (ctx) => _CancelSheet(free: free, feeMinor: 3000, city: cfg.city(t.cityId)?.name),
    );
    if (reason == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final u = await ref.read(apisProvider).trips.cancel(t.id, reason, idempotencyKey: newIdempotencyKey());
      ref.read(activeTripProvider.notifier).replace(u);
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final tripAsync = ref.watch(tripProvider(widget.tripId));
    final t = tripAsync.value;
    if (t == null) {
      return Scaffold(appBar: AppBar(), body: tripAsync.hasError ? Padding(padding: const EdgeInsets.all(16), child: Problem(tripAsync.error, describe: (e) => describeError(l, e))) : const Center(child: CircularProgressIndicator()));
    }
    final stage = riderStageOf(t);
    final parties = t.driver == null ? null : ref.watch(tripPartiesProvider(t.id)).value;
    final live = t.driver != null && t.isActive ? ref.watch(driverLiveProvider(t.id)).value : null;
    final pinOn = ref.watch(featureProvider(Feature.tripPin));
    final sosOn = ref.watch(featureProvider(Feature.sos));
    final driverName = parties?.driverName ?? l.driverLabel;
    final pickup = LatLng(t.pickup.lat, t.pickup.lng);
    final dropoff = LatLng(t.dropoff.lat, t.dropoff.lng);
    final driverPt = live == null ? null : LatLng(live.lat, live.lng);
    final stale = live != null && _now.difference(live.at) > const Duration(seconds: 20);
    final fit = switch (stage) {
      RiderStage.driverAssigned => [pickup, ?driverPt],
      RiderStage.driverArrived => [pickup],
      RiderStage.inTrip => [?driverPt, dropoff],
      _ => [pickup, dropoff],
    };

    return Scaffold(
      body: Stack(
        children: [
          AnbessaMap(
            fit: fit,
            pickup: pickup,
            dropoff: dropoff,
            driver: driverPt == null ? null : DriverMarkerData(position: driverPt, heading: live!.heading, stale: stale),
            line: stage == RiderStage.inTrip && driverPt != null ? [driverPt, dropoff] : (stage == RiderStage.driverAssigned && driverPt != null ? [driverPt, pickup] : [pickup, dropoff]),
            padding: const EdgeInsets.fromLTRB(48, 100, 48, 300),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  if (!t.isActive) IconButton.filledTonal(onPressed: () => context.go(Routes.riderHome), icon: const Icon(Icons.arrow_back)),
                  const Spacer(),
                  if (sosOn && t.isActive)
                    FilledButton.icon(
                      style: FilledButton.styleFrom(backgroundColor: c.danger),
                      onPressed: () => context.push('${Routes.sos}?trip=${t.id}'),
                      icon: const Icon(Icons.sos),
                      label: Text(l.sos),
                    ),
                ],
              ),
            ),
          ),
          Align(
            alignment: Alignment.bottomCenter,
            child: _Sheet(
              child: switch (stage) {
                RiderStage.finding => _Finding(trip: t, now: _now, busy: _busy, error: _error, onCancel: () => _cancel(t)),
                RiderStage.driverAssigned || RiderStage.driverArrived => _DriverCard(
                    trip: t, parties: parties, name: driverName, arrived: stage == RiderStage.driverArrived, live: live, stale: stale, now: _now, pinOn: pinOn, busy: _busy, error: _error, onCancel: () => _cancel(t)),
                RiderStage.inTrip => _InTrip(trip: t, name: driverName, parties: parties),
                RiderStage.completed => _Ended(trip: t, completed: true),
                RiderStage.cancelled => _Ended(trip: t, completed: false),
                RiderStage.unknown => Text(tripStatusLabel(l, t.status)),
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _Sheet extends StatelessWidget {
  const _Sheet({required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(color: c.surface, borderRadius: const BorderRadius.vertical(top: Radius.circular(18)), boxShadow: const [BoxShadow(color: Color(0x22000000), blurRadius: 16, offset: Offset(0, -2))]),
      child: SafeArea(top: false, child: Padding(padding: const EdgeInsets.fromLTRB(20, 16, 20, 16), child: child)),
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
        Row(children: [StatusPill(l.statusRequested, tone: Tone.amber, pulse: true), const Spacer(), MonoText(mmss(waited), style: TextStyle(color: c.muted))]),
        const SizedBox(height: 10),
        Text(l.findingDriver, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
        const SizedBox(height: 4),
        Text(l.findingDriverLede, style: TextStyle(color: c.text2)),
        const SizedBox(height: 12),
        const LinearProgressIndicator(),
        const SizedBox(height: 12),
        Problem(error, describe: (e) => describeError(l, e)),
        OutlinedButton(onPressed: busy ? null : onCancel, child: Text(l.cancelTrip)),
      ],
    );
  }
}

class _DriverCard extends StatelessWidget {
  const _DriverCard({required this.trip, required this.parties, required this.name, required this.arrived, required this.live, required this.stale, required this.now, required this.pinOn, required this.busy, required this.error, required this.onCancel});
  final Trip trip;
  final TripParties? parties;
  final String name;
  final bool arrived;
  final DriverLive? live;
  final bool stale;
  final DateTime now;
  final bool pinOn;
  final bool busy;
  final Object? error;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final eta = live == null ? null : (haversineMeters(live!.lat, live!.lng, trip.pickup.lat, trip.pickup.lng) / 7).round(); // ~25 km/h
    final free = riderCancelIsFree(trip, now);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            StatusPill(arrived ? l.driverArrivedLede : l.statusEnRoute, tone: arrived ? Tone.green : Tone.blue),
            const Spacer(),
            if (live != null) Text(stale ? l.positionStale(since(live!.at, now)) : l.liveTracking, style: TextStyle(color: stale ? c.warning : c.success, fontSize: 12, fontWeight: FontWeight.w600)),
          ],
        ),
        const SizedBox(height: 10),
        Text(arrived ? l.driverArrived(name) : l.driverOnTheWay(name), style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
        if (!arrived && eta != null) Text(l.etaMinutes((eta / 60).ceil().clamp(1, 99)), style: TextStyle(color: c.text2)),
        const SizedBox(height: 10),
        Row(
          children: [
            CircleAvatar(backgroundColor: c.accentSoft, foregroundColor: c.accentStrong, child: Text(name.isEmpty ? '?' : name.characters.first.toUpperCase())),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(parties?.vehicle?.label ?? l.vehicleLabel, style: const TextStyle(fontWeight: FontWeight.w600)),
                  if (parties?.vehicle != null) MonoText(parties!.vehicle!.plateNumber, style: TextStyle(color: c.text2, fontSize: 14, fontWeight: FontWeight.w600)),
                ],
              ),
            ),
            MoneyText(trip.fare.estimateMinor, locale: context.localeTag, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
          ],
        ),
        if (pinOn && trip.pin != null) ...[
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: c.accentSoft, borderRadius: BorderRadius.circular(anbessaRadius)),
            child: Row(
              children: [
                Expanded(child: Text(l.tellDriverPin, style: TextStyle(color: c.accentStrong, fontSize: 13))),
                MonoText(trip.pin!, style: TextStyle(fontSize: 26, fontWeight: FontWeight.w800, letterSpacing: 6, color: c.accentStrong)),
              ],
            ),
          ),
        ],
        const SizedBox(height: 12),
        Problem(error, describe: (e) => describeError(l, e)),
        Row(
          children: [
            Expanded(child: OutlinedButton(onPressed: busy ? null : onCancel, child: Text(l.cancelTrip))),
          ],
        ),
        if (!free) Padding(padding: const EdgeInsets.only(top: 6), child: Text(l.cancelFeeWarning(birr(3000, locale: context.localeTag)), style: TextStyle(color: c.muted, fontSize: 12))),
      ],
    );
  }
}

class _InTrip extends StatelessWidget {
  const _InTrip({required this.trip, required this.name, required this.parties});
  final Trip trip;
  final String name;
  final TripParties? parties;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        StatusPill(l.statusInProgress, tone: Tone.green),
        const SizedBox(height: 10),
        Text(l.inTrip(trip.dropoff.address ?? l.dropoffLabel), style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        Text('$name · ${parties?.vehicle?.plateNumber ?? ''}', style: TextStyle(color: c.text2)),
        const SizedBox(height: 10),
        Row(
          children: [
            Text(l.paidBy(paymentMethodLabel(l, trip.paymentMethod)), style: TextStyle(color: c.muted)),
            const Spacer(),
            MoneyText(trip.fare.estimateMinor, locale: context.localeTag, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
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
        StatusPill(completed ? l.statusCompleted : l.statusCancelled, tone: completed ? Tone.green : Tone.red),
        const SizedBox(height: 10),
        Text(completed ? l.tripCompleted : l.tripCancelled, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
        if (!completed) ...[
          const SizedBox(height: 4),
          Text(trip.cancellation?.reason == 'NO_DRIVER_FOUND' ? l.noDriverFound : l.cancelledBy(cancelledBy), style: TextStyle(color: c.text2)),
          if ((trip.cancellation?.feeMinor ?? 0) > 0) Text(l.cancelFeeWarning(birr(trip.cancellation!.feeMinor, locale: context.localeTag)), style: TextStyle(color: c.warning)),
        ],
        if (completed) ...[
          const SizedBox(height: 6),
          Row(children: [Text(l.totalLabel, style: TextStyle(color: c.muted)), const Spacer(), MoneyText(trip.fare.chargedMinor, locale: context.localeTag, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 20))]),
        ],
        const SizedBox(height: 14),
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

class _CancelSheet extends StatelessWidget {
  const _CancelSheet({required this.free, required this.feeMinor, this.city});
  final bool free;
  final int feeMinor;
  final String? city;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    const reasons = [CancelReason.changedPlans, CancelReason.driverTooFar, CancelReason.driverAskedToCancel, CancelReason.wrongPickup, CancelReason.other];
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(padding: const EdgeInsets.fromLTRB(20, 4, 20, 8), child: Text(l.cancelReasonTitle, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700))),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 20), child: Text(free ? l.cancelFree : l.cancelFeeWarning(birr(feeMinor, locale: context.localeTag)), style: TextStyle(color: free ? c.success : c.warning))),
          const SizedBox(height: 8),
          for (final r in reasons) ListTile(title: Text(cancelReasonLabel(l, r)), onTap: () => Navigator.of(context).pop(r)),
          Padding(padding: const EdgeInsets.all(12), child: OutlinedButton(onPressed: () => Navigator.of(context).pop(), child: Text(l.keepTrip))),
        ],
      ),
    );
  }
}
