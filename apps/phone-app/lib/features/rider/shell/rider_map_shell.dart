// The rider's map shell: ONE map from home to the end of a trip, in the GoRide kit's look.
//
// A go_router ShellRoute (riderMapShellRoute, inside the rider's Home tab) whose child routes are
// the stages: /rider/home, /rider/book/route (search), /rider/book/quote (choose ride) and
// /rider/trip/:id. The shell reads the stage from the location and shows:
//   - the map (one AnbessaMap for every stage, so routes, pins and cars animate between stages
//     instead of a new map loading), fed by the stage's MapIntent (map_intent.dart), with the
//     kit's round controls;
//   - the stage's floating pieces (the layers button on home; the route card on choose ride and
//     on a trip; back, share and SOS as round buttons);
//   - one RiderSheet (an AppSheet with an AppSheetController): its snap points change per stage
//     and the sheet glides to the stage's resting size, while the content switches with a
//     shared-axis transition. The sheet's height goes to the map as a ValueListenable, so dragging
//     it never rebuilds the screen;
//   - what covers the map for a while: the "Where do you want to go?" page while searching (the
//     map stays alive under it), "Searching your location..." rings, and the end of a trip ("You
//     have arrived!" over the dimmed map, "Ride has been canceled!").
// The stage pages themselves are empty (the go_router child navigator is kept in the tree only
// for back navigation). Pay and rate stay full-screen pages on the root navigator.
//
// The shell owns what animates every frame: the cars around the rider (CarsAnimator, ticking only
// on the home stage while it is on screen), the trip's car (a MarkerAnimator per trip) and the
// completion confetti. Stage content reaches them through RiderMapScope.

import 'package:confetti/confetti.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/location/location_source.dart';
import '../../../core/perf.dart';
import '../../../core/router/routes.dart';
import '../../../core/router/transitions.dart';
import '../../../core/session/session_controller.dart';
import '../../maps/anbessa_map.dart';
import '../../maps/nearby_cars_layer.dart';
import '../../shell/shells.dart';
import '../booking/pin_picker.dart';
import '../booking/quote_screen.dart';
import '../booking/search_sheet.dart';
import '../home/rider_home_screen.dart';
import '../payments/pay_screen.dart';
import '../rating/rating_screen.dart';
import '../trip/rider_trip_screen.dart';
import 'map_intent.dart';

/// The rider stages as one go_router ShellRoute. [rootKey] is the app's root navigator: pay and
/// rate open there, full-screen over the shell.
ShellRoute riderMapShellRoute(GlobalKey<NavigatorState> rootKey) {
  Page<void> stage(BuildContext _, GoRouterState s) => NoTransitionPage<void>(key: s.pageKey, child: const SizedBox.shrink());
  return ShellRoute(
    builder: (context, state, child) => RiderMapShell(location: state.uri, child: child),
    routes: [
      GoRoute(path: Routes.riderHome, pageBuilder: stage, routes: [
        GoRoute(path: 'book/pickup', redirect: (_, _) => Routes.riderPickup),
      ]),
      // saving a place from the account isn't a booking: the full-screen picker
      GoRoute(
        path: Routes.riderRoute,
        redirect: (_, s) => s.uri.queryParameters['mode'] == 'savedPlace' ? Routes.pickSavedPlace(s.uri.queryParameters['label'] ?? 'other') : null,
        pageBuilder: stage,
      ),
      GoRoute(path: Routes.riderQuote, pageBuilder: stage),
      GoRoute(path: '/rider/trip/:id', pageBuilder: stage, routes: [
        GoRoute(parentNavigatorKey: rootKey, path: 'pay', pageBuilder: (_, s) => slideUpPage(s, PayScreen(tripId: s.pathParameters['id']!))),
        GoRoute(parentNavigatorKey: rootKey, path: 'rate', pageBuilder: (_, s) => slideUpPage(s, RatingScreen(tripId: s.pathParameters['id']!, asDriver: false, doneRoute: Routes.riderHome))),
      ]),
    ],
  );
}

/// The Hero tag of the driver's photo on the trip sheet, the pay page and the rating page.
String driverAvatarHeroTag(String tripId) => 'driver-avatar-$tripId';

