// The driver's trip (workflow 06, 07, 08 B): turn-by-turn guidance to the pickup and then the
// drop-off, slide to confirm each step: on my way → arrived (within 150 m) → waiting (free time,
// then per minute; no-show after 5 min) → start (PIN when the city requires it) → complete
// ("Collect X ETB cash" or paid digitally) → rate the rider.
//
// What moves never rebuilds the screen:
//   - guidance runs from the location stream (NavigationController listens to it); the screen
//     listens to the state and feeds the car animator the position matched to the route
//   - the car glides along the route (MarkerAnimator); the camera drives with it (navigate mode)
//     and a gesture frees it (the map shows "Recenter")
//   - the driven / remaining split follows the animated car, and only the map rebuilds for it
//   - the banner, the summary and the waiting timer are small widgets of their own

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
import '../../config/client_config_provider.dart';
import '../../flagged/flagged_modules.dart';
import '../../maps/anbessa_map.dart';
import '../../maps/nav/external_nav.dart';
import '../../maps/nav/navigation_controller.dart';
import '../../maps/nav/turn_banner.dart';
import '../../maps/nav/voice_guide.dart';
import '../../maps/scene/route_track.dart';
import '../../profile/settings_controllers.dart';
import '../../rider/trip/active_trip_controller.dart';
import '../../rider/trip/cancel_sheet.dart';
import '../shift/driver_home_screen.dart';

const _noShowAfter = Duration(minutes: 5);
const _freeWaiting = Duration(minutes: 3);

class DriverTripScreen extends ConsumerStatefulWidget {
  const DriverTripScreen({super.key, required this.tripId});
  final String tripId;
  /// How many times the screen has built (debug builds only; tests check there is no loop).
  @visibleForTesting
  static int debugBuilds = 0;
  @override
  ConsumerState<DriverTripScreen> createState() => _DriverTripScreenState();
}

class _DriverTripScreenState extends ConsumerState<DriverTripScreen> with SingleTickerProviderStateMixin {
  bool _busy = false;
  Object? _error;
  String? _completeKey;
  String? _cancelKey;
  // the sheet height goes straight to the map (no rebuild of this screen while it's dragged)
  final _sheetHeight = ValueNotifier<double>(0);
  // the driver's own car, glided along the guidance route
  late final MarkerAnimator _car = MarkerAnimator(vsync: this);
  // bumps when the map's lines or labels change (a new route, the car moving along it)
  final _mapTick = ValueNotifier<int>(0);
  bool _overview = false;
  bool _devOpen = false;
  bool _hasFix = false;
  // guidance
  NavTarget? _navTarget;
  RouteTrack? _track;
  int _routeVersion = -1;
  int _fixSeq = -1;
  double? _split;
  int? _etaMinutes;
  bool _arrived = false;
  late final VoiceGuide _voice;
  bool _voiceReady = false;

