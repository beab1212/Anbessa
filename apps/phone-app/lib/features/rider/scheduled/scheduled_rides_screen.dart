// Scheduled rides (workflow 12): the upcoming bookings (in Activity and on their own screen), each
// cancellable until the driver search starts, and the way into booking one (the route editor,
// then the quote screen with a pickup time).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/router/routes.dart';
import '../../config/client_config_provider.dart';
import '../booking/booking_controller.dart';
import 'scheduled_rides_controller.dart';

/// Start booking a ride for later: a first pickup time is suggested, then the route editor.
void startScheduling(BuildContext context, WidgetRef ref) {
  Haptics.medium();
  final booking = ref.read(bookingProvider.notifier);
  booking.reset();
  booking.scheduleAt(ScheduleWindow.tripService.suggested(DateTime.now()));
  context.push('${Routes.riderRoute}?focus=dropoff');
}

Tone scheduledTone(ScheduledStatus s) => switch (s) {
      ScheduledStatus.scheduled => Tone.blue,
      ScheduledStatus.dispatching || ScheduledStatus.dispatched => Tone.amber,
      ScheduledStatus.failed => Tone.red,
      _ => Tone.grey,
    };

/// One booking: where to, when, the car and price, its status, and Cancel while it can be.
class ScheduledRideTile extends ConsumerStatefulWidget {
  const ScheduledRideTile({super.key, required this.trip});
  final ScheduledTrip trip;
  @override
  ConsumerState<ScheduledRideTile> createState() => _ScheduledRideTileState();
}

class _ScheduledRideTileState extends ConsumerState<ScheduledRideTile> {
  bool _busy = false;

  Future<void> _cancel() async {
    final l = context.l10n;
    final yes = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        content: Text(l.cancelBookingLede),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(l.keepBooking)), FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(l.cancelBooking))],
      ),
    );
    if (yes != true || !mounted) return;
    setState(() => _busy = true);
    try {
      await ref.read(scheduledRidesProvider.notifier).cancel(widget.trip.id);
      Haptics.success();
      if (mounted) showToast(context, l.bookingCancelled, tone: NoticeTone.ok);
    } catch (e) {
      Haptics.error();
      if (mounted) showToast(context, describeError(l, e), tone: NoticeTone.error);
      ref.read(scheduledRidesProvider.notifier).refresh();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final loc = context.localeTag;
    final t = widget.trip;
    final cfg = ref.watch(configProvider);
    final vehicle = cfg.vehicleTypes.where((v) => v.code == t.vehicleType).firstOrNull?.name ?? t.vehicleType;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: Text(dayAndTime(t.scheduledFor, locale: loc), style: AnbessaType.title.copyWith(color: c.text, fontFeatures: AnbessaType.tabular))),
              const SizedBox(width: 8),
              StatusPill(scheduledStatusLabel(l, t.status), tone: scheduledTone(t.status)),
            ],
          ),
          const SizedBox(height: 4),
          Text(t.dropoff.address ?? '—', maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.body.copyWith(color: c.text, fontWeight: FontWeight.w600)),
          Text('${l.pickupLabel}: ${t.pickup.address ?? '—'}', maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.body2.copyWith(color: c.text2)),
          const SizedBox(height: 4),
          Text('$vehicle · ${birr(t.fareEstimateMinor, locale: loc)} · ${paymentMethodLabel(l, t.paymentMethod)}', style: AnbessaType.caption.copyWith(color: c.muted)),
          if (t.status == ScheduledStatus.scheduled) Text(l.searchStartsAt(clockOf(t.matchAt)), style: AnbessaType.caption.copyWith(color: c.muted)),
          if (t.cancellable)
            Align(
              alignment: AlignmentDirectional.centerEnd,
              child: TextButton(
                onPressed: _busy ? null : _cancel,
                style: TextButton.styleFrom(foregroundColor: c.danger, visualDensity: VisualDensity.compact),
                child: Text(l.cancelBooking),
              ),
            ),
        ],
      ),
    );
  }
}

/// The "Upcoming" block at the top of the rider's Activity: nothing when the flag is off or
/// there's nothing booked.
class UpcomingRidesSection extends ConsumerWidget {
  const UpcomingRidesSection({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    if (!ref.watch(featureProvider(Feature.scheduledRides))) return const SizedBox.shrink();
    final list = ref.watch(scheduledRidesProvider).value ?? const <ScheduledTrip>[];
    if (list.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(padding: const EdgeInsets.fromLTRB(4, 14, 4, 6), child: Text(l.upcomingRides, style: AnbessaType.label.copyWith(color: c.muted, letterSpacing: 0.4))),
        SectionGroup(margin: EdgeInsets.zero, children: [for (final t in list) ScheduledRideTile(key: ValueKey(t.id), trip: t)]),
      ],
    );
  }
}

/// Account → Scheduled rides and the home chip: the upcoming bookings and "Schedule a ride".
class ScheduledRidesScreen extends ConsumerWidget {
  const ScheduledRidesScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final async = ref.watch(scheduledRidesProvider);
    final list = async.value ?? const <ScheduledTrip>[];
    return Scaffold(
      appBar: AppBar(title: Text(l.scheduledRides)),
      body: RefreshIndicator(
        onRefresh: () => ref.read(scheduledRidesProvider.notifier).refresh(),
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (async.isLoading && list.isEmpty)
              const SkeletonList(rows: 3)
            else if (async.hasError && list.isEmpty)
              Problem(async.error, describe: (e) => describeError(l, e), onRetry: () => ref.read(scheduledRidesProvider.notifier).refresh(), retryLabel: l.retry)
            else if (list.isEmpty)
              Padding(padding: const EdgeInsets.only(top: 40), child: IllustratedEmpty(illustration: AnbessaIllustration.carWaiting, title: l.noScheduledRides, body: l.scheduledRidesLede))
            else
              SectionGroup(title: l.upcomingRides, margin: EdgeInsets.zero, children: [for (final t in list) ScheduledRideTile(key: ValueKey(t.id), trip: t)]),
            const SizedBox(height: 16),
            PrimaryButton(label: l.scheduleRide, onPressed: () => startScheduling(context, ref)),
            const SizedBox(height: 8),
            Text(l.scheduleWindowLede(ScheduleWindow.tripService.minAhead.inMinutes, ScheduleWindow.tripService.maxAhead.inDays), textAlign: TextAlign.center, style: AnbessaType.caption.copyWith(color: c.muted)),
          ],
        ),
      ),
    );
  }
}
