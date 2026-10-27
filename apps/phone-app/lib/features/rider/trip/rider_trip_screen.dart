// The trip stage in the rider map shell (workflows 05 D–E, 06, 07): finding a driver (a pulse at
// the pickup and the time spent searching) → driver assigned (their photo, rating, car and plate;
// the car gliding along its road with "N min" over it) → arrived (the PIN) → riding ("Arrive
// HH:MM"; the road behind turns grey) → done (the total, confetti, Pay). Share and SOS float over
// the map. The map is the shell's (map_intent.dart: tripMapIntentProvider); this file is the
// sheet and the top bar. Clocks (time searching, the free-cancel window, a stale position) tick in
// their own small widgets: nothing here rebuilds every second.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:share_plus/share_plus.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/network/providers.dart';
import '../../../core/router/routes.dart';
import '../../config/client_config_provider.dart';
import '../shell/map_intent.dart';
import '../shell/rider_map_shell.dart';
import 'active_trip_controller.dart';
import 'cancel_sheet.dart';
import 'trip_eta_controller.dart';

const _cancelFeeMinor = 3000;

class TripSheet extends ConsumerStatefulWidget {
  const TripSheet({super.key, required this.tripId});
  final String tripId;
  @override
  ConsumerState<TripSheet> createState() => _TripSheetState();
}

class _TripSheetState extends ConsumerState<TripSheet> {
  bool _busy = false;
  Object? _error;
  RiderStage? _lastStage;

  Future<void> _cancel(Trip t) async {
    final free = riderCancelIsFree(t, DateTime.now().toUtc());
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

  /// A new stage: haptics, a word, confetti at the end; the sheet settles at its resting size.
  void _onStage(RiderStage stage) {
    if (_lastStage == stage) return;
    final first = _lastStage == null;
    _lastStage = stage;
    if (first) return;
    final shell = RiderMapScope.maybeOf(context);
    shell?.sheet.animateTo(0, duration: AnbessaMotion.of(context, AnbessaMotion.sheet));
    switch (stage) {
      case RiderStage.driverAssigned || RiderStage.inTrip:
        Haptics.success();
      case RiderStage.driverArrived:
        Haptics.offer();
        showToast(context, context.l10n.driverArrivedLede, tone: NoticeTone.ok, icon: Icons.directions_car_rounded);
      case RiderStage.completed:
        Haptics.success();
        shell?.confetti.play();
      case RiderStage.cancelled:
        Haptics.error();
      default:
        break;
    }
  }

  /// Each position of the car: to its animator on the map, and to the ETA (which decides itself
  /// whether a new road is worth asking for).
  void _onLive(DriverLive live) {
    final v = ref.read(tripViewProvider(widget.tripId));
    if (v == null || !v.tracking) return;
    RiderMapScope.maybeOf(context)?.carFor(widget.tripId).push((lat: live.lat, lng: live.lng), heading: live.heading, speed: live.speed, at: live.at);
    if (v.driving) {
      final target = v.stage == RiderStage.inTrip ? v.trip.dropoff : v.trip.pickup;
      ref.read(tripEtaProvider(widget.tripId).notifier).track((lat: live.lat, lng: live.lng), (lat: target.lat, lng: target.lng));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
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
    final view = ref.watch(tripViewProvider(widget.tripId));
    if (view == null) {
      final async = ref.watch(tripProvider(widget.tripId));
      return async.hasError ? Problem(async.error, describe: (e) => describeError(l, e), onRetry: () => ref.invalidate(tripProvider(widget.tripId)), retryLabel: l.retry) : const SkeletonList(rows: 3);
    }
    final t = view.trip;
    final stage = view.stage;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _onStage(stage);
    });
    if (view.tracking) {
      ref.listen(driverLiveProvider(t.id), (_, next) {
        final live = next.value;
        if (live != null) _onLive(live);
      });
      // the first sample may have landed before the listener: start the car from it
      final live = view.live;
      final car = RiderMapScope.maybeOf(context)?.carFor(t.id);
      if (live != null && car != null && car.pose == null) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && car.pose == null) _onLive(live);
        });
      }
    }
    final parties = t.driver == null ? null : ref.watch(tripPartiesProvider(t.id)).value;
    final pinOn = ref.watch(featureProvider(Feature.tripPin));
    return SharedAxisSwitcher(
      child: KeyedSubtree(
        key: ValueKey(stage),
        child: switch (stage) {
          RiderStage.finding => _Finding(trip: t, busy: _busy, error: _error, onCancel: () => _cancel(t)),
          RiderStage.driverAssigned || RiderStage.driverArrived => _DriverCard(
              trip: t, parties: parties, arrived: stage == RiderStage.driverArrived, live: view.live, etaSeconds: view.etaSeconds, pinOn: pinOn, busy: _busy, error: _error, onCancel: () => _cancel(t)),
          RiderStage.inTrip => _InTrip(trip: t, parties: parties, etaSeconds: view.etaSeconds),
          RiderStage.completed => _Ended(trip: t, parties: parties, completed: true),
          RiderStage.cancelled => _Ended(trip: t, parties: parties, completed: false),
          RiderStage.unknown => Text(tripStatusLabel(l, t.status)),
        },
      ),
    );
  }
}

