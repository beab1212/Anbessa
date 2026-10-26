// The rider's home: the map around them and "Where to?". Picking a drop-off starts a booking;
// the pickup defaults to the person's location (or they pick one).

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
import '../booking/booking_controller.dart';

class RiderHomeScreen extends ConsumerStatefulWidget {
  const RiderHomeScreen({super.key});
  @override
  ConsumerState<RiderHomeScreen> createState() => _RiderHomeScreenState();
}

class _RiderHomeScreenState extends ConsumerState<RiderHomeScreen> {
  @override
  void initState() {
    super.initState();
    // a quiet position fix for the map; permission is asked lazily
    Future.microtask(() async {
      final src = ref.read(locationSourceProvider);
      if (await src.ensurePermission(LocationProfile.once) != LocationPermissionState.granted) return;
      final p = await src.current();
      if (p != null && mounted) ref.read(lastPositionProvider.notifier).set(p);
    });
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final me = ref.watch(lastPositionProvider);
    final booking = ref.watch(bookingProvider);
    final recent = ref.read(bookingProvider.notifier).recent;
    final session = ref.watch(currentSessionProvider);
    final tilesDown = ref.watch(mapTilesDownProvider);
    final scheduled = ref.watch(featureProvider(Feature.scheduledRides));
    final promos = ref.watch(featureProvider(Feature.promos));
    final pickup = booking.pickup;

    return Stack(
      children: [
        AnbessaMap(
          center: me == null ? null : LatLng(me.lat, me.lng),
          zoom: 15,
          me: me == null ? null : LatLng(me.lat, me.lng),
          pickup: pickup == null ? null : LatLng(pickup.lat, pickup.lng),
        ),
        SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                child: Row(
                  children: [
                    Expanded(child: Text(session == null ? l.appName : session.displayName, style: TextStyle(fontWeight: FontWeight.w700, fontSize: 18, color: c.text, shadows: const [Shadow(color: Colors.white, blurRadius: 8)]))),
                    if (tilesDown) Tooltip(message: l.mapTilesUnavailable, child: Icon(Icons.layers_clear, color: c.muted)),
                  ],
                ),
              ),
              const Spacer(),
              Card(
                margin: const EdgeInsets.all(16),
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      InkWell(
                        borderRadius: BorderRadius.circular(anbessaRadius),
                        onTap: () => context.push(Routes.riderDropoff),
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                          decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(anbessaRadius), border: Border.all(color: c.border)),
                          child: Row(children: [Icon(Icons.search, color: c.accentStrong), const SizedBox(width: 10), Text(l.whereTo, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600))]),
                        ),
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Icon(Icons.trip_origin, size: 16, color: c.accent),
                          const SizedBox(width: 8),
                          Expanded(child: Text(pickup?.name ?? l.useCurrentLocation, style: TextStyle(color: c.text2), overflow: TextOverflow.ellipsis)),
                          TextButton(onPressed: () => context.push(Routes.riderPickup), child: Text(l.pickupLabel)),
                        ],
                      ),
                      if (recent.isNotEmpty) ...[
                        const Divider(height: 16),
                        Text(l.recentPlaces, style: TextStyle(color: c.muted, fontSize: 12, fontWeight: FontWeight.w600)),
                        for (final p in recent.take(3))
                          ListTile(
                            dense: true,
                            contentPadding: EdgeInsets.zero,
                            leading: Icon(Icons.history, color: c.muted, size: 20),
                            title: Text(p.name, maxLines: 1, overflow: TextOverflow.ellipsis),
                            onTap: () {
                              ref.read(bookingProvider.notifier).setDropoff(p);
                              _afterDropoff();
                            },
                          ),
                      ],
                      if (scheduled || promos) ...[
                        const Divider(height: 16),
                        Wrap(
                          spacing: 8,
                          children: [
                            if (scheduled) ActionChip(avatar: const Icon(Icons.schedule, size: 18), label: Text(l.scheduleRide), onPressed: () => context.push(Routes.scheduledNew)),
                            if (promos) ActionChip(avatar: const Icon(Icons.local_offer_outlined, size: 18), label: Text(l.promos), onPressed: () => context.push(Routes.promos)),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// A drop-off is chosen: the pickup is the person's position unless they picked one.
  Future<void> _afterDropoff() async {
    final b = ref.read(bookingProvider);
    if (b.pickup == null) {
      final me = ref.read(lastPositionProvider);
      if (me != null) {
        final cfg = ref.read(configProvider);
        if (cfg.cityAt(me.lat, me.lng) != null) {
          ref.read(bookingProvider.notifier).setPickup(Place(name: context.l10n.useCurrentLocation, lat: me.lat, lng: me.lng));
          if (mounted) context.push(Routes.riderQuote);
          return;
        }
      }
      if (mounted) context.push(Routes.riderPickup);
      return;
    }
    if (mounted) context.push(Routes.riderQuote);
  }
}