/// What the stage content shares with the shell.
class RiderMapScope extends InheritedWidget {
  const RiderMapScope({super.key, required this.shell, required super.child});
  final RiderMapShellState shell;

  static RiderMapShellState of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<RiderMapScope>()!.shell;
  static RiderMapShellState? maybeOf(BuildContext context) => context.dependOnInheritedWidgetOfExactType<RiderMapScope>()?.shell;

  @override
  bool updateShouldNotify(RiderMapScope old) => false;
}

/// The sheet's snap points (fractions of the shell's height) and where a stage rests.
@immutable
class SheetStops {
  const SheetStops(this.snaps, [this.initial = 0]);
  final List<double> snaps;
  final int initial;
  @override
  bool operator ==(Object other) => other is SheetStops && listEquals(other.snaps, snaps) && other.initial == initial;
  @override
  int get hashCode => Object.hash(Object.hashAll(snaps), initial);
}

/// Where the sheet rests at each stage. Short stages are sized to their content in pixels
/// (scaled with the text) over the shell's [height]; [tripStage] picks the trip's.
SheetStops sheetStopsFor(RiderMapStage s, {required bool pin, double height = 700, double textScale = 1, RiderStage? tripStage, bool locating = false}) {
  final k = 1 + (textScale - 1) * 0.85;
  double px(double v) => (v * k / height).clamp(0.18, 0.9);
  return switch (s.kind) {
    RiderMapStageKind.home => SheetStops([px(locating ? 172 : 212)]),
    RiderMapStageKind.search => pin ? SheetStops([px(262)]) : SheetStops([px(212)]),
    RiderMapStageKind.quote => SheetStops([0.56, 0.92]),
    RiderMapStageKind.trip => switch (tripStage) {
        RiderStage.finding => SheetStops([px(292)]),
        RiderStage.completed || RiderStage.cancelled => SheetStops([px(212)]),
        _ => SheetStops([px(300), 0.88]),
      },
  };
}

class RiderMapShell extends ConsumerStatefulWidget {
  const RiderMapShell({super.key, required this.location, required this.child});
  /// the current location (the stage comes from it)
  final Uri location;
  /// go_router's navigator for the stage pages (empty pages; kept for back navigation)
  final Widget child;
  @override
  ConsumerState<RiderMapShell> createState() => RiderMapShellState();
}

class RiderMapShellState extends ConsumerState<RiderMapShell> with TickerProviderStateMixin, WidgetsBindingObserver {
  late final CarsAnimator nearby;
  late final ConfettiController confetti = ConfettiController(duration: const Duration(seconds: 2));
  final AppSheetController sheet = AppSheetController();
  final ValueNotifier<double> _sheetHeight = ValueNotifier<double>(0);
  MarkerAnimator? _car;
  String? _carTrip;
  late RiderMapStage _stage = RiderMapStage.fromUri(widget.location);
  bool _visible = true;
  bool _resumed = true;
  Object? _restingFor;

  RiderMapStage get stage => _stage;

  /// The live sheet height in pixels (the map's bottom inset).
  ValueListenable<double> get sheetHeight => _sheetHeight;

  /// The animated car of trip [tripId] (a new animator when the trip changes).
  MarkerAnimator carFor(String tripId) {
    if (_carTrip == tripId && _car != null) return _car!;
    final old = _car;
    if (old != null) WidgetsBinding.instance.addPostFrameCallback((_) => old.dispose());
    _carTrip = tripId;
    return _car = MarkerAnimator(vsync: this);
  }