  @override
  void initState() {
    super.initState();
    if (ref.read(navPrefsProvider).keepAwake) WakelockPlus.enable().catchError((_) {});
    _voice = VoiceGuide(tts: ref.read(ttsEngineProvider), strings: lookupAppLocalizations(const Locale('en')), isMuted: () => !ref.read(navVoiceProvider));
    _car.addListener(_onCarMoved);
    // without guidance (waiting at the pickup, a finished trip) the car follows the raw fixes
    ref.listenManual(lastPositionProvider, (_, p) {
      if (p == null) return;
      if (!_hasFix) setState(() => _hasFix = true);
      if (_navTarget == null) _car.push((lat: p.lat, lng: p.lng), heading: p.heading, speed: p.speed, at: p.at);
    }, fireImmediately: true);
    ref.listenManual(navVoiceProvider, (_, on) {
      if (!on) _voice.silence();
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_voiceReady) {
      _voiceReady = true;
      _voice.init(Localizations.localeOf(context));
    }
  }

  @override
  void dispose() {
    _voice.dispose();
    _car.removeListener(_onCarMoved);
    _car.dispose();
    _sheetHeight.dispose();
    _mapTick.dispose();
    WakelockPlus.disable().catchError((_) {});
    super.dispose();
  }

  // ── guidance ────────────────────────────────────────────────────────────────

  /// The target changed (pickup → drop-off, or guidance ended): start over.
  void _setTarget(NavTarget? t, {required bool toPickup}) {
    if (t == _navTarget) return;
    _navTarget = t;
    _track = null;
    _routeVersion = -1;
    _fixSeq = -1;
    _split = null;
    _etaMinutes = null;
    _arrived = false;
    _car.route = null;
    _voice.setTarget(t, toPickup: toPickup);
    if (t != null && Env.fakeLocationOn) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) ref.read(devDriveTargetProvider.notifier).set((t.lat, t.lng));
      });
    }
  }

  void _onNav(NavState? _, NavState s) {
    if (!mounted) return;
    var mapChanged = false;
    if (s.routeVersion != _routeVersion) {
      _routeVersion = s.routeVersion;
      _track = s.hasRoute ? s.track : null;
      _split = null;
      // the car moves along the guidance route (no corner cutting, no jumping to a side street)
      _car.route = _track?.points;
      mapChanged = true;
    }
    if (s.fixSeq != _fixSeq && s.snapped != null) {
      _fixSeq = s.fixSeq;
      final p = ref.read(lastPositionProvider);
      _car.push(s.snapped!, heading: s.bearing ?? p?.heading, speed: p?.speed, at: p?.at);
    }
    final eta = s.remainingSeconds == null ? null : (s.remainingSeconds! / 60).ceil().clamp(1, 999);
    if (eta != _etaMinutes) {
      _etaMinutes = eta;
      mapChanged = true;
    }
    if (s.arrived && !_arrived) {
      _arrived = true;
      Haptics.success();
    }
    _voice.onState(s, speed: ref.read(lastPositionProvider)?.speed ?? 0);
    if (mapChanged) _mapTick.value++;
  }

  /// The animated car moved: move the driven / remaining split with it (every few metres).
  void _onCarMoved() {
    final t = _track, pose = _car.value;
    if (t == null || pose == null) return;
    final last = _split;
    final pr = last == null ? t.project(pose.point) : t.project(pose.point, from: last - 5, to: last + 400);
    if (pr.offMeters > 40) return;
    final along = last == null ? pr.alongMeters : (pr.alongMeters > last ? pr.alongMeters : last);
    if (last != null && along - last < 3) return;
    _split = along;
    _mapTick.value++;
  }

  // ── actions ─────────────────────────────────────────────────────────────────

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
      if (mounted) setState(() => _error = e);
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
              ListTile(leading: const Icon(Icons.map_rounded), title: Text(l.navGoogleMaps), onTap: () => Navigator.pop(ctx, NavApp.google)),
              ListTile(leading: const Icon(Icons.directions_rounded), title: Text(l.navWaze), onTap: () => Navigator.pop(ctx, NavApp.waze)),
              ListTile(leading: const Icon(Icons.navigation_rounded), title: Text(l.navSystemMaps), onTap: () => Navigator.pop(ctx, NavApp.system)),
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

  void _showTurns(NavTarget target, String label) => showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        isScrollControlled: true,
        builder: (_) => ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.7),
          child: Consumer(builder: (_, ref, _) => TurnListSheet(nav: ref.watch(navigationProvider(target)), targetLabel: label)),
        ),
      );

  // ── build ───────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    assert(() {
      DriverTripScreen.debugBuilds++;
      return true;
    }());
    final l = context.l10n;
    // dispatch moved this trip to another driver: leave it
    ref.listen(tripReassignedProvider, (_, e) {
      if (e == null || e.tripId != widget.tripId) return;
      Haptics.error();
      showToast(context, l.tripReassigned, tone: NoticeTone.warning);
      ref.read(tripReassignedProvider.notifier).set(null);
      context.go(Routes.driverHome);
    });
    ref.listen(tripProvider(widget.tripId), (prev, next) {
      final a = prev?.value, b = next.value;
      if (a == null || b == null) return;
      if (driverStageOf(a) != DriverStage.cancelled && driverStageOf(b) == DriverStage.cancelled) {
        Haptics.error();
        showToast(context, l.tripCancelled, tone: NoticeTone.warning);
      }
    });
    final tripAsync = ref.watch(tripProvider(widget.tripId));
    final t = tripAsync.value;
    if (t == null) {
      return Scaffold(appBar: AppBar(), body: tripAsync.hasError ? Padding(padding: const EdgeInsets.all(16), child: Problem(tripAsync.error, describe: (e) => describeError(l, e))) : const Padding(padding: EdgeInsets.all(16), child: SkeletonList(rows: 3)));
    }
    final stage = driverStageOf(t);
    final sosOn = ref.watch(featureProvider(Feature.sos));
    final bearingPref = ref.watch(navPrefsProvider.select((p) => p.bearing));
    final voiceOn = ref.watch(navVoiceProvider);
    final toPickup = stage == DriverStage.accepted || stage == DriverStage.toPickup;
    final target = stage == DriverStage.inTrip ? t.dropoff : t.pickup;
    final targetLabel = toPickup ? (t.pickup.address ?? l.pickupLabel) : (t.dropoff.address ?? l.dropoffLabel);
    final navigating = t.isActive && stage != DriverStage.waitingAtPickup;
    final navTarget = navigating ? NavTarget(lat: target.lat, lng: target.lng, label: target.address) : null;
    _setTarget(navTarget, toPickup: toPickup);
    // guidance state goes to the car, the voice and the map, not to this build
    if (navTarget != null) ref.listen<NavState>(navigationProvider(navTarget), _onNav);

    final top = MediaQuery.paddingOf(context).top;
    final follow = navigating && !_overview && _hasFix ? (bearingPref ? FollowMode.driverBearing : FollowMode.driver) : FollowMode.none;
    final pickup = LatLng(t.pickup.lat, t.pickup.lng);
    final dropoff = LatLng(t.dropoff.lat, t.dropoff.lng);

    return Scaffold(
      body: Stack(
        children: [
          // only the map rebuilds when the car moves along the route
          ValueListenableBuilder<int>(
            valueListenable: _mapTick,
            builder: (context, _, _) {
              final car = _car.value;
              final track = _track;
              final routes = <RouteLine>[
                if (navigating && track != null) ...[
                  if (_split != null) RouteLine(_traversed(track, _split!), kind: RouteKind.traversed),
                  RouteLine(_remaining(track, _split)),
                ] else if (navigating && car != null)
                  RouteLine.straight(LatLng(car.lat, car.lng), toPickup ? pickup : dropoff),
                if (toPickup || !t.isActive) RouteLine.fromPolyline6(t.route.polyline, kind: RouteKind.secondary),
              ];
              return AnbessaMap(
                fit: follow == FollowMode.none ? [if (car != null) LatLng(car.lat, car.lng), toPickup ? pickup : dropoff, if (!t.isActive) pickup] : const [],
                // the overview is fitted when it is chosen or the stage changes, not on every fix
                fitKey: (_overview, stage),
                pickup: pickup,
                dropoff: dropoff,
                driverCar: _car,
                routes: routes,
                follow: follow,
                followZoom: 17,
                onRecenter: () {
                  if (_overview) setState(() => _overview = false);
                },
                topInset: top + (navigating ? 150 : 64),
                sheetHeight: _sheetHeight,
                callouts: [
                  if (navigating && _etaMinutes != null) MapCallout(point: toPickup ? pickup : dropoff, label: l.etaMinutes(_etaMinutes!), tone: Tone.amber, icon: Icons.schedule, offsetY: -56),
                ],
              );
            },
          ),
          Positioned(
            top: top + 8,
            left: 12,
            right: 12,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (navTarget != null)
                  Consumer(builder: (context, ref, _) {
                    final nav = ref.watch(navigationProvider(navTarget));
                    return TurnBanner(nav: nav, targetLabel: targetLabel, onTap: nav.steps.isEmpty ? null : () => _showTurns(navTarget, targetLabel));
                  }),
                const SizedBox(height: 8),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (!t.isActive) ...[RoundIconButton(icon: Icons.arrow_back_rounded, tooltip: l.back, onTap: () => context.go(Routes.driverHome)), const SizedBox(width: 8)],
                    if (sosOn && sosAvailable(t, DateTime.now())) ...[RoundIconButton(icon: Icons.sos_rounded, tooltip: l.sos, danger: true, onTap: () => context.push('${Routes.sos}?trip=${t.id}')), const SizedBox(width: 8)],
                    if (Env.fakeLocationOn) ...[MapChip(icon: Icons.bug_report_outlined, label: l.devTools, onTap: () => setState(() => _devOpen = !_devOpen)), const SizedBox(width: 8)],
                    // the chips wrap onto a second line at large text sizes
                    Expanded(
                      child: Wrap(
                        alignment: WrapAlignment.end,
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          if (navigating) ...[
                            MapChip(icon: _overview ? Icons.navigation_rounded : Icons.map_outlined, label: _overview ? l.navFollowMode : l.navOverviewMode, onTap: () => setState(() => _overview = !_overview)),
                            MapChip(icon: Icons.directions_rounded, label: l.openDirections, onTap: () => _directions(target)),
                          ],
                        ],
                      ),
                    ),
                    if (navigating) ...[
                      const SizedBox(width: 8),
                      RoundIconButton(
                        icon: voiceOn ? Icons.volume_up_rounded : Icons.volume_off_rounded,
                        tooltip: voiceOn ? l.navMute : l.navUnmute,
                        onTap: () {
                          Haptics.selection();
                          ref.read(navVoiceProvider.notifier).toggle();
                        },
                      ),
                    ],
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
                child: _sheet(context, t, stage, navTarget, toPickup),
              ),
            ),
          ),
        ],
      ),
    );
  }

  static List<LatLng> _traversed(RouteTrack t, double along) {
    final i = t.segmentAt(along);
    final p = t.pointAt(along);
    return [for (final q in t.points.take(i + 1)) LatLng(q.lat, q.lng), LatLng(p.lat, p.lng)];
  }

  static List<LatLng> _remaining(RouteTrack t, double? along) {
    if (along == null || along <= 0) return [for (final q in t.points) LatLng(q.lat, q.lng)];
    final i = t.segmentAt(along);
    final p = t.pointAt(along);
    return [LatLng(p.lat, p.lng), for (final q in t.points.skip(i + 1)) LatLng(q.lat, q.lng)];
  }

  Widget _sheet(BuildContext context, Trip t, DriverStage stage, NavTarget? navTarget, bool toPickup) {
    final l = context.l10n;
    final c = context.colors;
    final parties = ref.watch(tripPartiesProvider(t.id)).value;
    final pinOn = ref.watch(featureProvider(Feature.tripPin));
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _RiderCard(trip: t, parties: parties, toPickup: toPickup),
        if (navTarget != null) ...[
          const SizedBox(height: 12),
          _NavSheetSummary(target: navTarget, toPickup: toPickup),
        ],
        const SizedBox(height: 14),
        Problem(_error, describe: (e) => describeError(l, e)),
        if (_error != null) const SizedBox(height: 8),
        ...switch (stage) {
          DriverStage.accepted => [
              SwipeToConfirm(label: l.slideOnMyWay, icon: Icons.near_me_rounded, busy: _busy, onConfirmed: () => _do(() => ref.read(apisProvider).trips.enRoute(t.id))),
              TextButton(onPressed: _busy ? null : () => _cancel(t), child: Text(l.cancelTripDriver)),
            ],
          DriverStage.toPickup => [
              _PickupDistance(trip: t),
              SwipeToConfirm(label: l.slideArrived, icon: Icons.place_rounded, busy: _busy, onConfirmed: () => _do(() => ref.read(apisProvider).trips.arrive(t.id))),
              TextButton(onPressed: _busy ? null : () => _cancel(t), child: Text(l.cancelTripDriver)),
            ],
          DriverStage.waitingAtPickup => [
              _WaitingTimer(trip: t),
              const SizedBox(height: 14),
              SwipeToConfirm(label: l.slideStart, icon: Icons.play_arrow_rounded, busy: _busy, onConfirmed: () => _start(t, pinOn)),
              // enabled once the rider is 5 min late; only this button ticks
              TickingBuilder(
                builder: (context, now) {
                  final waiting = waitingAtPickup(t, now.toUtc());
                  return TextButton(
                    onPressed: _busy || waiting < _noShowAfter ? null : () => _cancel(t, noShow: true),
                    child: Text(waiting < _noShowAfter ? l.noShowIn(mmss(_noShowAfter - waiting)) : l.noShow),
                  );
                },
              ),
            ],
          DriverStage.inTrip => [
              SwipeToConfirm(
                label: l.slideComplete,
                icon: Icons.flag_rounded,
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
                child: Row(
                  children: [
                    Icon(t.paymentMethod == PaymentMethod.cash ? Icons.payments_rounded : Icons.verified_rounded, size: 32, color: t.paymentMethod == PaymentMethod.cash ? c.warning : c.success),
                    const SizedBox(width: 12),
                    Expanded(
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
                  ],
                ),
              ),
              const SizedBox(height: 12),
              PrimaryButton(label: l.rateRider, icon: Icons.star_rounded, onPressed: () => context.go('${Routes.driverTrip(t.id)}/rate')),
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
    );
  }
}

/// The rider, where to, the fare and how it's paid.
class _RiderCard extends StatelessWidget {
  const _RiderCard({required this.trip, required this.parties, required this.toPickup});
  final Trip trip;
  final TripParties? parties;
  final bool toPickup;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final t = trip;
    final cash = t.paymentMethod == PaymentMethod.cash;
    return Row(
      children: [
        AvatarImage(src: parties?.riderPhoto, name: parties?.riderName ?? l.riderLabel, size: 52),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(parties?.riderName ?? l.riderLabel, style: AnbessaType.title.copyWith(color: c.text), maxLines: 1, overflow: TextOverflow.ellipsis),
              const SizedBox(height: 2),
              Row(
                children: [
                  Icon(toPickup ? Icons.trip_origin_rounded : Icons.flag_rounded, size: 14, color: c.muted),
                  const SizedBox(width: 4),
                  Expanded(child: Text(toPickup ? (t.pickup.address ?? l.pickupLabel) : (t.dropoff.address ?? l.dropoffLabel), maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.caption.copyWith(color: c.text2))),
                ],
              ),
            ],
          ),
        ),
        // calls go through masked numbers only (off until the telephony provider is live)
        if (kMaskedCallsEnabled) ...[const SizedBox(width: 8), RoundIconButton(icon: Icons.call_rounded, tooltip: l.drvCallRider, onTap: () {})],
        const SizedBox(width: 10),
        // the fare never squeezes the rider's name away at large text sizes
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 128),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              FittedBox(fit: BoxFit.scaleDown, child: MoneyText(t.fare.chargedMinor, locale: context.localeTag, style: AnbessaType.h2.copyWith(color: c.text))),
              FittedBox(fit: BoxFit.scaleDown, child: StatusPill(paymentMethodLabel(l, t.paymentMethod), tone: cash ? Tone.amber : Tone.blue, icon: cash ? Icons.payments_outlined : Icons.phone_iphone_rounded)),
            ],
          ),
        ),
      ],
    );
  }
}

