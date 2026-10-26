// The driver's trip (workflow 06, 07, 08 B): to the pickup ("On my way", navigate, "I've
// arrived" within 150 m) → waiting (free time, then per minute; no-show after 5 min) → start
// (PIN when the city requires it) → on the way → complete ("Collect X ETB cash" or paid digitally)
// → rate the rider.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/config/env.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/location/location_source.dart';
import '../../../core/network/providers.dart';
import '../../../core/router/routes.dart';
import '../../config/client_config_provider.dart';
import '../../maps/anbessa_map.dart';
import '../../rider/trip/active_trip_controller.dart';
import '../shift/driver_home_screen.dart';

class DriverTripScreen extends ConsumerStatefulWidget {
  const DriverTripScreen({super.key, required this.tripId});
  final String tripId;
  @override
  ConsumerState<DriverTripScreen> createState() => _DriverTripScreenState();
}

class _DriverTripScreenState extends ConsumerState<DriverTripScreen> {
  Timer? _tick;
  DateTime _now = DateTime.now().toUtc();
  bool _busy = false;
  Object? _error;
  String? _completeKey;
  String? _cancelKey;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() => _now = DateTime.now().toUtc()));
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  Future<void> _do(Future<Trip> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final t = await action();
      ref.read(activeTripProvider.notifier).replace(t);
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _start(Trip t, bool pinOn) async {
    String? pin;
    if (pinOn) {
      pin = await showDialog<String>(context: context, builder: (ctx) => const _PinDialog());
      if (pin == null) return;
    }
    await _do(() => ref.read(apisProvider).trips.start(t.id, pin: pin));
  }

  Future<void> _cancel(Trip t, {bool noShow = false}) async {
    final l = context.l10n;
    CancelReason? reason = noShow ? CancelReason.noShow : null;
    if (!noShow) {
      reason = await showModalBottomSheet<CancelReason>(
        context: context,
        builder: (ctx) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(padding: const EdgeInsets.all(16), child: Text(l.cancelReasonTitle, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700))),
              for (final r in [CancelReason.wrongPickup, CancelReason.safety, CancelReason.other]) ListTile(title: Text(cancelReasonLabel(l, r)), onTap: () => Navigator.pop(ctx, r)),
            ],
          ),
        ),
      );
    }
    if (reason == null) return;
    _cancelKey ??= newIdempotencyKey();
    await _do(() => ref.read(apisProvider).trips.cancel(t.id, reason!, idempotencyKey: _cancelKey!));
  }

  Future<void> _navigate(TripPlace p) async {
    final geo = Uri.parse('geo:${p.lat},${p.lng}?q=${p.lat},${p.lng}');
    if (await canLaunchUrl(geo)) {
      await launchUrl(geo);
    } else {
      await launchUrl(Uri.parse('https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}'), mode: LaunchMode.externalApplication);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final tripAsync = ref.watch(tripProvider(widget.tripId));
    final t = tripAsync.value;
    if (t == null) {
      return Scaffold(appBar: AppBar(), body: tripAsync.hasError ? Padding(padding: const EdgeInsets.all(16), child: Problem(tripAsync.error, describe: (e) => describeError(l, e))) : const Center(child: CircularProgressIndicator()));
    }
    final stage = driverStageOf(t);
    final parties = ref.watch(tripPartiesProvider(t.id)).value;
    final me = ref.watch(lastPositionProvider);
    final pinOn = ref.watch(featureProvider(Feature.tripPin));
    final sosOn = ref.watch(featureProvider(Feature.sos));
    final pickup = LatLng(t.pickup.lat, t.pickup.lng);
    final dropoff = LatLng(t.dropoff.lat, t.dropoff.lng);
    final mePt = me == null ? null : LatLng(me.lat, me.lng);
    final toPickup = stage == DriverStage.accepted || stage == DriverStage.toPickup;
    final target = stage == DriverStage.inTrip ? t.dropoff : t.pickup;
    if (Env.fakeLocationOn) {
      WidgetsBinding.instance.addPostFrameCallback((_) => ref.read(devDriveTargetProvider.notifier).set((target.lat, target.lng)));
    }
    final metersToPickup = me == null ? null : metersBetween(me, t.pickup.lat, t.pickup.lng);
    final waiting = waitingAtPickup(t, _now);
    final noShowAfter = const Duration(minutes: 5);

    return Scaffold(
      body: Stack(
        children: [
          AnbessaMap(
            fit: [?mePt, toPickup ? pickup : dropoff],
            pickup: pickup,
            dropoff: dropoff,
            driver: mePt == null ? null : DriverMarkerData(position: mePt, heading: me!.heading, stale: false),
            line: mePt == null ? [pickup, dropoff] : [mePt, toPickup ? pickup : dropoff],
            padding: const EdgeInsets.fromLTRB(48, 100, 48, 320),
          ),
          SafeArea(
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: Row(
                    children: [
                      if (!t.isActive) IconButton.filledTonal(onPressed: () => context.go(Routes.driverHome), icon: const Icon(Icons.arrow_back)),
                      if (sosOn && t.isActive)
                        FilledButton.icon(
                          style: FilledButton.styleFrom(backgroundColor: c.danger),
                          onPressed: () => context.push('${Routes.sos}?trip=${t.id}'),
                          icon: const Icon(Icons.sos),
                          label: Text(l.sos),
                        ),
                      const Spacer(),
                      if (t.isActive) FilledButton.tonalIcon(onPressed: () => _navigate(target), icon: const Icon(Icons.navigation_outlined), label: Text(l.navigate)),
                    ],
                  ),
                ),
                if (Env.fakeLocationOn) const Padding(padding: EdgeInsets.symmetric(horizontal: 12), child: DevLocationPanel()),
              ],
            ),
          ),
          Align(
            alignment: Alignment.bottomCenter,
            child: Container(
              width: double.infinity,
              decoration: BoxDecoration(color: c.surface, borderRadius: const BorderRadius.vertical(top: Radius.circular(18)), boxShadow: const [BoxShadow(color: Color(0x22000000), blurRadius: 16, offset: Offset(0, -2))]),
              child: SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        children: [
                          StatusPill(tripStatusLabel(l, t.status), tone: t.status == TripStatus.inProgress ? Tone.green : t.status == TripStatus.cancelled ? Tone.red : t.status == TripStatus.completed ? Tone.grey : Tone.blue),
                          const Spacer(),
                          MoneyText(t.fare.chargedMinor, locale: context.localeTag, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
                        ],
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          CircleAvatar(backgroundColor: c.accentSoft, foregroundColor: c.accentStrong, child: const Icon(Icons.person)),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(parties?.riderName ?? l.riderLabel, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                                Text(toPickup ? (t.pickup.address ?? l.pickupLabel) : (t.dropoff.address ?? l.dropoffLabel), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: c.text2)),
                              ],
                            ),
                          ),
                          StatusPill(paymentMethodLabel(l, t.paymentMethod), tone: t.paymentMethod == PaymentMethod.cash ? Tone.amber : Tone.blue),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Problem(_error, describe: (e) => describeError(l, e)),
                      if (_error != null) const SizedBox(height: 8),
                      ...switch (stage) {
                        DriverStage.accepted => [
                            PrimaryButton(label: l.onMyWay, icon: Icons.near_me, busy: _busy, onPressed: () => _do(() => ref.read(apisProvider).trips.enRoute(t.id))),
                            TextButton(onPressed: _busy ? null : () => _cancel(t), child: Text(l.cancelTrip)),
                          ],
                        DriverStage.toPickup => [
                            if (metersToPickup != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text('${metersToPickup.round()} m · ${l.toPickup}', style: TextStyle(color: c.muted))),
                            PrimaryButton(label: l.arrived, icon: Icons.place, busy: _busy, onPressed: () => _do(() => ref.read(apisProvider).trips.arrive(t.id))),
                            TextButton(onPressed: _busy ? null : () => _cancel(t), child: Text(l.cancelTrip)),
                          ],
                        DriverStage.waitingAtPickup => [
                            Row(
                              children: [
                                Icon(Icons.timer_outlined, color: waiting > const Duration(minutes: 3) ? c.warning : c.muted),
                                const SizedBox(width: 6),
                                Text(l.waitingFor(mmss(waiting)), style: const TextStyle(fontWeight: FontWeight.w600)),
                                const Spacer(),
                                Text(l.freeWaiting('3:00'), style: TextStyle(color: c.muted, fontSize: 12)),
                              ],
                            ),
                            const SizedBox(height: 10),
                            PrimaryButton(label: l.startTrip, icon: Icons.play_arrow, busy: _busy, onPressed: () => _start(t, pinOn)),
                            TextButton(
                              onPressed: _busy || waiting < noShowAfter ? null : () => _cancel(t, noShow: true),
                              child: Text(waiting < noShowAfter ? l.noShowAfter(5) : l.noShow),
                            ),
                          ],
                        DriverStage.inTrip => [
                            PrimaryButton(
                              label: l.completeTrip,
                              icon: Icons.flag,
                              busy: _busy,
                              onPressed: () {
                                _completeKey ??= newIdempotencyKey();
                                _do(() => ref.read(apisProvider).trips.complete(t.id, idempotencyKey: _completeKey!));
                              },
                            ),
                          ],
                        DriverStage.completed => [
                            Notice(
                              t.paymentMethod == PaymentMethod.cash ? l.collectCash(birr(t.fare.chargedMinor, locale: context.localeTag)) : t.paymentMethod == PaymentMethod.corporate ? l.paidByCompany : l.paidDigitally,
                              tone: t.paymentMethod == PaymentMethod.cash ? NoticeTone.warning : NoticeTone.ok,
                            ),
                            const SizedBox(height: 10),
                            PrimaryButton(label: l.rateRider, icon: Icons.star_outline, onPressed: () => context.go('${Routes.driverTrip(t.id)}/rate')),
                            TextButton(
                              onPressed: () {
                                ref.read(activeTripProvider.notifier).clearIfEnded();
                                context.go(Routes.driverHome);
                              },
                              child: Text(l.backToDriving),
                            ),
                          ],
                        DriverStage.cancelled => [
                            Text(l.cancelledBy(t.cancellation?.by.name ?? ''), style: TextStyle(color: c.text2)),
                            if ((t.cancellation?.driverCompensationMinor ?? 0) > 0) Text('+ ${birr(t.cancellation!.driverCompensationMinor, locale: context.localeTag)}', style: TextStyle(color: c.success, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 10),
                            PrimaryButton(
                              label: l.backToDriving,
                              onPressed: () {
                                ref.read(activeTripProvider.notifier).clearIfEnded();
                                context.go(Routes.driverHome);
                              },
                            ),
                          ],
                        DriverStage.unknown => [Text(tripStatusLabel(l, t.status))],
                      },
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _PinDialog extends StatefulWidget {
  const _PinDialog();
  @override
  State<_PinDialog> createState() => _PinDialogState();
}

class _PinDialogState extends State<_PinDialog> {
  final _c = TextEditingController();
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    return AlertDialog(
      title: Text(l.enterPin),
      content: TextField(
        controller: _c,
        autofocus: true,
        keyboardType: TextInputType.number,
        inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(4)],
        style: const TextStyle(fontSize: 28, letterSpacing: 10, fontFamilyFallback: monoFamilyFallback),
        textAlign: TextAlign.center,
        decoration: InputDecoration(hintText: l.pinHint),
        onSubmitted: (v) => v.length == 4 ? Navigator.pop(context, v) : null,
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: Text(l.cancel)),
        FilledButton(onPressed: () => _c.text.length == 4 ? Navigator.pop(context, _c.text) : null, child: Text(l.startTrip)),
      ],
    );
  }
}
