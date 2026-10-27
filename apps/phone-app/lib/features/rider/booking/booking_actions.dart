// Booking steps shared by the home sheet, the search and the choose-ride sheet: going to a place,
// and choosing when to be picked up.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/location/location_source.dart';
import '../../../core/router/routes.dart';
import '../../config/client_config_provider.dart';
import 'booking_controller.dart';

/// The rider's position as a pickup, when it is inside a served city.
Place? currentLocationPlace(BuildContext context, WidgetRef ref) {
  final me = ref.read(lastPositionProvider);
  if (me == null || ref.read(configProvider).cityAt(me.lat, me.lng) == null) return null;
  return Place(name: context.l10n.currentLocation, lat: me.lat, lng: me.lng);
}

/// Ride to [p]: with a pickup (the one chosen, or where the rider is) straight to choosing the
/// ride; otherwise the search with the pickup field focused.
void bookTo(BuildContext context, WidgetRef ref, Place p) {
  Haptics.medium();
  final booking = ref.read(bookingProvider.notifier);
  booking.setDropoff(p, quote: false);
  if (ref.read(bookingProvider).pickup == null) {
    final here = currentLocationPlace(context, ref);
    if (here != null) booking.setPickup(here, quote: false);
  }
  if (ref.read(bookingProvider).ready) {
    booking.quote();
    context.push(Routes.riderQuote);
  } else {
    context.push('${Routes.riderRoute}?focus=pickup');
  }
}

/// Now, or a time within the booking window (Addis time, like every time the app shows).
Future<void> chooseRideTime(BuildContext context, WidgetRef ref) async {
  final l = context.l10n;
  final b = ref.read(bookingProvider);
  final later = await showModalBottomSheet<bool>(
    context: context,
    builder: (ctx) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(padding: const EdgeInsets.fromLTRB(20, 4, 20, 8), child: Align(alignment: Alignment.centerLeft, child: Text(l.pickupTime, style: AnbessaType.h2.copyWith(color: ctx.colors.text)))),
          ChoiceRow(leading: const Icon(Icons.bolt_rounded), title: l.now, selected: !b.scheduling, onTap: () => Navigator.pop(ctx, false)),
          ChoiceRow(leading: const Icon(Icons.event_rounded), title: l.scheduleWhen, subtitle: b.scheduling ? dayAndTime(b.scheduledFor, locale: context.localeTag) : null, selected: b.scheduling, onTap: () => Navigator.pop(ctx, true)),
          const SizedBox(height: 8),
        ],
      ),
    ),
  );
  if (later == null || !context.mounted) return;
  if (!later) return ref.read(bookingProvider.notifier).scheduleAt(null);
  const w = ScheduleWindow.tripService;
  final now = DateTime.now().toUtc();
  final current = toAddis(b.scheduledFor ?? w.suggested(now));
  final first = toAddis(w.earliest(now));
  final last = toAddis(w.latest(now));
  final day = await showDatePicker(
    context: context,
    initialDate: DateTime(current.year, current.month, current.day),
    firstDate: DateTime(first.year, first.month, first.day),
    lastDate: DateTime(last.year, last.month, last.day),
  );
  if (day == null || !context.mounted) return;
  final time = await showTimePicker(context: context, initialTime: TimeOfDay(hour: current.hour, minute: current.minute));
  if (time == null || !context.mounted) return;
  // the picked wall time is Addis time
  final at = DateTime.utc(day.year, day.month, day.day, time.hour, time.minute).subtract(addisOffset);
  final problem = w.check(at, DateTime.now().toUtc());
  if (problem != null) {
    Haptics.error();
    showToast(context, describeError(l, AppError(status: 400, code: problem, message: problem)), tone: NoticeTone.warning);
    return;
  }
  Haptics.selection();
  ref.read(bookingProvider.notifier).scheduleAt(at);
}