  @override
  void initState() {
    super.initState();
    nearby = CarsAnimator(vsync: this);
    WidgetsBinding.instance.addObserver(this);
    Perf.mark('rider stage ${_stage.kind.name}');
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _syncNearby();
    });
  }

  @override
  void didUpdateWidget(covariant RiderMapShell oldWidget) {
    super.didUpdateWidget(oldWidget);
    final next = RiderMapStage.fromUri(widget.location);
    if (next == _stage) return;
    final leftSearch = _stage.kind == RiderMapStageKind.search && next.kind != RiderMapStageKind.search;
    _stage = next;
    Perf.mark('rider stage ${next.kind.name}');
    if (leftSearch) {
      Future.microtask(() {
        if (!mounted) return;
        ref.read(pinPickerProvider.notifier).close();
        ref.read(routeSearchProvider.notifier).end();
      });
    }
    _syncNearby();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // covered by another tab or a full-screen page: no polling, no animation
    final visible = TickerMode.valuesOf(context).enabled;
    if (visible == _visible) return;
    _visible = visible;
    _syncNearby();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final resumed = state == AppLifecycleState.resumed;
    if (resumed == _resumed || (state != AppLifecycleState.resumed && state != AppLifecycleState.paused)) return;
    _resumed = resumed;
    _syncNearby();
  }

  /// The cars around the rider are polled and animated only on the home stage, on screen.
  void _syncNearby() {
    final on = _visible && _resumed && _stage.kind == RiderMapStageKind.home;
    nearby.paused = !on;
    Future.microtask(() {
      if (!mounted) return;
      final ctrl = ref.read(nearbyCarsProvider.notifier);
      if (on) {
        ctrl.resume();
        final me = ref.read(lastPositionProvider);
        if (me != null) ctrl.watch(me.lat, me.lng);
      } else {
        ctrl.pause();
      }
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    nearby.dispose();
    _car?.dispose();
    confetti.dispose();
    _sheetHeight.dispose();
    super.dispose();
  }

  /// The sheet moved. While the sheet itself rebuilds (new snap points) the height is passed on
  /// after the frame, and a height the sheet can't know yet (before its first layout) is skipped.
  void _onSheetHeight(double h) {
    if (!h.isFinite || h < 0) return;
    if (SchedulerBinding.instance.schedulerPhase == SchedulerPhase.persistentCallbacks) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _sheetHeight.value = h;
      });
    } else {
      _sheetHeight.value = h;
    }
  }

  /// After a stage (or pin mode) change the sheet glides to the new stage's resting size. The map
  /// hears the height even when the sheet doesn't move (a sheet that is built at its size, or
  /// already there, reports nothing by itself).
  void _restSheet(Object key, SheetStops stops, double height) {
    if (key == _restingFor) return;
    final first = _restingFor == null;
    _restingFor = key;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted || _restingFor != key) return;
      if (first) _onSheetHeight(stops.snaps[stops.initial] * height);
      await sheet.animateTo(stops.initial, duration: first ? const Duration(milliseconds: 1) : AnbessaMotion.of(context, AnbessaMotion.sheet));
      if (mounted && _restingFor == key) _onSheetHeight(sheet.size * height);
    });
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(nearbyCarsProvider, (_, next) => nearby.update(next.data.cars));
    ref.listen(riderLocationProvider, (_, next) {
      final p = next.value;
      if (p != null && _stage.kind == RiderMapStageKind.home && _visible) ref.read(nearbyCarsProvider.notifier).watch(p.lat, p.lng);
    });
    final pin = _stage.kind == RiderMapStageKind.search && ref.watch(pinPickerProvider.select((p) => p.active));
    final tripStage = _stage.tripId == null ? null : ref.watch(tripViewProvider(_stage.tripId!).select((v) => v?.stage));
    final locating = _stage.kind == RiderMapStageKind.home && ref.watch(riderLocatingProvider);
    final searching = _stage.kind == RiderMapStageKind.search && !pin;
    final ended = tripStage == RiderStage.completed || tripStage == RiderStage.cancelled;
    final c = context.colors;
    final textScale = MediaQuery.textScalerOf(context).scale(16) / 16;
    return RiderMapScope(
      shell: this,
      child: LayoutBuilder(
        builder: (context, box) {
          final stops = sheetStopsFor(_stage, pin: pin, height: box.maxHeight, textScale: textScale, tripStage: tripStage, locating: locating);
          _restSheet((_stage, pin, tripStage, locating, stops), stops, box.maxHeight);
          return Stack(
            children: [
              // the stage pages: empty, kept for go_router's back navigation
              Positioned.fill(child: IgnorePointer(child: widget.child)),
              Positioned.fill(child: _RiderMapView(stage: _stage)),
              if (pin) const _DropPin(),
              if (locating) const _LocatingRings(),
              _StageOverlays(stage: _stage, pin: pin, tripStage: tripStage),
              RiderSheet(stage: _stage, pin: pin, stops: stops, locating: locating, tripStage: tripStage),
              // over everything for a while: the search page, the end of a trip
              Positioned.fill(
                child: AnimatedSwitcher(
                  duration: AnbessaMotion.of(context, AnbessaMotion.medium),
                  switchInCurve: AnbessaMotion.emphasizedDecelerate,
                  switchOutCurve: AnbessaMotion.emphasizedAccelerate,
                  transitionBuilder: (child, a) => FadeTransition(
                    opacity: a,
                    child: SlideTransition(position: Tween(begin: const Offset(0, 0.06), end: Offset.zero).animate(a), child: child),
                  ),
                  child: searching
                      ? SearchPage(key: const ValueKey('search-page'), focusPickup: _stage.focusPickup)
                      : ended
                          ? TripEndLayer(key: ValueKey('end-${_stage.tripId}-$tripStage'), tripId: _stage.tripId!)
                          : const SizedBox.shrink(key: ValueKey('none')),
                ),
              ),
              Align(alignment: Alignment.topCenter, child: IgnorePointer(child: ConfettiWidget(confettiController: confetti, blastDirectionality: BlastDirectionality.explosive, numberOfParticles: 24, colors: [c.accent, c.success, c.info]))),
            ],
          );
        },
      ),
    );
  }
}

