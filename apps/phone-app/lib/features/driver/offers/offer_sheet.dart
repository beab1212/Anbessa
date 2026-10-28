// The offer sheet (workflow 05 D16–18): the fare big, the car class, where to and how long the
// trip is, how the rider pays, a 15-second ring, slide to accept or Decline. It springs up over
// the driver's home, whose map draws the offer's route (pickup leg dotted, the trip solid).
//
// Only the ring animates (its own controller); the sheet rebuilds once when time runs out.

import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../config/client_config_provider.dart';
import '../../maps/nav/navigation_controller.dart';
import '../../rider/history/history_screens.dart' show HairlineRouteCard;
import 'offer_controller.dart';

/// The road between the offer's pickup and drop-off (for the trip's length and the map line).
final offerRouteProvider = FutureProvider.autoDispose.family<RouteSteps?, TripOffer>((ref, o) async {
  try {
    return await ref.read(routeFetcherProvider)(fromLat: o.pickup.lat, fromLng: o.pickup.lng, toLat: o.dropoff.lat, toLng: o.dropoff.lng, steps: false);
  } catch (_) {
    return null;
  }
});

/// How long a driver has to answer.
const offerWindow = Duration(seconds: 15);

class OfferSheet extends ConsumerStatefulWidget {
  const OfferSheet({super.key, required this.state, this.now = DateTime.now});
  final OfferState state;
  /// the clock (tests pass their own)
  final DateTime Function() now;
  @override
  ConsumerState<OfferSheet> createState() => _OfferSheetState();
}

class _OfferSheetState extends ConsumerState<OfferSheet> {
  bool _expired = false;
  String? _offerId;

  void _sync() {
    final o = widget.state.offer;
    if (o?.offerId == _offerId) return;
    _offerId = o?.offerId;
    _expired = o == null || o.remaining(widget.now().toUtc()) <= Duration.zero;
  }

  @override
  Widget build(BuildContext context) {
    _sync();
    final l = context.l10n;
    final c = context.colors;
    final o = widget.state.offer;
    final cfg = ref.watch(configProvider);
    final route = o == null ? null : ref.watch(offerRouteProvider(o)).value;
    final vehicleName = o == null ? '' : (cfg.vehicleTypes.where((v) => v.code == o.vehicleType).firstOrNull?.name ?? o.vehicleType);
    final cash = o?.paymentMethod == PaymentMethod.cash;
    return Positioned.fill(
      child: Container(
        color: const Color(0x55000000),
        alignment: Alignment.bottomCenter,
        child: SpringSlideIn(
          key: ValueKey(o?.offerId ?? widget.state.notice),
          child: Container(
            width: double.infinity,
            decoration: BoxDecoration(color: c.page, borderRadius: const BorderRadius.vertical(top: Radius.circular(AnbessaRadius.sheet)), boxShadow: AnbessaElevation.sheet(c.brightness)),
            child: SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 0, AnbessaSpace.page, 16),
                child: o == null
                    ? Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const SheetHandle(),
                          const SizedBox(height: 8),
                          ListRowTile(
                            leading: ExcludeSemantics(child: CircleIcon(widget.state.notice == 'cancelled' ? Icons.cancel_outlined : Icons.timer_off_outlined, color: c.muted)),
                            title: widget.state.notice == 'cancelled' ? l.offerCancelled : l.offerExpired,
                          ),
                        ],
                      )
                    : SingleChildScrollView(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            const SheetHandle(),
                            const SizedBox(height: 8),
                            // the headline: "New trip", the fare big, the ring
                            Row(
                              children: [
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(l.newTrip, style: AnbessaType.h2.copyWith(color: c.text)),
                                      const SizedBox(height: 4),
                                      FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: AnimatedMoney(o.fareEstimateMinor, locale: context.localeTag, style: AnbessaType.display.copyWith(fontSize: 32, color: c.text))),
                                    ],
                                  ),
                                ),
                                const SizedBox(width: 12),
                                OfferRing(
                                  key: ValueKey(o.offerId),
                                  expiresAt: o.expiresAt,
                                  now: widget.now,
                                  onDone: () {
                                    if (mounted && !_expired) setState(() => _expired = true);
                                  },
                                ),
                              ],
                            ),
                            const SizedBox(height: 16),
                            // the route, as on the kit's choose-ride sheet
                            HairlineRouteCard(pickup: o.pickup.address ?? l.pickupLabel, dropoff: o.dropoff.address ?? l.dropoffLabel),
                            const SizedBox(height: 12),
                            // the car class, the trip's length and the way to the pickup; how the rider pays
                            AppCard(
                              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                              child: Row(
                                children: [
                                  ExcludeSemantics(child: VehicleArt(o.vehicleType, width: 56)),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(vehicleName, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.title.copyWith(color: c.text)),
                                        const SizedBox(height: 4),
                                        route == null
                                            ? const Skeleton.line(width: 90, height: 12)
                                            : Text(l.tripOf(km(route.distanceMeters), minutesOf(route.durationSeconds)), style: AnbessaType.caption.copyWith(fontSize: 12, color: c.muted, fontFeatures: AnbessaType.tabular), maxLines: 1, overflow: TextOverflow.ellipsis),
                                        if (o.etaToPickupSeconds != null) ...[
                                          const SizedBox(height: 2),
                                          Text(l.pickupIn((o.etaToPickupSeconds! / 60).ceil()), style: AnbessaType.caption.copyWith(fontSize: 12, color: c.muted, fontFeatures: AnbessaType.tabular), maxLines: 1, overflow: TextOverflow.ellipsis),
                                        ],
                                      ],
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  StatusPill(paymentMethodLabel(l, o.paymentMethod), tone: cash ? Tone.amber : Tone.blue, icon: cash ? Icons.payments_outlined : Icons.phone_iphone_rounded),
                                ],
                              ),
                            ),
                            const SizedBox(height: 20),
                            Problem(widget.state.error, describe: (e) => describeError(l, e)),
                            if (widget.state.error != null) const SizedBox(height: 8),
                            SwipeToConfirm(label: l.slideToAccept, icon: Icons.check_rounded, height: AnbessaSize.button, busy: widget.state.busy, enabled: !_expired, onConfirmed: () => ref.read(offerProvider.notifier).accept()),
                            const SizedBox(height: 12),
                            PillButton(label: l.decline, variant: PillVariant.tonal, onPressed: widget.state.busy ? null : () => ref.read(offerProvider.notifier).decline()),
                          ],
                        ),
                      ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The offer's time left on a ring that runs down smoothly, with the seconds inside; only the
