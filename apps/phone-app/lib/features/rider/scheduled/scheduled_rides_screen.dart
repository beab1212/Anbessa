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
import '../history/history_screens.dart' show TripVehicleIcon;
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
  const ScheduledRideTile({super.key, required this.trip, this.divider = true});
  final ScheduledTrip trip;
  /// a hairline under the row
  final bool divider;
  @override
  ConsumerState<ScheduledRideTile> createState() => _ScheduledRideTileState();
}

class _ScheduledRideTileState extends ConsumerState<ScheduledRideTile> {
  bool _busy = false;

  Future<void> _cancel() async {
    final l = context.l10n;
    final yes = await showConfirmSheet(context, title: l.cancelBooking, message: l.cancelBookingLede, confirmLabel: l.cancelBooking, cancelLabel: l.keepBooking, destructive: true);
    if (!yes || !mounted) return;
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
    return DecoratedBox(
      decoration: BoxDecoration(border: widget.divider ? Border(bottom: BorderSide(color: c.border)) : null),
      child: Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // the kit's scheduled row: where to, what and how much; the pickup time on the right
            ListRowTile(
              leading: TripVehicleIcon(t.vehicleType),
              title: t.dropoff.address ?? '—',
              subtitle: '$vehicle · ${birr(t.fareEstimateMinor, locale: loc)} · ${paymentMethodLabel(l, t.paymentMethod)}',
              value: clockOf(t.scheduledFor),
              valueSub: dayAndTime(t.scheduledFor, locale: loc).split(',').first,
              padding: const EdgeInsets.only(top: 14, bottom: 6),
            ),
            Padding(
              padding: const EdgeInsetsDirectional.only(start: AnbessaSize.rowIcon + 14),
              child: Wrap(
                spacing: 8,
                runSpacing: 4,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  StatusPill(scheduledStatusLabel(l, t.status), tone: scheduledTone(t.status)),
                  if (t.status == ScheduledStatus.scheduled) Text(l.searchStartsAt(clockOf(t.matchAt)), style: AnbessaType.caption.copyWith(fontSize: 12, color: c.muted)),
                  if (t.cancellable)
                    TextButton(
                      onPressed: _busy ? null : _cancel,
                      style: TextButton.styleFrom(foregroundColor: c.danger, visualDensity: VisualDensity.compact, padding: const EdgeInsets.symmetric(horizontal: 8)),
                      child: Text(l.cancelBooking),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The rider's upcoming bookings as Activity rows (the "Scheduled" chip); an empty state when
/// there are none.
class ScheduledRideList extends ConsumerWidget {
  const ScheduledRideList({super.key, this.emptyAction = true});
  /// "Schedule a ride" under the empty state (the Scheduled screen has it in its footer)
  final bool emptyAction;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final async = ref.watch(scheduledRidesProvider);
    final list = async.value ?? const <ScheduledTrip>[];
    return ListView(
      padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 24),
      children: [
        if (async.isLoading && list.isEmpty)
          const SkeletonList(rows: 3)
        else if (async.hasError && list.isEmpty)
          Problem(async.error, describe: (e) => describeError(l, e), onRetry: () => ref.read(scheduledRidesProvider.notifier).refresh(), retryLabel: l.retry)
        else if (list.isEmpty) ...[
          const SizedBox(height: 56),
          IllustratedEmpty(illustration: AnbessaIllustration.carWaiting, title: l.noScheduledRides, body: l.scheduledRidesLede, action: !emptyAction ? null : PillButton(label: l.scheduleRide, icon: Icons.event_rounded, expand: false, onPressed: () => startScheduling(context, ref))),
        ] else
          for (final (i, t) in list.indexed) ScheduledRideTile(key: ValueKey(t.id), trip: t, divider: i < list.length - 1),
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
    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(title: l.scheduledRides),
      body: RefreshIndicator(onRefresh: () => ref.read(scheduledRidesProvider.notifier).refresh(), child: const ScheduledRideList(emptyAction: false)),
      bottomNavigationBar: BottomActionBar(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            PillButton(label: l.scheduleRide, icon: Icons.event_rounded, onPressed: () => startScheduling(context, ref)),
            const SizedBox(height: 8),
            Text(l.scheduleWindowLede(ScheduleWindow.tripService.minAhead.inMinutes, ScheduleWindow.tripService.maxAhead.inDays), textAlign: TextAlign.center, style: AnbessaType.caption.copyWith(color: c.muted)),
          ],
        ),
      ),
    );
  }
}