/// The one sheet: snap points per stage, content switched with a shared-axis transition.
class RiderSheet extends StatelessWidget {
  const RiderSheet({super.key, required this.stage, required this.pin, required this.stops, this.locating = false, this.tripStage});
  final RiderMapStage stage;
  /// the trip's stage: finding a driver pins Cancel Ride under the sheet
  final RiderStage? tripStage;
  final bool pin;
  final SheetStops stops;
  /// home without a position yet: "Searching your location..."
  final bool locating;

  @override
  Widget build(BuildContext context) {
    final shell = RiderMapScope.of(context);
    final key = ValueKey((stage.kind, stage.tripId, pin, locating));
    final footerKey = ValueKey((stage.kind, stage.tripId, tripStage));
    Widget? footer;
    Widget body;
    switch (stage.kind) {
      case RiderMapStageKind.home:
        body = locating ? const LocatingSheet() : const HomeSheet();
      case RiderMapStageKind.search:
        // the search itself is a page over the shell; the sheet waits under it
        body = pin ? const PinCard() : const SizedBox.shrink();
      case RiderMapStageKind.quote:
        footer = const QuoteFooter();
        body = const QuoteSheet();
      case RiderMapStageKind.trip:
        body = TripSheet(key: ValueKey(stage.tripId), tripId: stage.tripId!);
        if (tripStage == RiderStage.finding) footer = TripSheetFooter(tripId: stage.tripId!);
    }
    return AppSheet(
      controller: shell.sheet,
      snaps: stops.snaps,
      initialSnap: stops.initial,
      onHeightChanged: shell._onSheetHeight,
      padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 16),
      footer: footer == null ? null : AnimatedSwitcherX(child: KeyedSubtree(key: footerKey, child: footer)),
      builder: (context, _) => SharedAxisSwitcher(child: KeyedSubtree(key: key, child: body)),
    );
  }
}

/// Home before the first position: the kit's rings around the rider's avatar in the middle of
/// the map, above the sheet.
class _LocatingRings extends ConsumerWidget {
  const _LocatingRings();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final shell = RiderMapScope.of(context);
    final session = ref.watch(currentSessionProvider);
    return ValueListenableBuilder<double>(
      valueListenable: shell.sheetHeight,
      builder: (_, h, child) => Positioned(left: 0, right: 0, top: 0, bottom: h, child: child!),
      child: IgnorePointer(
        child: Center(
          child: RadarRings(
            size: 230,
            child: Container(
              decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: context.colors.accent, width: 4)),
              child: AvatarImage(src: session?.profile.image, name: session?.displayName ?? '', size: 64),
            ),
          ),
        ),
      ),
    );
  }
}

/// The map with the current stage's intent. Rebuilds when the intent changes (and, for 600 ms
/// after a new choose-ride road, while the road draws); never per car frame or sheet pixel.
class _RiderMapView extends ConsumerStatefulWidget {
  const _RiderMapView({required this.stage});
  final RiderMapStage stage;
  @override
  ConsumerState<_RiderMapView> createState() => _RiderMapViewState();
}