/// Share and SOS over the map (back once the trip is over).
class TripTopBar extends ConsumerWidget {
  const TripTopBar({super.key, required this.tripId});
  final String tripId;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final t = ref.watch(tripProvider(tripId)).value;
    final sosOn = ref.watch(featureProvider(Feature.sos));
    if (t == null) return const SizedBox.shrink();
    return Row(
      children: [
        if (!t.isActive) RoundIconButton(icon: Icons.arrow_back_rounded, tooltip: l.back, onTap: () => context.go(Routes.riderHome)),
        const Spacer(),
        if (t.isActive && t.status != TripStatus.requested) ...[_ShareButton(tripId: t.id), const SizedBox(width: 10)],
        // SOS on a trip with a driver, and for 30 min after drop-off (support-service's window)
        if (sosOn && sosAvailable(t, DateTime.now())) RoundIconButton(icon: Icons.sos_rounded, tooltip: l.sos, danger: true, onTap: () => context.push('${Routes.sos}?trip=${t.id}')),
      ],
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
  const _Finding({required this.trip, required this.busy, required this.error, required this.onCancel});
  final Trip trip;
  final bool busy;
  final Object? error;
  final VoidCallback onCancel;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Flexible(child: StatusPill(l.statusRequested, tone: Tone.amber, pulse: true)),
            const SizedBox(width: 8),
            ElapsedText(key: const ValueKey('searching-for'), since: trip.times.requestedAt, format: mmss, style: AnbessaType.label.copyWith(color: c.muted, fontFeatures: AnbessaType.tabular)),
          ],
        ),
        const SizedBox(height: 12),
        Text(l.findingDriver, style: AnbessaType.h2.copyWith(color: c.text)),
        const SizedBox(height: 4),
        Text(l.findingDriverLede, style: AnbessaType.body2.copyWith(color: c.text2)),
        const SizedBox(height: 14),
        Row(
          children: [
            Container(width: 10, height: 10, decoration: BoxDecoration(color: c.text, borderRadius: BorderRadius.circular(2))),
            const SizedBox(width: 10),
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

/// The driver's photo, flying to the pay and rating pages.
class _DriverAvatar extends StatelessWidget {
  const _DriverAvatar({required this.tripId, required this.photo, required this.name, this.size = 56});
  final String tripId;
  final String? photo;
  final String name;
  final double size;
  @override
  Widget build(BuildContext context) => Hero(tag: driverAvatarHeroTag(tripId), child: AvatarImage(src: photo, name: name, size: size, ring: true));
}

class _DriverCard extends StatelessWidget {
  const _DriverCard({required this.trip, required this.parties, required this.arrived, required this.live, required this.etaSeconds, required this.pinOn, required this.busy, required this.error, required this.onCancel});
  final Trip trip;
  final TripParties? parties;
  final bool arrived;
  final DriverLive? live;
  final int? etaSeconds;
  final bool pinOn;
  final bool busy;
  final Object? error;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final name = parties?.driverName ?? l.driverLabel;
    final vehicle = parties?.vehicle;
    final step = arrived ? 2 : (trip.status == TripStatus.enRoute ? 1 : 0);
    final sample = live;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: Text(arrived ? l.driverArrived(name) : l.driverOnTheWay(name), style: AnbessaType.h2.copyWith(color: c.text), maxLines: 3, overflow: TextOverflow.ellipsis)),
            if (!arrived && etaSeconds != null) EtaBadge(seconds: etaSeconds, minuteLabel: (m) => l.rideMinutes(m), large: true, icon: Icons.schedule_rounded),
          ],
        ),
        if (sample != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            // stale after 20 s without a position; checked every few seconds, not every frame
            child: TickingBuilder(
              interval: const Duration(seconds: 5),
              builder: (context, now) {
                final stale = now.toUtc().difference(sample.at) > const Duration(seconds: 20);
                return Text(stale ? l.positionStale(since(sample.at, now.toUtc())) : l.liveTracking, style: AnbessaType.caption.copyWith(color: stale ? c.warning : c.success, fontWeight: FontWeight.w600));
              },
            ),
          ),
        const SizedBox(height: 14),
        _Progress(step: step),
        const SizedBox(height: 16),
        Row(
          children: [
            _DriverAvatar(tripId: trip.id, photo: parties?.driverPhoto, name: name),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(name, style: AnbessaType.title.copyWith(color: c.text), maxLines: 1, overflow: TextOverflow.ellipsis),
                  const SizedBox(height: 2),
                  RatingSummary(average: parties?.driverRating, count: parties?.driverRatingCount ?? 0, newLabel: l.newDriver),
                  if (vehicle != null && vehicle.label.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(vehicle.label, style: AnbessaType.caption.copyWith(color: c.text2), maxLines: 1, overflow: TextOverflow.ellipsis),
                  ],
                ],
              ),
            ),
            if (vehicle != null) ...[const SizedBox(width: 8), PlateBadge(vehicle.plateNumber)],
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
        // the free window closes on its own: checked every few seconds
        TickingBuilder(
          interval: const Duration(seconds: 5),
          builder: (context, now) => riderCancelIsFree(trip, now.toUtc())
              ? const SizedBox.shrink()
              : Padding(padding: const EdgeInsets.only(top: 6), child: Text(l.cancelFeeWarning(birr(_cancelFeeMinor, locale: context.localeTag)), style: AnbessaType.caption.copyWith(color: c.muted))),
        ),
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
    final eta = etaSeconds;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(l.inTrip(trip.dropoff.address ?? l.dropoffLabel), style: AnbessaType.h2.copyWith(color: c.text), maxLines: 2, overflow: TextOverflow.ellipsis),
        if (eta != null) ...[
          const SizedBox(height: 8),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: StatusPill(key: const ValueKey('arrive-at'), l.rideArriveAt(clockHHmm(DateTime.now().add(Duration(seconds: eta)))), tone: Tone.amber, icon: Icons.flag_rounded),
          ),
        ],
        const SizedBox(height: 14),
        const _Progress(step: 3),
        const SizedBox(height: 16),
        Row(
          children: [
            AvatarImage(src: parties?.driverPhoto, name: name, size: 40),
            const SizedBox(width: 10),
            Expanded(child: Text(name, style: AnbessaType.body.copyWith(color: c.text2), maxLines: 1, overflow: TextOverflow.ellipsis)),
            if (parties?.vehicle != null) PlateBadge(parties!.vehicle!.plateNumber),
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
  const _Ended({required this.trip, required this.parties, required this.completed});
  final Trip trip;
  final TripParties? parties;
  final bool completed;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final cancelledBy = trip.cancellation?.by.name ?? '';
    final name = parties?.driverName ?? l.driverLabel;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            if (completed && trip.driver != null) ...[_DriverAvatar(tripId: trip.id, photo: parties?.driverPhoto, name: name, size: 44), const SizedBox(width: 12)],
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
        if (completed) PrimaryButton(label: trip.isDigital ? l.payTitle : l.receiptTitle, icon: trip.isDigital ? Icons.payments_rounded : Icons.receipt_long_rounded, onPressed: () => context.go(Routes.riderPay(trip.id))),
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
              SettingsTile(icon: Icons.ios_share_rounded, title: l.shareTrip, onTap: () => Navigator.pop(ctx, 'again')),
              SettingsTile(icon: Icons.link_off_rounded, title: l.stopSharing, destructive: true, onTap: () => Navigator.pop(ctx, 'stop')),
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
    return Stack(
      alignment: Alignment.center,
      children: [
        RoundIconButton(icon: on ? Icons.share_location_rounded : Icons.ios_share_rounded, tooltip: on ? l.sharingOn : l.shareTrip, onTap: _busy ? null : (on ? _menu : _start)),
        if (_busy) IgnorePointer(child: SizedBox(width: 40, height: 40, child: CircularProgressIndicator(strokeWidth: 2, color: c.accent))),
      ],
    );
  }
}
