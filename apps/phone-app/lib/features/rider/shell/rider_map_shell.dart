// The rider's map shell: ONE map from home to the end of a trip.
//
// A go_router ShellRoute (riderMapShellRoute, inside the rider's Home tab) whose child routes are
// the stages: /rider/home, /rider/book/route (search), /rider/book/quote (choose ride) and
// /rider/trip/:id. The shell reads the stage from the location and shows:
//   - the map (one AnbessaMap for every stage, so routes, pins and cars animate between stages
//     instead of a new map loading), fed by the stage's MapIntent (map_intent.dart);
//   - the stage's top overlays (home bar, back, share and SOS);
//   - one RiderSheet (an AppSheet with an AppSheetController): its snap points change per stage
//     and the sheet glides to the stage's resting size, while the content switches with a
//     shared-axis transition. The sheet's height goes to the map as a ValueListenable, so dragging
//     it never rebuilds the screen.
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
}

SheetStops sheetStopsFor(RiderMapStage s, {required bool pin}) => switch (s.kind) {
      RiderMapStageKind.home => const SheetStops([0.4, 0.62, 0.92]),
      RiderMapStageKind.search => pin ? const SheetStops([0.3, 0.5]) : const SheetStops([0.5, 0.94], 1),
      RiderMapStageKind.quote => const SheetStops([0.52, 0.94]),
      RiderMapStageKind.trip => const SheetStops([0.42, 0.86]),
    };

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

  /// After a stage (or pin mode) change the sheet glides to the new stage's resting size.
  void _restSheet(Object key, SheetStops stops) {
    if (key == _restingFor) return;
    final first = _restingFor == null;
    _restingFor = key;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _restingFor != key) return;
      sheet.animateTo(stops.initial, duration: first ? const Duration(milliseconds: 1) : AnbessaMotion.of(context, AnbessaMotion.sheet));
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
    final stops = sheetStopsFor(_stage, pin: pin);
    _restSheet((_stage, pin), stops);
    final c = context.colors;
    return RiderMapScope(
      shell: this,
      child: Stack(
        children: [
          // the stage pages: empty, kept for go_router's back navigation
          Positioned.fill(child: IgnorePointer(child: widget.child)),
          Positioned.fill(child: _RiderMapView(stage: _stage)),
          if (pin) const _DropPin(),
          _StageOverlays(stage: _stage, pin: pin),
          RiderSheet(stage: _stage, pin: pin, stops: stops),
          Align(alignment: Alignment.topCenter, child: IgnorePointer(child: ConfettiWidget(confettiController: confetti, blastDirectionality: BlastDirectionality.explosive, numberOfParticles: 24, colors: [c.accent, c.success, c.info]))),
        ],
      ),
    );
  }
}

/// The one sheet: snap points per stage, content switched with a shared-axis transition.
class RiderSheet extends StatelessWidget {
  const RiderSheet({super.key, required this.stage, required this.pin, required this.stops});
  final RiderMapStage stage;
  final bool pin;
  final SheetStops stops;

  @override
  Widget build(BuildContext context) {
    final shell = RiderMapScope.of(context);
    final key = ValueKey((stage.kind, stage.tripId, pin));
    Widget? header;
    Widget? footer;
    Widget body;
    switch (stage.kind) {
      case RiderMapStageKind.home:
        body = const HomeSheet();
      case RiderMapStageKind.search:
        header = pin ? null : SearchHeader(focusPickup: stage.focusPickup);
        body = pin ? const PinCard() : const SearchSuggestions();
      case RiderMapStageKind.quote:
        header = const QuoteHeader();
        footer = const QuoteFooter();
        body = const QuoteSheet();
      case RiderMapStageKind.trip:
        body = TripSheet(key: ValueKey(stage.tripId), tripId: stage.tripId!);
    }
    return AppSheet(
      controller: shell.sheet,
      snaps: stops.snaps,
      initialSnap: stops.initial,
      onHeightChanged: shell._onSheetHeight,
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
      header: header == null ? null : AnimatedSwitcherX(child: KeyedSubtree(key: key, child: header)),
      footer: footer == null ? null : AnimatedSwitcherX(child: KeyedSubtree(key: key, child: footer)),
      builder: (context, _) => SharedAxisSwitcher(child: KeyedSubtree(key: key, child: body)),
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
    final c = context.colors;
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
          mePose: me == null ? null : MePose(position: LatLng(me.lat, me.lng), heading: me.heading, accuracy: me.accuracy),
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
          overlays: [if (intent.radarAt != null) MapOverlay(point: intent.radarAt!, size: const Size(160, 160), child: RadarPulse(color: c.accent, size: 160))],
          // pin mode: the camera centre is exactly the screen centre, where the pin stands
          topInset: intent.pin ? 0 : top + bannerH + 64,
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

/// The centre pin of "choose on the map": lifts while the map moves, drops with a bounce.
class _DropPin extends ConsumerWidget {
  const _DropPin();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = ref.watch(pinPickerProvider);
    final lifted = p.lifted;
    final d = AnbessaMotion.of(context, lifted ? AnbessaMotion.base : AnbessaMotion.slow);
    return IgnorePointer(
      child: Center(
        child: Padding(
          padding: const EdgeInsets.only(bottom: 41 - 2 * _pinCentreOffset),
          child: AnimatedSlide(
            key: const ValueKey('drop-pin'),
            duration: d,
            curve: lifted ? AnbessaMotion.emphasizedDecelerate : AnbessaMotion.spring,
            offset: lifted ? const Offset(0, -0.35) : Offset.zero,
            child: PinMarker(tone: p.pickup ? PinTone.pickup : PinTone.dropoff, lifted: lifted),
          ),
        ),
      ),
    );
  }
}

/// What floats over the map at each stage: the home bar and the nearby-cars chip; a back button;
/// share and SOS on a trip.
class _StageOverlays extends ConsumerWidget {
  const _StageOverlays({required this.stage, required this.pin});
  final RiderMapStage stage;
  final bool pin;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final top = MediaQuery.paddingOf(context).top + 8 + ref.watch(bannerHeightProvider);
    final shell = RiderMapScope.of(context);
    Widget back(VoidCallback onTap) => RoundIconButton(icon: Icons.arrow_back_rounded, tooltip: l.back, onTap: onTap);
    final Widget bar = switch (stage.kind) {
      RiderMapStageKind.home => const HomeTopBar(key: ValueKey('home-bar')),
      RiderMapStageKind.search when pin => Align(key: const ValueKey('pin-bar'), alignment: Alignment.centerLeft, child: back(() => ref.read(pinPickerProvider.notifier).close())),
      RiderMapStageKind.search => const SizedBox.shrink(key: ValueKey('search-bar')),
      RiderMapStageKind.quote => Align(key: const ValueKey('quote-bar'), alignment: Alignment.centerLeft, child: back(() => leaveQuote(context))),
      RiderMapStageKind.trip => TripTopBar(key: ValueKey('trip-bar-${stage.tripId}'), tripId: stage.tripId!),
    };
    return Stack(
      children: [
        Positioned(top: top, left: 16, right: 16, child: AnimatedSwitcherX(child: bar)),
        if (stage.kind == RiderMapStageKind.home)
          ValueListenableBuilder<double>(
            valueListenable: shell.sheetHeight,
            builder: (_, h, child) => Positioned(left: 16, bottom: h + 12, child: child!),
            child: const NearbyChip(),
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