/// ring repaints. [onDone] once at zero.
class OfferRing extends StatefulWidget {
  const OfferRing({super.key, required this.expiresAt, this.total = offerWindow, this.size = 64, this.now = DateTime.now, this.onDone});
  final DateTime expiresAt;
  final Duration total;
  final double size;
  final DateTime Function() now;
  final VoidCallback? onDone;
  @override
  State<OfferRing> createState() => _OfferRingState();
}

class _OfferRingState extends State<OfferRing> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: widget.total);

  @override
  void initState() {
    super.initState();
    _run();
    // reported after the frame: the sheet around it rebuilds once to disable the slide
    _c.addStatusListener((s) {
      if (s != AnimationStatus.dismissed) return;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) widget.onDone?.call();
      });
    });
  }

  @override
  void didUpdateWidget(OfferRing old) {
    super.didUpdateWidget(old);
    if (old.expiresAt != widget.expiresAt) _run();
  }

  void _run() {
    final left = widget.expiresAt.difference(widget.now().toUtc());
    final total = widget.total.inMilliseconds;
    final frac = total == 0 ? 0.0 : (left.inMilliseconds / total).clamp(0.0, 1.0);
    // reverse from the fraction left: it reaches zero (dismissed) exactly at the deadline
    if (frac > 0) {
      _c.reverse(from: frac);
    } else {
      _c.value = 0;
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final size = widget.size;
    return Semantics(
      label: context.l10n.drvOfferExpiresIn((_c.value * widget.total.inSeconds).ceil()),
      child: RepaintBoundary(
        child: AnimatedBuilder(
          animation: _c,
          builder: (context, _) {
            final v = _c.value;
            final secs = (v * widget.total.inMilliseconds / 1000).ceil();
            final urgent = v < 0.3;
            return SizedBox(
              width: size,
              height: size,
              child: Stack(
                alignment: Alignment.center,
                children: [
                  SizedBox(width: size, height: size, child: CircularProgressIndicator(value: v, strokeWidth: 5, strokeCap: StrokeCap.round, color: urgent ? c.danger : c.accent, backgroundColor: c.border)),
                  Text('$secs', textScaler: TextScaler.noScaling, style: TextStyle(fontSize: size * 0.32, fontWeight: FontWeight.w800, color: urgent ? c.danger : c.text, fontFeatures: AnbessaType.tabular)),
                ],
              ),
            );
          },
        ),
      ),
    );
  }
}

/// Slides its child up from below with a spring (a plain fade when motion is reduced).
class SpringSlideIn extends StatefulWidget {
  const SpringSlideIn({super.key, required this.child});
  final Widget child;
  @override
  State<SpringSlideIn> createState() => _SpringSlideInState();
}

class _SpringSlideInState extends State<SpringSlideIn> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController.unbounded(vsync: this);
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    if (AnbessaMotion.reduced(context)) {
      _c.value = 1;
    } else {
      _c.animateWith(SpringSimulation(AnbessaMotion.springDescription, 0, 1, 0));
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: _c,
        child: widget.child,
        builder: (context, child) => FractionalTranslation(
          translation: Offset(0, (1 - _c.value) * 0.6),
          child: Opacity(opacity: _c.value.clamp(0.0, 1.0), child: child),
        ),
      );
}