class _RiderMapViewState extends ConsumerState<_RiderMapView> with SingleTickerProviderStateMixin {
  late final AnimationController _reveal = AnimationController(vsync: this, duration: const Duration(milliseconds: 600), value: 1);
  Object? _revealKey;

  @override
  void dispose() {
    _reveal.dispose();
    super.dispose();
  }

  MapIntent _intent(RiderMapStage s) => switch (s.kind) {
        RiderMapStageKind.home => ref.watch(homeMapIntentProvider),
        RiderMapStageKind.search => ref.watch(searchMapIntentProvider),
        RiderMapStageKind.quote => ref.watch(quoteMapIntentProvider),
        RiderMapStageKind.trip => ref.watch(tripMapIntentProvider(s.tripId!)),
      };

  /// A new road draws from its start over 600 ms (at once when motion is reduced).
  void _syncReveal(Object? key) {
    if (key == _revealKey) return;
    _revealKey = key;
    if (key == null || MediaQuery.disableAnimationsOf(context)) {
      _reveal.value = 1;
      return;
    }
    _reveal.value = 0;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _revealKey == key) _reveal.forward(from: 0);
    });
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final shell = RiderMapScope.of(context);
    final stage = widget.stage;
    final intent = _intent(stage);
    final me = ref.watch(riderLocationProvider).value ?? ref.watch(lastPositionProvider);
    final bannerH = ref.watch(bannerHeightProvider);
    final etaSeconds = intent.nearby ? ref.watch(nearbyCarsProvider.select((s) => s.data.etaSeconds)) : null;
    final car = intent.car && stage.tripId != null ? shell.carFor(stage.tripId!) : null;
    if (car != null) car.route = intent.carRoad;
    _syncReveal(intent.revealKey);
    final pin = ref.read(pinPickerProvider.notifier);
    final top = MediaQuery.paddingOf(context).top;
    final session = ref.watch(currentSessionProvider);
    final person = MapPerson(photo: session?.profile.image, name: session?.displayName ?? '');
    // the route card covers the top on choose ride and on a trip (and a pin's label needs room
    // above it: the camera keeps fitted points 48 px under the inset)
    final cardTop = stage.kind == RiderMapStageKind.quote || stage.kind == RiderMapStageKind.trip ? 168.0 : 64.0;
    final callouts = [
      for (final k in intent.callouts)
        MapCallout(
          point: k.point,
          label: switch (k.kind) {
            IntentCalloutKind.minutes => l.rideMinutes(k.minutes!),
            IntentCalloutKind.arriveAt => l.rideArriveAt(clockHHmm(k.time!)),
          },
          tone: Tone.amber,
          offsetY: -52,
        ),
    ];
    return AnimatedBuilder(
      animation: _reveal,
      builder: (context, _) {
        final t = AnbessaMotion.emphasized.transform(_reveal.value);
        final routes = intent.revealKey == null || t >= 1 || intent.routes.isEmpty
            ? intent.routes
            : [RouteLine(routePrefix(intent.routes.first.points, t), kind: intent.routes.first.kind), ...intent.routes.skip(1)];
        return AnbessaMap(
          mePose: me == null || !intent.showMe ? null : MePose(position: LatLng(me.lat, me.lng), heading: me.heading, accuracy: me.accuracy),
          nearbyCars: intent.nearby ? shell.nearby.frames : null,
          nearbyLabel: etaSeconds == null ? null : l.rideMinutes(minutesCeil(etaSeconds)),
          driverCar: car,
          driverCarLabel: intent.carMinutes == null ? null : l.rideMinutes(intent.carMinutes!),
          pickup: intent.pickup,
          dropoff: intent.dropoff,
          routes: routes,
          fit: intent.fit,
          fitKey: intent.fitKey,
          follow: intent.follow,
          followZoom: intent.followZoom,
          callouts: callouts,
          pulse: intent.radarAt == null ? null : MapPulse.at(intent.radarAt!),
          person: person,
          // once a ride is booked the person's photo leaves the map: a plain pickup pin
          pickupAsAvatar: stage.kind != RiderMapStageKind.trip,
          meAsAvatar: intent.meAvatar,
          roundControls: true,
          showModeSwitch: false,
          // pin mode: the camera centre is exactly the screen centre, where the pin stands
          topInset: intent.pin ? 0 : top + bannerH + cardTop,
          sheetHeight: intent.pin ? null : shell.sheetHeight,
          padding: intent.pin ? EdgeInsets.zero : const EdgeInsets.all(48),
          showControls: intent.controls,
          onUserGesture: intent.pin ? pin.lift : null,
          onMove: intent.pin ? pin.moved : null,
        );
      },
    );
  }
}

