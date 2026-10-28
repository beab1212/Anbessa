// The rider's home stage in the map shell, as the GoRide kit draws it: the map around them with
// the white cars nearby and the rider as their avatar pin (drawn by the shell), a round layers
// button (and the announcements bell when there are any) top right, and the sheet: "Where to?",
// the filled "Enter location" field that opens the search, and chips for Home, Work and the
// other saved places (a missing Home or Work is set from its chip). Before the first position:
// "Searching your location..." with the rings (the "Enable Location" card before the system's
// permission prompt is bootstrap/location_prompt.dart).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/location/location_source.dart';
import '../../../core/router/routes.dart';
import '../../bootstrap/gates.dart';
import '../../config/client_config_provider.dart';
import '../../maps/anbessa_map.dart' show showMapModePicker;
import '../../profile/saved_places_screen.dart';
import '../booking/booking_actions.dart';
import '../places/saved_places_controller.dart';
import '../scheduled/scheduled_rides_screen.dart';

/// "850 m" from the rider to [p], when the rider's position is known.
String? distanceFromMe(WidgetRef ref, double lat, double lng) {
  final me = ref.watch(lastPositionProvider);
  return me == null ? null : formatDistance(haversineMeters(me.lat, me.lng, lat, lng));
}

void openSearch(BuildContext context, {bool pickup = false}) {
  Haptics.light();
  context.push('${Routes.riderRoute}?focus=${pickup ? 'pickup' : 'dropoff'}');
}

class HomeSheet extends ConsumerWidget {
  const HomeSheet({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final home = ref.watch(homePlaceProvider);
    final work = ref.watch(workPlaceProvider);
    final places = ref.watch(savedPlacesProvider);
    final scheduledOn = ref.watch(featureProvider(Feature.scheduledRides));
    final others = (places.value ?? const <SavedPlace>[]).where((p) => p.label == PlaceLabel.other).toList();

    Widget fixed(PlaceLabel label, SavedPlace? p, String title) => OutlineChip(
          key: ValueKey('saved-${label.name}'),
          label: title,
          icon: p == null ? Icons.add_rounded : null,
          onTap: p == null ? () => pickAndSavePlace(context, ref, label) : () => bookTo(context, ref, p.place),
        );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(header: true, child: Text(l.whereTo, style: AnbessaType.h2.copyWith(color: c.text))),
        const SizedBox(height: 16),
        FilledField(
          key: const ValueKey('where-to'),
          hint: l.grEnterLocation,
          icon: Icons.location_on_outlined,
          readOnly: true,
          onTap: () => openSearch(context),
        ),
        const SizedBox(height: 16),
        ChipRow(
          padding: EdgeInsets.zero,
          children: [
            fixed(PlaceLabel.home, home, l.savedHome),
            fixed(PlaceLabel.work, work, l.savedWork),
            for (final p in others) OutlineChip(key: ValueKey('saved-${p.id}'), label: p.name, onTap: () => bookTo(context, ref, p.place)),
            if (scheduledOn) OutlineChip(key: const ValueKey('svc-later'), label: l.rideServiceLater, icon: Icons.calendar_month_outlined, onTap: () => startScheduling(context, ref)),
          ],
        ),
      ],
    );
  }
}

/// Home before the first position: "Searching your location..." over the kit's target dot.
class LocatingSheet extends StatelessWidget {
  const LocatingSheet({super.key});
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Column(
      children: [
        const SizedBox(height: 8),
        Semantics(liveRegion: true, child: Text(l.grSearchingLocation, textAlign: TextAlign.center, style: AnbessaType.h2.copyWith(color: c.text))),
        const SizedBox(height: 20),
        const LocatingDot(),
      ],
    );
  }
}

/// Top right of the home map: the round layers button (map view), and the announcements bell
/// when there are announcements for riders.
class HomeTopBar extends ConsumerWidget {
  const HomeTopBar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final ids = ref.watch(configProvider.select((cfg) => [for (final a in cfg.announcements) if (a.audiences.contains('rider')) a.id].join(',')));
    final news = ids.isEmpty ? 0 : ids.split(',').length;
    final dismissed = ref.watch(dismissedAnnouncementsProvider);
    final unread = ids.isEmpty ? 0 : ids.split(',').where((id) => !dismissed.contains(id)).length;
    return Align(
      alignment: AlignmentDirectional.topEnd,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          RoundIconButton(icon: Icons.layers_outlined, tooltip: l.mapModeTitle, onTap: () => showMapModePicker(context)),
          if (news > 0) ...[
            const SizedBox(height: 12),
            Badge(isLabelVisible: unread > 0, smallSize: 9, child: RoundIconButton(icon: Icons.notifications_none_rounded, tooltip: l.announcementsTitle, onTap: () => showAnnouncements(context))),
          ],
        ],
      ),
    );
  }
}

/// The announcements for riders, closed ones included.
Future<void> showAnnouncements(BuildContext context) => showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (ctx) => const _AnnouncementsSheet(),
    );

class _AnnouncementsSheet extends ConsumerWidget {
  const _AnnouncementsSheet();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final items = ref.watch(configProvider).announcements.where((a) => a.audiences.contains('rider')).toList();
    final dismissed = ref.watch(dismissedAnnouncementsProvider);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(l.announcementsTitle, style: AnbessaType.h2.copyWith(color: c.text)),
            const SizedBox(height: 12),
            if (items.isEmpty)
              IllustratedEmpty(illustration: AnbessaIllustration.noConnection, title: l.rideNoAnnouncements, compact: true)
            else
              Flexible(
                child: ListView.separated(
                  shrinkWrap: true,
                  itemCount: items.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 10),
                  itemBuilder: (_, i) {
                    final a = items[i];
                    return Opacity(
                      key: ValueKey(a.id),
                      opacity: dismissed.contains(a.id) ? 0.7 : 1,
                      child: Notice('${a.title.isEmpty ? '' : '${a.title}\n'}${a.body}', tone: a.severity == 'warning' ? NoticeTone.warning : NoticeTone.info),
                    );
                  },
                ),
              ),
          ],
        ),
      ),
    );
  }
}
