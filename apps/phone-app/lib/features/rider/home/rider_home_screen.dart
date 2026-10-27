// The rider's home: the map around them with the cars nearby, and a sheet with "Where to?",
// Home and Work, and recent places. Picking a drop-off starts a booking.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/location/location_source.dart';
import '../../../core/router/routes.dart';
import '../../../core/session/session_controller.dart';
import '../../config/client_config_provider.dart';
import '../../maps/anbessa_map.dart';
import '../../maps/nearby_cars_layer.dart';
import '../../shell/shells.dart';
import '../booking/booking_controller.dart';
import '../scheduled/scheduled_rides_screen.dart';
import '../places/saved_places_controller.dart';

class RiderHomeScreen extends ConsumerStatefulWidget {
  const RiderHomeScreen({super.key});
  @override
  ConsumerState<RiderHomeScreen> createState() => _RiderHomeScreenState();
}

class _RiderHomeScreenState extends ConsumerState<RiderHomeScreen> with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  late final CarsAnimator _cars = CarsAnimator(vsync: this);
  double _sheetHeight = 0;
  bool _following = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _cars.addListener(_onCars);
    Future.microtask(_locate);
  }

  Future<void> _locate() async {
    final src = ref.read(locationSourceProvider);
    if (await src.ensurePermission(LocationProfile.once) != LocationPermissionState.granted) return;
    final p = await src.current();
    if (p != null && mounted) ref.read(lastPositionProvider.notifier).set(p);
  }

  void _onCars() {
    if (mounted) setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      final me = ref.read(lastPositionProvider);
      if (me != null) ref.read(nearbyCarsProvider.notifier).watch(me.lat, me.lng);
    } else if (state == AppLifecycleState.paused) {
      ref.read(nearbyCarsProvider.notifier).stop();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _cars.removeListener(_onCars);
    _cars.dispose();
    super.dispose();
  }

  String _greeting(AppLocalizations l, String name) {
    final h = DateTime.now().hour;
    return h < 12 ? l.greetingMorning(name) : h < 18 ? l.greetingAfternoon(name) : l.greetingEvening(name);
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final me = ref.watch(lastPositionProvider);
    final session = ref.watch(currentSessionProvider);
    final bannerH = ref.watch(bannerHeightProvider);
    final nearby = ref.watch(nearbyCarsProvider);
    ref.listen(nearbyCarsProvider, (_, next) => _cars.update(next.data.cars));
    if (me != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => ref.read(nearbyCarsProvider.notifier).watch(me.lat, me.lng));
    }
    final mePose = me == null ? null : MePose(position: LatLng(me.lat, me.lng), heading: me.heading, accuracy: me.accuracy);
    final poses = _cars.poses;
    final nearest = poses.isEmpty ? null : poses.first;
    final eta = nearby.data.etaSeconds;
    final firstName = session?.displayName.split(' ').first ?? '';

    return Stack(
      children: [
        AnbessaMap(
          mePose: mePose,
          cars: poses,
          follow: _following ? FollowMode.me : FollowMode.none,
          followZoom: 15,
          onUserGesture: () => setState(() => _following = false),
          onRecenter: () => setState(() => _following = true),
          topInset: bannerH + 64,
          bottomInset: _sheetHeight,
          callouts: [
            if (nearest != null && eta != null) MapCallout(point: nearest.position, label: l.minutesAway((eta / 60).ceil().clamp(1, 99)), icon: Icons.directions_car_filled, tone: Tone.amber),
          ],
        ),
        // greeting
        Positioned(
          top: MediaQuery.paddingOf(context).top + 8 + bannerH,
          left: 16,
          right: 16,
          child: Row(
            children: [
              Material(
                color: c.surface,
                borderRadius: BorderRadius.circular(AnbessaRadius.pill),
                child: InkWell(
                  onTap: () => context.go(Routes.riderAccount),
                  borderRadius: BorderRadius.circular(AnbessaRadius.pill),
                  child: Container(
                    padding: const EdgeInsets.fromLTRB(4, 4, 14, 4),
                    decoration: BoxDecoration(borderRadius: BorderRadius.circular(AnbessaRadius.pill), boxShadow: AnbessaElevation.floating(c.brightness)),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        AvatarImage(src: session?.profile.image, name: session?.displayName ?? '', size: 32),
                        const SizedBox(width: 8),
                        Text(session == null ? l.appName : _greeting(l, firstName), style: AnbessaType.label.copyWith(color: c.text, fontSize: 13)),
                      ],
                    ),
                  ),
                ),
              ),
              const Spacer(),
              if (nearby.data.driversNearby > 0 || nearby.loading)
                MapChip(
                  icon: Icons.directions_car_filled_outlined,
                  label: nearby.loading && nearby.data.cars.isEmpty ? '…' : l.carsNearby(nearby.data.driversNearby),
                ),
            ],
          ),
        ),
        AppSheet(
          snaps: const [0.34, 0.62, 0.92],
          onHeightChanged: (h) {
            if ((h - _sheetHeight).abs() > 2) setState(() => _sheetHeight = h);
          },
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
          builder: (context, _) => const _HomeSheet(),
        ),
      ],
    );
  }
}

