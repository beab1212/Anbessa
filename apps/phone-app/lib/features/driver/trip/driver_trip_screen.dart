// The driver's trip (workflow 06, 07, 08 B): the road to the pickup with the next turn on top,
// the map turning the way the car goes, slide to confirm each step: on my way → arrived (within
// 150 m) → waiting (free time, then per minute; no-show after 5 min) → start (PIN when the city
// requires it) → complete ("Collect X ETB cash" or paid digitally) → rate the rider.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import '../../../core/config/env.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/location/location_source.dart';
import '../../../core/network/providers.dart';
import '../../../core/router/routes.dart';
import '../../../core/ux/haptics.dart' show hapticsSettingsProvider;
import '../../config/client_config_provider.dart';
import '../../flagged/flagged_modules.dart';
import '../../maps/anbessa_map.dart';
import '../../maps/nav/external_nav.dart';
import '../../maps/nav/navigation_controller.dart';
import '../../maps/nav/turn_banner.dart';
import '../../profile/settings_controllers.dart';
import '../../rider/trip/active_trip_controller.dart';
import '../../rider/trip/cancel_sheet.dart';
import '../shift/driver_home_screen.dart';

class DriverTripScreen extends ConsumerStatefulWidget {
  const DriverTripScreen({super.key, required this.tripId});
  final String tripId;
  @override
  ConsumerState<DriverTripScreen> createState() => _DriverTripScreenState();
}

