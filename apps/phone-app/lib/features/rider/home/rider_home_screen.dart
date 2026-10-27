// The rider's home stage in the map shell: the map around them with the cars nearby (drawn by the
// shell), a floating bar (their photo and a greeting → Account, announcements), a "N cars nearby
// · ~4 min" chip above the sheet, and the sheet: the big "Where to?" bar with its "Now ▾" chip,
// the services (Ride, Later when scheduled rides are on, Places), and Home, Work, other saved
// places and recent places with their icons and distance.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/location/location_source.dart';
import '../../../core/router/routes.dart';
import '../../../core/session/session_controller.dart';
import '../../bootstrap/gates.dart';
import '../../config/client_config_provider.dart';
import '../../maps/nearby_cars_layer.dart';
import '../../profile/saved_places_screen.dart';
import '../booking/booking_actions.dart';
import '../booking/booking_controller.dart';
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
    final recent = ref.watch(recentPlacesProvider);
    final scheduledOn = ref.watch(featureProvider(Feature.scheduledRides));
    final at = ref.watch(bookingProvider.select((b) => b.scheduledFor));
    final others = (places.value ?? const <SavedPlace>[]).where((p) => p.label == PlaceLabel.other).toList();

    Widget fixed(PlaceLabel label, SavedPlace? p, IconData icon, String title, String setLabel) => SuggestionRow(
          key: ValueKey('saved-${label.name}'),
          icon: icon,
          title: title,
          subtitle: p?.name ?? setLabel,
          distance: p == null ? null : distanceFromMe(ref, p.lat, p.lng),
          highlight: p != null,
          onTap: p == null ? () => pickAndSavePlace(context, ref, label) : () => bookTo(context, ref, p.place),
          onLongPress: () => context.push(Routes.savedPlaces),
        );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SearchBarButton(
          hint: l.whereTo,
          heroTag: 'where-to',
          onTap: () => openSearch(context),
          trailingLabel: at == null ? l.now : dayAndTime(at, locale: context.localeTag),
          onTrailingTap: scheduledOn ? () => chooseRideTime(context, ref) : () => openSearch(context),
        ),
        const SizedBox(height: 14),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          clipBehavior: Clip.none,
          child: Row(
            children: [
              ServiceTile(key: const ValueKey('svc-ride'), label: l.ride, icon: Icons.local_taxi_rounded, selected: true, onTap: () => openSearch(context)),
              if (scheduledOn) ...[
                const SizedBox(width: 10),
                ServiceTile(key: const ValueKey('svc-later'), label: l.rideServiceLater, icon: Icons.event_rounded, onTap: () => startScheduling(context, ref)),
              ],
              const SizedBox(width: 10),
              ServiceTile(key: const ValueKey('svc-places'), label: l.quickPlaces, icon: Icons.bookmark_rounded, onTap: () => context.push(Routes.savedPlaces)),
            ],
          ),
        ),
        const SizedBox(height: 10),
        if (places.isLoading && places.value == null)
          const SkeletonList(rows: 2)
        else ...[
          fixed(PlaceLabel.home, home, Icons.home_rounded, l.savedHome, l.setHome),
          fixed(PlaceLabel.work, work, Icons.work_rounded, l.savedWork, l.setWork),
          for (final p in others)
            SuggestionRow(
              key: ValueKey('saved-${p.id}'),
              icon: Icons.star_rounded,
              title: p.name,
              subtitle: p.address,
              distance: distanceFromMe(ref, p.lat, p.lng),
              onTap: () => bookTo(context, ref, p.place),
              onLongPress: () => context.push(Routes.savedPlaces),
            ),
        ],
        if (recent.isNotEmpty) ...[
          const SizedBox(height: 8),
          Padding(padding: const EdgeInsets.fromLTRB(4, 4, 4, 2), child: Text(l.recentPlaces, style: AnbessaType.label.copyWith(color: c.muted, letterSpacing: 0.4))),
          for (final p in recent.take(5))
            Dismissible(
              key: ValueKey('recent-${p.lat},${p.lng},${p.name}'),
              direction: DismissDirection.endToStart,
              background: Container(alignment: Alignment.centerRight, padding: const EdgeInsets.only(right: 20), child: Icon(Icons.delete_outline_rounded, color: c.danger)),
              onDismissed: (_) => ref.read(bookingProvider.notifier).forget(p),
              child: SuggestionRow(
                icon: p.category == null ? Icons.history_rounded : placeIcon(p.category, p.type),
                title: p.name,
                subtitle: p.label,
                distance: distanceFromMe(ref, p.lat, p.lng),
                onTap: () => bookTo(context, ref, p),
              ),
            ),
        ],
      ],
    );
  }
}

/// The floating bar on the home stage: the rider's photo and a greeting (→ Account), and the
/// announcements.
class HomeTopBar extends ConsumerWidget {
  const HomeTopBar({super.key});

  String _greeting(AppLocalizations l, String name) {
    final h = DateTime.now().hour;
    return h < 12 ? l.greetingMorning(name) : h < 18 ? l.greetingAfternoon(name) : l.greetingEvening(name);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final session = ref.watch(currentSessionProvider);
    final firstName = session?.displayName.split(' ').first ?? '';
    final news = ref.watch(configProvider.select((cfg) => cfg.announcements.where((a) => a.audiences.contains('rider')).length));
    return Row(
      children: [
        Flexible(
          child: DecoratedBox(
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(AnbessaRadius.pill), boxShadow: AnbessaElevation.floating(c.brightness)),
            child: Material(
              color: c.surface,
              shape: StadiumBorder(side: c.isDark ? BorderSide(color: c.border) : BorderSide.none),
              child: InkWell(
                customBorder: const StadiumBorder(),
                onTap: () {
                  Haptics.selection();
                  context.go(Routes.riderAccount);
                },
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(4, 4, 14, 4),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      AvatarImage(src: session?.profile.image, name: session?.displayName ?? '', size: 36),
                      const SizedBox(width: 8),
                      Flexible(child: Text(session == null ? l.appName : _greeting(l, firstName), maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.label.copyWith(color: c.text, fontSize: 13))),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
        const SizedBox(width: 8),
        Badge(
          isLabelVisible: news > 0,
          smallSize: 9,
          child: RoundIconButton(icon: Icons.notifications_none_rounded, tooltip: l.announcementsTitle, onTap: () => showAnnouncements(context)),
        ),
      ],
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

/// "3 cars nearby · ~4 min" above the home sheet.
class NearbyChip extends ConsumerWidget {
  const NearbyChip({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final n = ref.watch(nearbyCarsProvider);
    final count = n.data.driversNearby;
    final eta = n.data.etaSeconds;
    final Widget chip = count > 0
        ? MapChip(
            key: const ValueKey('cars'),
            icon: Icons.directions_car_filled_rounded,
            tone: c.accent,
            label: eta == null ? l.carsNearby(count) : '${l.carsNearby(count)} · ${l.rideNearbyEta((eta / 60).ceil().clamp(1, 99))}',
          )
        : n.loading && n.data.cars.isEmpty
            ? MapChip(key: const ValueKey('loading'), icon: Icons.directions_car_filled_rounded, label: '…')
            : const SizedBox.shrink(key: ValueKey('none'));
    return AnimatedSwitcherX(child: chip);
  }
}