class _HomeSheet extends ConsumerWidget {
  const _HomeSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final home = ref.watch(homePlaceProvider);
    final work = ref.watch(workPlaceProvider);
    final places = ref.watch(savedPlacesProvider);
    final recent = ref.watch(recentPlacesProvider);
    final scheduled = ref.watch(featureProvider(Feature.scheduledRides));

    void book(Place p) {
      Haptics.medium();
      ref.read(bookingProvider.notifier).setDropoff(p, quote: false);
      context.push('${Routes.riderRoute}?focus=pickup');
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // search
        Material(
          color: c.surface2,
          borderRadius: BorderRadius.circular(AnbessaRadius.lg),
          child: InkWell(
            borderRadius: BorderRadius.circular(AnbessaRadius.lg),
            onTap: () {
              Haptics.light();
              context.push('${Routes.riderRoute}?focus=dropoff');
            },
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
              decoration: BoxDecoration(borderRadius: BorderRadius.circular(AnbessaRadius.lg), border: Border.all(color: c.border)),
              child: Row(
                children: [
                  Expanded(child: Text(l.whereTo, style: AnbessaType.h2.copyWith(color: c.text))),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    decoration: BoxDecoration(color: c.surface, borderRadius: BorderRadius.circular(AnbessaRadius.pill), border: Border.all(color: c.border)),
                    child: Text(l.now, style: AnbessaType.label.copyWith(color: c.text2)),
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(height: 14),
        // saved places
        SizedBox(
          height: 96,
          child: places.isLoading && places.value == null
              ? const Row(children: [Skeleton.box(width: 96, height: 96, radius: 16), SizedBox(width: 10), Skeleton.box(width: 96, height: 96, radius: 16)])
              : ListView(
                  scrollDirection: Axis.horizontal,
                  children: [
                    IconTile(
                      icon: Icons.home_rounded,
                      label: l.savedHome,
                      sublabel: home?.name ?? l.setHome,
                      dashed: home == null,
                      onTap: home == null ? () => context.push('${Routes.riderRoute}?mode=savedPlace&label=home') : () => book(home.place),
                      onLongPress: () => context.push(Routes.savedPlaces),
                    ),
                    const SizedBox(width: 10),
                    IconTile(
                      icon: Icons.work_rounded,
                      label: l.savedWork,
                      sublabel: work?.name ?? l.setWork,
                      dashed: work == null,
                      onTap: work == null ? () => context.push('${Routes.riderRoute}?mode=savedPlace&label=work') : () => book(work.place),
                      onLongPress: () => context.push(Routes.savedPlaces),
                    ),
                    for (final p in (places.value ?? const <SavedPlace>[]).where((p) => p.label == PlaceLabel.other)) ...[
                      const SizedBox(width: 10),
                      IconTile(icon: Icons.star_rounded, label: p.name, sublabel: p.address, onTap: () => book(p.place), onLongPress: () => context.push(Routes.savedPlaces)),
                    ],
                    const SizedBox(width: 10),
                    IconTile(icon: Icons.add, label: l.addPlace, dashed: true, width: 80, onTap: () => context.push(Routes.savedPlaces)),
                  ],
                ),
        ),
        if (recent.isNotEmpty) ...[
          const SizedBox(height: 18),
          Text(l.recentPlaces, style: AnbessaType.label.copyWith(color: c.muted, letterSpacing: 0.4)),
          const SizedBox(height: 4),
          for (final p in recent.take(5))
            Dismissible(
              key: ValueKey('${p.lat},${p.lng}'),
              direction: DismissDirection.endToStart,
              background: Container(alignment: Alignment.centerRight, padding: const EdgeInsets.only(right: 20), child: Icon(Icons.delete_outline, color: c.danger)),
              onDismissed: (_) => ref.read(bookingProvider.notifier).forget(p),
              child: ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 4),
                title: Text(p.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.body.copyWith(fontWeight: FontWeight.w500)),
                subtitle: p.label == null ? null : Text(p.label!, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.caption.copyWith(color: c.muted)),
                onTap: () => book(p),
              ),
            ),
        ],
        if (scheduled) ...[
          const SizedBox(height: 14),
          Wrap(
            spacing: 8,
            children: [ActionChip(label: Text(l.scheduleRide), onPressed: () => startScheduling(context, ref))],
          ),
        ],
      ],
    );
  }
}