class _DriverTripScreenState extends ConsumerState<DriverTripScreen> with SingleTickerProviderStateMixin {
  Timer? _tick;
  DateTime _now = DateTime.now().toUtc();
  bool _busy = false;
  Object? _error;
  String? _completeKey;
  String? _cancelKey;
  // the sheet height goes straight to the map (no rebuild of this screen while it's dragged)
  final _sheetHeight = ValueNotifier<double>(0);
  // the driver's own car, glided between fixes along the guidance route
  late final MarkerAnimator _car = MarkerAnimator(vsync: this);
  bool _overview = false;
  bool _devOpen = false;
  NavTarget? _navTarget;
  DriverStage? _lastStage;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() => _now = DateTime.now().toUtc()));
    if (ref.read(navPrefsProvider).keepAwake) WakelockPlus.enable().catchError((_) {});
    ref.listenManual(lastPositionProvider, (_, p) {
      if (p != null) _car.push((lat: p.lat, lng: p.lng), heading: p.heading, speed: p.speed, at: p.at);
    }, fireImmediately: true);
  }

  @override
  void dispose() {
    _tick?.cancel();
    _car.dispose();
    _sheetHeight.dispose();
    WakelockPlus.disable().catchError((_) {});
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
      Haptics.success();
    } catch (e) {
      Haptics.error();
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _start(Trip t, bool pinOn) async {
    String? pin;
    if (pinOn) {
      pin = await showModalBottomSheet<String>(context: context, isScrollControlled: true, builder: (ctx) => const _PinSheet());
      if (pin == null) return;
    }
    await _do(() => ref.read(apisProvider).trips.start(t.id, pin: pin));
  }

  Future<void> _cancel(Trip t, {bool noShow = false}) async {
    var reason = noShow ? CancelReason.noShow : null;
    reason ??= await showCancelSheet(context, free: true, feeMinor: 0, driverSide: true);
    if (reason == null) return;
    _cancelKey ??= newIdempotencyKey();
    await _do(() => ref.read(apisProvider).trips.cancel(t.id, reason!, idempotencyKey: _cancelKey!));
  }

  Future<void> _directions(TripPlace p) async {
    final prefs = ref.read(navPrefsProvider);
    var app = prefs.app;
    if (prefs.ask) {
      final l = context.l10n;
      final picked = await showModalBottomSheet<NavApp>(
        context: context,
        builder: (ctx) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(padding: const EdgeInsets.fromLTRB(20, 4, 20, 8), child: Align(alignment: Alignment.centerLeft, child: Text(l.navOpenIn, style: AnbessaType.h2))),
              ListTile(title: Text(l.navGoogleMaps), onTap: () => Navigator.pop(ctx, NavApp.google)),
              ListTile(title: Text(l.navWaze), onTap: () => Navigator.pop(ctx, NavApp.waze)),
              ListTile(title: Text(l.navSystemMaps), onTap: () => Navigator.pop(ctx, NavApp.system)),
              const SizedBox(height: 8),
            ],
          ),
        ),
      );
      if (picked == null) return;
      app = picked;
    }
    await openExternalNavigation(p.lat, p.lng, app: app, label: p.address);
  }

  void _onStage(DriverStage stage) {
    if (_lastStage == stage) return;
    final first = _lastStage == null;
    _lastStage = stage;
    if (first) return;
    if (stage == DriverStage.cancelled) {
      Haptics.error();
      showToast(context, context.l10n.tripCancelled, tone: NoticeTone.warning);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    // dispatch moved this trip to another driver: leave it
    ref.listen(tripReassignedProvider, (_, e) {
      if (e == null || e.tripId != widget.tripId) return;
      Haptics.error();
      showToast(context, l.tripReassigned, tone: NoticeTone.warning);
      ref.read(tripReassignedProvider.notifier).set(null);
      context.go(Routes.driverHome);
    });
    final tripAsync = ref.watch(tripProvider(widget.tripId));
    final t = tripAsync.value;
    if (t == null) {
      return Scaffold(appBar: AppBar(), body: tripAsync.hasError ? Padding(padding: const EdgeInsets.all(16), child: Problem(tripAsync.error, describe: (e) => describeError(l, e))) : const Padding(padding: EdgeInsets.all(16), child: SkeletonList(rows: 3)));
    }
    final stage = driverStageOf(t);
    WidgetsBinding.instance.addPostFrameCallback((_) => _onStage(stage));
    final parties = ref.watch(tripPartiesProvider(t.id)).value;
    final me = ref.watch(lastPositionProvider);
    final pinOn = ref.watch(featureProvider(Feature.tripPin));
    final sosOn = ref.watch(featureProvider(Feature.sos));
    final navPrefs = ref.watch(navPrefsProvider);
    ref.watch(hapticsSettingsProvider);
    final pickup = LatLng(t.pickup.lat, t.pickup.lng);
    final dropoff = LatLng(t.dropoff.lat, t.dropoff.lng);
    final toPickup = stage == DriverStage.accepted || stage == DriverStage.toPickup;
    final target = stage == DriverStage.inTrip ? t.dropoff : t.pickup;
    final navigating = t.isActive && stage != DriverStage.waitingAtPickup;
    if (Env.fakeLocationOn) {
      WidgetsBinding.instance.addPostFrameCallback((_) => ref.read(devDriveTargetProvider.notifier).set((target.lat, target.lng)));
    }
    // in-app guidance to the target
    final navTarget = NavTarget(lat: target.lat, lng: target.lng, label: target.address);
    NavState? nav;
    if (navigating && me != null) {
      if (_navTarget != navTarget) {
        _navTarget = navTarget;
        WidgetsBinding.instance.addPostFrameCallback((_) => ref.read(navigationProvider(navTarget).notifier).start((lat: me.lat, lng: me.lng)));
      } else {
        WidgetsBinding.instance.addPostFrameCallback((_) => ref.read(navigationProvider(navTarget).notifier).update((lat: me.lat, lng: me.lng), speed: me.speed));
      }
      nav = ref.watch(navigationProvider(navTarget));
    }
    // the car moves along the guidance route (no corner cutting, no jumping to a side street)
    _car.route = nav != null && nav.hasRoute ? nav.route : null;
    final metersToPickup = me == null ? null : metersBetween(me, t.pickup.lat, t.pickup.lng);
    final waiting = waitingAtPickup(t, _now);
    const noShowAfter = Duration(minutes: 5);
    const freeWaiting = Duration(minutes: 3);
    final top = MediaQuery.paddingOf(context).top;
    final follow = navigating && !_overview && me != null ? (navPrefs.bearing ? FollowMode.driverBearing : FollowMode.driver) : FollowMode.none;
    final routes = <RouteLine>[
      if (nav != null && nav.hasRoute) ...[
        RouteLine(nav.traversed.map((p) => LatLng(p.lat, p.lng)).toList(), kind: RouteKind.traversed),
        RouteLine(nav.remaining.map((p) => LatLng(p.lat, p.lng)).toList()),
      ] else if (me != null && t.isActive)
        RouteLine.straight(LatLng(me.lat, me.lng), toPickup ? pickup : dropoff),
      if (toPickup || !t.isActive) RouteLine.fromPolyline6(t.route.polyline, kind: RouteKind.secondary),
    ];

    return Scaffold(
      body: Stack(
        children: [
          AnbessaMap(
            fit: follow == FollowMode.none ? [if (me != null) LatLng(me.lat, me.lng), toPickup ? pickup : dropoff, if (!t.isActive) pickup] : const [],
            // the overview is fitted when it is chosen or the stage changes, not on every fix
            fitKey: (_overview, stage),
            pickup: pickup,
            dropoff: dropoff,
            driverCar: _car,
            routes: routes,
            follow: follow,
            followZoom: 17,
            // a gesture frees the camera (the map shows "Recenter"); recenter goes back to guidance
            onRecenter: () {
              if (_overview) setState(() => _overview = false);
            },
            topInset: top + (navigating ? 120 : 64),
            sheetHeight: _sheetHeight,
            callouts: [
              if (nav != null && nav.remainingSeconds != null && navigating) MapCallout(point: toPickup ? pickup : dropoff, label: l.etaMinutes((nav.remainingSeconds! / 60).ceil().clamp(1, 999)), tone: Tone.amber, icon: Icons.schedule, offsetY: -56),
            ],
          ),
          Positioned(
            top: top + 8,
            left: 12,
            right: 12,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (navigating && nav != null)
                  TurnBanner(
                    nav: nav,
                    targetLabel: toPickup ? (t.pickup.address ?? l.pickupLabel) : (t.dropoff.address ?? l.dropoffLabel),
                    onTap: nav.steps.isEmpty ? null : () => showModalBottomSheet(context: context, builder: (_) => TurnListSheet(nav: nav!, targetLabel: toPickup ? (t.pickup.address ?? l.pickupLabel) : (t.dropoff.address ?? l.dropoffLabel))),
                  ),
                const SizedBox(height: 8),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (!t.isActive) MapControlButton(icon: Icons.arrow_back, tooltip: l.back, onTap: () => context.go(Routes.driverHome)),
                    if (sosOn && sosAvailable(t, DateTime.now())) MapControlButton(icon: Icons.sos, tooltip: l.sos, active: true, onTap: () => context.push('${Routes.sos}?trip=${t.id}')),
                    if (Env.fakeLocationOn) ...[const SizedBox(width: 8), MapChip(icon: Icons.bug_report_outlined, label: l.devTools, onTap: () => setState(() => _devOpen = !_devOpen))],
                    const SizedBox(width: 8),
                    // the chips wrap onto a second line at large text sizes
                    Expanded(
                      child: Wrap(
                        alignment: WrapAlignment.end,
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          if (navigating) ...[
                            MapChip(icon: _overview ? Icons.navigation : Icons.map_outlined, label: _overview ? l.navFollowMode : l.navOverviewMode, onTap: () => setState(() => _overview = !_overview)),
                            MapChip(icon: Icons.directions, label: l.openDirections, onTap: () => _directions(target)),
                          ],
                        ],
                      ),
                    ),
                  ],
                ),
                if (_devOpen && Env.fakeLocationOn) const Padding(padding: EdgeInsets.only(top: 8), child: DevLocationPanel()),
              ],
            ),
          ),
          AppSheet(
            snaps: const [0.34, 0.74],
            onHeightChanged: (h) => _sheetHeight.value = h,
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
            builder: (context, _) => AnimatedSwitcherX(
              child: KeyedSubtree(
                key: ValueKey(stage),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // the rider and the target
                    Row(
                      children: [
                        AvatarImage(src: parties?.riderPhoto, name: parties?.riderName ?? l.riderLabel, size: 48),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(parties?.riderName ?? l.riderLabel, style: AnbessaType.title.copyWith(color: c.text), maxLines: 1, overflow: TextOverflow.ellipsis),
                              Text(toPickup ? (t.pickup.address ?? l.pickupLabel) : (t.dropoff.address ?? l.dropoffLabel), maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.caption.copyWith(color: c.text2)),
                            ],
                          ),
                        ),
                        if (kMaskedCallsEnabled) IconButton.filledTonal(onPressed: () {}, icon: const Icon(Icons.call_outlined), tooltip: l.contact),
                        const SizedBox(width: 4),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            MoneyText(t.fare.chargedMinor, locale: context.localeTag, style: AnbessaType.h2.copyWith(color: c.text)),
                            StatusPill(paymentMethodLabel(l, t.paymentMethod), tone: t.paymentMethod == PaymentMethod.cash ? Tone.amber : Tone.blue),
                          ],
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    Problem(_error, describe: (e) => describeError(l, e)),
                    if (_error != null) const SizedBox(height: 8),
                    ...switch (stage) {
                      DriverStage.accepted => [
                          SwipeToConfirm(label: l.slideOnMyWay, icon: Icons.near_me, busy: _busy, onConfirmed: () => _do(() => ref.read(apisProvider).trips.enRoute(t.id))),
                          TextButton(onPressed: _busy ? null : () => _cancel(t), child: Text(l.cancelTripDriver)),
                        ],
                      DriverStage.toPickup => [
                          if (metersToPickup != null)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 10),
                              child: Text(l.toPickupDistance(km(metersToPickup.round())), style: AnbessaType.body2.copyWith(color: metersToPickup <= 150 ? c.success : c.text2, fontWeight: FontWeight.w600)),
                            ),
                          SwipeToConfirm(label: l.slideArrived, icon: Icons.place, tone: metersToPickup != null && metersToPickup <= 300 ? Tone.green : Tone.amber, busy: _busy, onConfirmed: () => _do(() => ref.read(apisProvider).trips.arrive(t.id))),
                          TextButton(onPressed: _busy ? null : () => _cancel(t), child: Text(l.cancelTripDriver)),
                        ],
                      DriverStage.waitingAtPickup => [
                          Row(
                            children: [
                              CountdownRing(remaining: waiting > freeWaiting ? Duration.zero : freeWaiting - waiting, total: freeWaiting, size: 56, strokeWidth: 4, child: const SizedBox.shrink()),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(l.waitingFor(mmss(waiting)), style: AnbessaType.title.copyWith(color: c.text, fontFeatures: AnbessaType.tabular)),
                                    Text(waiting > freeWaiting ? l.riderIsWaiting : l.freeUntil('3:00'), style: AnbessaType.caption.copyWith(color: c.muted)),
                                  ],
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 14),
                          SwipeToConfirm(label: l.slideStart, icon: Icons.play_arrow_rounded, busy: _busy, onConfirmed: () => _start(t, pinOn)),
                          TextButton(
                            onPressed: _busy || waiting < noShowAfter ? null : () => _cancel(t, noShow: true),
                            child: Text(waiting < noShowAfter ? l.noShowIn(mmss(noShowAfter - waiting)) : l.noShow),
                          ),
                        ],
                      DriverStage.inTrip => [
                          SwipeToConfirm(
                            label: l.slideComplete,
                            icon: Icons.flag_rounded,
                            tone: Tone.green,
                            busy: _busy,
                            onConfirmed: () {
                              _completeKey ??= newIdempotencyKey();
                              return _do(() => ref.read(apisProvider).trips.complete(t.id, idempotencyKey: _completeKey!));
                            },
                          ),
                        ],
                      DriverStage.completed => [
                          Container(
                            padding: const EdgeInsets.all(16),
                            decoration: BoxDecoration(color: t.paymentMethod == PaymentMethod.cash ? c.warningSoft : c.successSoft, borderRadius: BorderRadius.circular(AnbessaRadius.lg)),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(t.paymentMethod == PaymentMethod.cash ? l.collectCashTitle : t.paymentMethod == PaymentMethod.corporate ? l.companyPays : l.riderPaysDigital, style: AnbessaType.label.copyWith(color: t.paymentMethod == PaymentMethod.cash ? c.warning : c.success)),
                                const SizedBox(height: 4),
                                AnimatedMoney(t.fare.chargedMinor, locale: context.localeTag, style: AnbessaType.display.copyWith(color: c.text)),
                                if (t.paymentMethod == PaymentMethod.cash) Text(l.collectCash(birr(t.fare.payableMinor, locale: context.localeTag)), style: AnbessaType.body2.copyWith(color: c.text2)),
                              ],
                            ),
                          ),
                          const SizedBox(height: 12),
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
                          Notice(l.cancelledBy(t.cancellation?.by.name ?? ''), tone: NoticeTone.warning),
                          if ((t.cancellation?.driverCompensationMinor ?? 0) > 0)
                            Padding(padding: const EdgeInsets.only(top: 8), child: Text('${l.youEarn} +${birr(t.cancellation!.driverCompensationMinor, locale: context.localeTag)}', style: AnbessaType.body.copyWith(color: c.success, fontWeight: FontWeight.w600))),
                          const SizedBox(height: 12),
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
        ],
      ),
    );
  }
}

class _PinSheet extends StatefulWidget {
  const _PinSheet();
  @override
  State<_PinSheet> createState() => _PinSheetState();
}

class _PinSheetState extends State<_PinSheet> {
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(l.pinSheetTitle, style: AnbessaType.h2.copyWith(color: c.text)),
              const SizedBox(height: 4),
              Text(l.pinSheetLede, style: AnbessaType.body2.copyWith(color: c.text2)),
              const SizedBox(height: 20),
              Center(child: PinBoxes(length: 4, size: 60, onCompleted: (v) => Navigator.pop(context, v))),
              const SizedBox(height: 16),
              TextButton(onPressed: () => Navigator.pop(context), child: Text(l.cancel)),
            ],
          ),
        ),
      ),
    );
  }
}
