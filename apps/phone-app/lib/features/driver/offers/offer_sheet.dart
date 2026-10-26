// The offer sheet (workflow 05 D16–18): where to, the fare, how the rider pays, a 15-second ring,
// Accept or Decline. Shown over the driver's home.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import 'offer_controller.dart';

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
    return Positioned.fill(
      child: Container(
        color: const Color(0x66000000),
        alignment: Alignment.bottomCenter,
        child: Container(
          width: double.infinity,
          decoration: BoxDecoration(color: c.surface, borderRadius: const BorderRadius.vertical(top: Radius.circular(18))),
          child: SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
              child: o == null
                  ? Row(children: [Icon(Icons.info_outline, color: c.muted), const SizedBox(width: 10), Expanded(child: Text(widget.state.notice == 'cancelled' ? l.offerCancelled : l.offerExpired))])
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
                                  Text(l.newTrip, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                                  if (o.etaToPickupSeconds != null) Text(l.pickupIn((o.etaToPickupSeconds! / 60).ceil().clamp(1, 99)), style: TextStyle(color: c.text2)),
                                ],
                              ),
                            ),
                            CountdownRing(remaining: o.remaining(_now), total: const Duration(seconds: 15), size: 56),
                          ],
                        ),
                        const SizedBox(height: 12),
                        _Place(icon: Icons.trip_origin, color: c.accent, text: o.pickup.address ?? l.pickupLabel),
                        _Place(icon: Icons.stop, color: c.text, text: o.dropoff.address ?? l.dropoffLabel),
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            StatusPill(paymentMethodLabel(l, o.paymentMethod), tone: o.paymentMethod == PaymentMethod.cash ? Tone.amber : Tone.blue),
                            const SizedBox(width: 8),
                            Text(o.vehicleType, style: TextStyle(color: c.muted)),
                            const Spacer(),
                            MoneyText(o.fareEstimateMinor, locale: context.localeTag, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                          ],
                        ),
                        const SizedBox(height: 12),
                        Problem(widget.state.error, describe: (e) => describeError(l, e)),
                        Row(
                          children: [
                            Expanded(child: OutlinedButton(onPressed: widget.state.busy ? null : () => ref.read(offerProvider.notifier).decline(), child: Text(l.decline))),
                            const SizedBox(width: 10),
                            Expanded(flex: 2, child: PrimaryButton(label: l.acceptOffer, busy: widget.state.busy, onPressed: () => ref.read(offerProvider.notifier).accept())),
                          ],
                        ),
                      ],
                    ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Place extends StatelessWidget {
  const _Place({required this.icon, required this.color, required this.text});
  final IconData icon;
  final Color color;
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(children: [Icon(icon, size: 16, color: color), const SizedBox(width: 8), Expanded(child: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis))]),
      );
}