/// How far below the screen centre the camera centre sits in pin mode: the director fits with
/// 48 px of room above and 32 px below (camera_director.dart, _fitPadding), so the place it
/// centres, and the centre MapLibre reports after a drag, are half the difference lower.
const _pinCentreOffset = (48 - 32) / 2;

/// The rider's avatar in a white-edged amber ring, in the middle of the "finding a driver" rings.
/// The centre pin of "Select from map": the rider's avatar pin for a pickup, the red pin for a
/// destination; it lifts while the map moves and drops with a bounce.
class _DropPin extends ConsumerWidget {
  const _DropPin();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = ref.watch(pinPickerProvider);
    final session = ref.watch(currentSessionProvider);
    final lifted = p.lifted;
    final d = AnbessaMotion.of(context, lifted ? AnbessaMotion.base : AnbessaMotion.slow);
    final size = p.pickup ? avatarPinSize(52) : destinationPinSize(40);
    final pinWidget = p.pickup ? MapAvatarPin(photo: session?.profile.image, name: session?.displayName ?? '', diameter: 52) : const DestinationPin(diameter: 40);
    return IgnorePointer(
      child: Center(
        child: Padding(
          // the pin's tip sits on the camera centre
          padding: EdgeInsets.only(bottom: size.height - 2 * _pinCentreOffset),
          child: AnimatedSlide(
            key: const ValueKey('drop-pin'),
            duration: d,
            curve: lifted ? AnbessaMotion.emphasizedDecelerate : AnbessaMotion.spring,
            offset: lifted ? const Offset(0, -0.25) : Offset.zero,
            child: pinWidget,
          ),
        ),
      ),
    );
  }
}

/// What floats over the map at each stage: the layers button on home; back on "Select from
/// map"; the route card with back on choose ride; the route card with share and SOS on a trip.
class _StageOverlays extends ConsumerWidget {
  const _StageOverlays({required this.stage, required this.pin, this.tripStage});
  final RiderMapStage stage;
  final bool pin;
  final RiderStage? tripStage;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final top = MediaQuery.paddingOf(context).top + 8 + ref.watch(bannerHeightProvider);
    final shell = RiderMapScope.of(context);
    final Widget bar = switch (stage.kind) {
      RiderMapStageKind.home => const HomeTopBar(key: ValueKey('home-bar')),
      RiderMapStageKind.search when pin => Align(
          key: const ValueKey('pin-bar'),
          alignment: AlignmentDirectional.centerStart,
          child: RoundIconButton(icon: Icons.arrow_back_rounded, tooltip: l.back, onTap: () => ref.read(pinPickerProvider.notifier).close()),
        ),
      RiderMapStageKind.search => const SizedBox.shrink(key: ValueKey('search-bar')),
      RiderMapStageKind.quote => const QuoteRouteCard(key: ValueKey('quote-bar')),
      RiderMapStageKind.trip => TripTopBar(key: ValueKey('trip-bar-${stage.tripId}'), tripId: stage.tripId!),
    };
    // back, bottom-left above the sheet (the kit's "<")
    final back = stage.kind == RiderMapStageKind.quote;
    return Stack(
      children: [
        Positioned(top: top, left: 16, right: 16, child: AnimatedSwitcherX(child: bar)),
        if (back)
          ValueListenableBuilder<double>(
            valueListenable: shell.sheetHeight,
            // clear of the map credit
            builder: (_, h, child) => Positioned(left: 16, bottom: h + 28, child: child!),
            child: RoundIconButton(icon: Icons.chevron_left_rounded, tooltip: l.back, onTap: () => leaveQuote(context)),
          ),
      ],
    );
  }
}

/// Back from choosing a ride: to the search (or home when the quote was opened directly).
void leaveQuote(BuildContext context) {
  if (context.canPop()) {
    context.pop();
  } else {
    context.go(Routes.riderHome);
  }
}