/// Time and distance left with the arrival clock; at the target, what to do next.
class _NavSheetSummary extends ConsumerWidget {
  const _NavSheetSummary({required this.target, required this.toPickup});
  final NavTarget target;
  final bool toPickup;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final nav = ref.watch(navigationProvider(target));
    if (nav.arrived) {
      return Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: c.successSoft, borderRadius: BorderRadius.circular(AnbessaRadius.md)),
        child: Row(
          children: [
            Icon(Icons.where_to_vote_rounded, color: c.success),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(l.navArrive, style: AnbessaType.title.copyWith(color: c.text)),
                  Text(toPickup ? l.drvArrivedHintPickup : l.drvArrivedHintDropoff, style: AnbessaType.caption.copyWith(color: c.text2)),
                ],
              ),
            ),
          ],
        ),
      );
    }
    if (nav.remainingSeconds == null) return const SizedBox.shrink();
    return NavSummaryBar(nav: nav);
  }
}

/// The straight-line distance to the pickup, green within 150 m (where "arrived" is accepted).
class _PickupDistance extends ConsumerWidget {
  const _PickupDistance({required this.trip});
  final Trip trip;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final l = context.l10n;
    // rounded to 10 m so a fix that barely moved doesn't rebuild it
    final tens = ref.watch(lastPositionProvider.select((p) => p == null ? null : (metersBetween(p, trip.pickup.lat, trip.pickup.lng) / 10).round()));
    if (tens == null) return const SizedBox.shrink();
    final meters = tens * 10;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        children: [
          Icon(Icons.near_me_rounded, size: 16, color: meters <= 150 ? c.success : c.muted),
          const SizedBox(width: 6),
          Expanded(child: Text(l.toPickupDistance(km(meters)), style: AnbessaType.body2.copyWith(color: meters <= 150 ? c.success : c.text2, fontWeight: FontWeight.w600))),
        ],
      ),
    );
  }
}

/// The waiting time at the pickup on a ring: free for 3 min, then charged; ticks on its own.
class _WaitingTimer extends StatelessWidget {
  const _WaitingTimer({required this.trip});
  final Trip trip;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return TickingBuilder(
      builder: (context, now) {
        final waiting = waitingAtPickup(trip, now.toUtc());
        final free = waiting <= _freeWaiting;
        return Row(
          children: [
            CountdownRing(remaining: free ? _freeWaiting - waiting : Duration.zero, total: _freeWaiting, size: 56, strokeWidth: 4, child: Icon(Icons.hourglass_bottom_rounded, size: 22, color: free ? c.accentStrong : c.warning)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(l.waitingFor(mmss(waiting)), style: AnbessaType.title.copyWith(color: c.text, fontFeatures: AnbessaType.tabular)),
                  Text(free ? l.freeUntil('3:00') : l.riderIsWaiting, style: AnbessaType.caption.copyWith(color: c.muted)),
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}

class _PinSheet extends StatelessWidget {
  const _PinSheet();
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
