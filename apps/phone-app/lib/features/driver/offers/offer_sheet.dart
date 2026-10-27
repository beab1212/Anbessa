// The offer sheet (workflow 05 D16–18): where to, how long the trip is, the fare, how the rider
// pays, a 15-second ring, slide to accept or Decline. Shown over the driver's home, which also
// draws the offer's pickup and drop-off on the map.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../config/client_config_provider.dart';
import '../../maps/nav/navigation_controller.dart';
import 'offer_controller.dart';

/// The road between the offer's pickup and drop-off (for the trip's length and the map line).
final offerRouteProvider = FutureProvider.autoDispose.family<RouteSteps?, TripOffer>((ref, o) async {
  try {
    return await ref.read(routeFetcherProvider)(fromLat: o.pickup.lat, fromLng: o.pickup.lng, toLat: o.dropoff.lat, toLng: o.dropoff.lng, steps: false);
  } catch (_) {
    return null;
  }
});

class OfferSheet extends ConsumerStatefulWidget {
  const OfferSheet({super.key, required this.state});
  final OfferState state;
  @override
  ConsumerState<OfferSheet> createState() => _OfferSheetState();
}

class _OfferSheetState extends ConsumerState<OfferSheet> {
  Timer? _tick;
  DateTime _now = DateTime.now().toUtc();
  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(milliseconds: 250), (_) => setState(() => _now = DateTime.now().toUtc()));
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final o = widget.state.offer;
    final cfg = ref.watch(configProvider);
    final route = o == null ? null : ref.watch(offerRouteProvider(o)).value;
    final vehicleName = o == null ? '' : (cfg.vehicleTypes.where((v) => v.code == o.vehicleType).firstOrNull?.name ?? o.vehicleType);
    final remaining = o?.remaining(_now) ?? Duration.zero;
    return Positioned.fill(
      child: Container(
        color: const Color(0x66000000),
        alignment: Alignment.bottomCenter,
        child: FadeSlideIn(
          key: ValueKey(o?.offerId ?? widget.state.notice),
          offset: 0.2,
          child: Container(
            width: double.infinity,
            decoration: BoxDecoration(color: c.surface, borderRadius: const BorderRadius.vertical(top: Radius.circular(AnbessaRadius.sheet)), boxShadow: AnbessaElevation.sheet(c.brightness)),
            child: SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 18, 20, 16),
                child: o == null
                    ? Text(widget.state.notice == 'cancelled' ? l.offerCancelled : l.offerExpired, style: AnbessaType.body.copyWith(color: c.text))
                    : Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(l.newTrip, style: AnbessaType.h2.copyWith(color: c.text)),
                                    const SizedBox(height: 4),
                                    Row(
                                      children: [
                                        if (o.etaToPickupSeconds != null) ...[EtaBadge(seconds: o.etaToPickupSeconds, minuteLabel: (m) => l.pickupIn(m), icon: Icons.near_me_outlined), const SizedBox(width: 6)],
                                        Flexible(
                                          child: route == null
                                              ? const Skeleton.line(width: 90, height: 12)
                                              : Text(l.tripOf(km(route.distanceMeters), minutesOf(route.durationSeconds)), style: AnbessaType.caption.copyWith(color: c.muted, fontFeatures: AnbessaType.tabular), maxLines: 1, overflow: TextOverflow.ellipsis),
                                        ),
                                      ],
                                    ),
                                  ],
                                ),
                              ),
                              CountdownRing(remaining: remaining, total: const Duration(seconds: 15), size: 60),
                            ],
                          ),
                          const SizedBox(height: 14),
                          _Place(color: c.accent, text: o.pickup.address ?? l.pickupLabel),
                          Padding(padding: const EdgeInsets.only(left: 7), child: Container(width: 2, height: 10, color: c.border)),
                          _Place(square: true, color: c.text, text: o.dropoff.address ?? l.dropoffLabel),
                          const SizedBox(height: 14),
                          Row(
                            children: [
                              StatusPill(paymentMethodLabel(l, o.paymentMethod), tone: o.paymentMethod == PaymentMethod.cash ? Tone.amber : Tone.blue, icon: o.paymentMethod == PaymentMethod.cash ? Icons.payments_outlined : Icons.phone_iphone),
                              const SizedBox(width: 8),
                              Flexible(child: StatusPill(vehicleName, tone: Tone.grey, icon: vehicleIcon(o.vehicleType))),
                              const Spacer(),
                              AnimatedMoney(o.fareEstimateMinor, locale: context.localeTag, style: AnbessaType.h1.copyWith(color: c.text)),
                            ],
                          ),
                          const SizedBox(height: 14),
                          Problem(widget.state.error, describe: (e) => describeError(l, e)),
                          SwipeToConfirm(label: l.slideToAccept, icon: Icons.check_rounded, busy: widget.state.busy, enabled: remaining > Duration.zero, onConfirmed: () => ref.read(offerProvider.notifier).accept()),
                          const SizedBox(height: 4),
                          TextButton(onPressed: widget.state.busy ? null : () => ref.read(offerProvider.notifier).decline(), child: Text(l.decline)),
                        ],
                      ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Place extends StatelessWidget {
  const _Place({required this.color, required this.text, this.square = false});
  final Color color;
  final String text;
  final bool square;
  @override
  Widget build(BuildContext context) => Row(children: [
        // the same plain dot / square the map uses for pickup and drop-off
        SizedBox(width: 16, child: Center(child: Container(width: 10, height: 10, decoration: BoxDecoration(color: color, shape: square ? BoxShape.rectangle : BoxShape.circle)))),
        const SizedBox(width: 10), Expanded(child: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.body.copyWith(fontWeight: FontWeight.w500)))]);
}
