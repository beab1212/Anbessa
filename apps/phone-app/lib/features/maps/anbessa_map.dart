// The map. Screens describe what's on it (routes, pins, the cars, the person, labels), how much is
// covered by sheets and banners, and whether to follow someone; the engine draws it.
//
// Two engines with the same behaviour:
//   - vector_map.dart: MapLibre (vector tiles, 2D / 3D / satellite) on Android and iOS. Cars,
//     pins, the person and routes are native layers owned by a MapScene (scene/map_scene.dart);
//     only overlays and a few callouts are Flutter widgets.
//   - raster_map.dart: flutter_map (raster tiles, 2D / satellite) on the desktop and in tests
// Both hand camera decisions to a CameraDirector (scene/camera_director.dart) through a
// MapBinding: follow and navigation glide with the car, fits happen only when the screen's
// intent changes, and a gesture frees the camera and shows a "Recenter" pill.
//
// Things that move every frame (the animated car, nearby cars, the sheet height) come in as
// ValueListenables, so the screen never rebuilds per frame.

import 'dart:math';

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart' show LatLng;
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../../core/state.dart';
import 'callouts.dart';
import 'map_mode.dart';
import 'marker_animator.dart';
import 'me_marker.dart';
import 'raster_map.dart';
import 'route_layer.dart';
import 'scene/scene_geojson.dart';
import 'vector_map.dart';

export 'callouts.dart' show MapCallout;
export 'map_mode.dart' show MapMode, mapModeProvider;
export 'marker_animator.dart' show AnimatedPose, MarkerAnimator;
export 'me_marker.dart' show MePose;
export 'route_layer.dart' show RouteLine, RouteKind;
export 'scene/scene_geojson.dart' show NearbyCarFrame;

/// Tiles failed to load (the tile server is down, or no network).
final mapTilesDownProvider = valueProvider<bool>(false);

enum FollowMode { none, me, driver, driverBearing }

/// A car around the rider (anonymous).
@immutable
class CarPose {
  const CarPose({required this.position, this.heading});
  final LatLng position;
  final double? heading;
}

/// Any widget pinned to a point (e.g. the search pulse at the pickup).
@immutable
class MapOverlay {
  const MapOverlay({required this.point, required this.size, required this.child, this.alignment = Alignment.center});
  final LatLng point;
  final Size size;
  final Widget child;
  final Alignment alignment;
}

/// The person the map's avatar pins show (the pickup, and "you" with [AnbessaMap.meAsAvatar]).
@immutable
class MapPerson {
  const MapPerson({this.photo, this.name = ''});
  /// a data URL or https URL
  final String? photo;
  final String name;
  @override
  bool operator ==(Object other) => other is MapPerson && other.photo == photo && other.name == name;
  @override
  int get hashCode => Object.hash(photo, name);
}

class AnbessaMap extends ConsumerWidget {
  const AnbessaMap({
    super.key,
    this.fit = const [],
    this.center,
    this.zoom = 13,
    this.pickup,
    this.dropoff,
    this.driver,
    this.driverPose,
    this.driverCar,
    this.driverCarLabel,
    this.me,
    this.mePose,
    this.line = const [],
    this.routes = const [],
    this.cars = const [],
    this.nearbyCars,
    this.nearbyLabel,
    this.callouts = const [],
    this.overlays = const [],
    this.topInset = 0,
    this.bottomInset = 0,
    this.sheetHeight,
    this.fitKey,
    this.follow = FollowMode.none,
    this.followZoom = 16,
    this.showControls = true,
    this.showModeSwitch = true,
    this.onUserGesture,
    this.onRecenter,
    this.onTap,
    this.onMove,
    this.padding = const EdgeInsets.all(48),
    this.interactive = true,
    this.person,
    this.meAsAvatar = false,
    this.roundControls = false,
  });

  /// Points to show when nothing is followed. Empty: [center] or the city. The camera fits them
  /// when [fitKey] changes (or, without a key, when the points change), when the insets settle,
  /// and on recenter; never because the screen rebuilt.
  final List<LatLng> fit;
  /// Identifies what [fit] shows (a stage, a route): a new key fits again, even after the person
  /// moved the map. Points that change under the same key (a moving car) don't refit.
  final Object? fitKey;
  final LatLng? center;
  final double zoom;
  final LatLng? pickup;
  final LatLng? dropoff;
  /// a static car (older screens); prefer [driverPose]
  final DriverMarkerData? driver;
  /// a car pose (redrawn when the screen rebuilds); prefer [driverCar]
  final AnimatedPose? driverPose;
  /// the animated car: a [MarkerAnimator] (or any listenable pose), drawn every frame without
  /// rebuilding the screen; takes precedence over [driverPose]
  final ValueListenable<AnimatedPose?>? driverCar;
  /// a label above the car ("4 min")
  final String? driverCarLabel;
  /// the person's position as a point (older screens); prefer [mePose]
  final LatLng? me;
  final MePose? mePose;
  /// a straight dotted line (older screens); prefer [routes]
  final List<LatLng> line;
  final List<RouteLine> routes;
  /// still cars around the rider (older form); prefer [nearbyCars]
  final List<CarPose> cars;
  /// the animated cars around the rider (from a CarsAnimator)
  final ValueListenable<List<NearbyCarFrame>>? nearbyCars;
  /// a label above the nearest of [nearbyCars] ("4 min")
  final String? nearbyLabel;
  /// labels at fixed points (Flutter widgets: keep to two or three)
  final List<MapCallout> callouts;
  final List<MapOverlay> overlays;
  /// pixels covered at the top (banners) and bottom (the sheet)
  final double topInset;
  final double bottomInset;
  /// the live sheet height; when given it replaces [bottomInset], and the screen doesn't need to
  /// rebuild while the sheet is dragged
  final ValueListenable<double>? sheetHeight;
  final FollowMode follow;
  final double followZoom;
  final bool showControls;
  /// the 2D / 3D / satellite switch among the controls
  final bool showModeSwitch;
  /// the person panned, zoomed or turned the map (every gesture); screens use it to drop follow mode
  final VoidCallback? onUserGesture;
  /// the recenter control was pressed; screens use it to follow again. With it, the control shows
  /// even when nothing is followed or fitted.
  final VoidCallback? onRecenter;
  final void Function(LatLng)? onTap;
  /// the map centre after the person dragged it (drag-to-pick)
  final void Function(LatLng)? onMove;
  final EdgeInsets padding;
  final bool interactive;
  /// whose avatar the pickup pin (and "you", with [meAsAvatar]) shows; a person glyph without
  final MapPerson? person;
  /// draw the person as their avatar pin (the home map) instead of the small dot
  final bool meAsAvatar;
  /// the GoRide kit's controls: round white buttons (a layers button for the mode, a crosshair
  /// to recenter) instead of the small squares
  final bool roundControls;

  /// Every route line, the older straight [line] included.
  List<RouteLine> get allRoutes => [...routes, if (line.length >= 2) RouteLine(line, kind: RouteKind.straight)];

  MePose? get mePoseOrPoint => mePose ?? (me == null ? null : MePose(position: me!));

  /// The car as drawn now (animated, a pose, or a static car).
  AnimatedPose? get carNow {
    final live = driverCar?.value ?? driverPose;
    if (live != null) return live;
    final d = driver;
    return d == null ? null : AnimatedPose(lat: d.position.latitude, lng: d.position.longitude, heading: d.heading ?? 0, stale: d.stale);
  }

  /// Who the camera follows now, if anyone (the car when following "me" without a position).
  LatLng? get subject {
    LatLng? car() => carNow == null ? null : LatLng(carNow!.lat, carNow!.lng);
    return switch (follow) {
      FollowMode.me => mePose?.position ?? me ?? car(),
      FollowMode.driver || FollowMode.driverBearing => car(),
      FollowMode.none => null,
    };
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) => ref.watch(vectorMapsProvider) ? VectorMap(spec: this) : RasterMap(spec: this);
}

/// Something drawn at a point, the same for both engines.
@immutable
class MapPin {
  const MapPin({required this.point, required this.size, required this.child, this.alignment = Alignment.center});
  final LatLng point;
  final Size size;
  final Widget child;
  /// which part of the widget sits on the point (bottomCenter: the tip of a pin)
  final Alignment alignment;
}

/// The pins for a map drawn as Flutter widgets, in drawing order. [mapRotation] gives the map's
/// rotation in degrees (clockwise) where the pin is drawn, so headings stay true when the camera
/// turns. With [native] false (the vector engine, which draws cars, pins and the person as
/// native layers) only the overlays and callouts are returned. The animated car and nearby cars
/// ([AnbessaMap.driverCar], [AnbessaMap.nearbyCars]) are never in the list: the raster engine
/// draws them in their own listening layers.
List<MapPin> pinsFor(AnbessaMap w, double Function(BuildContext) mapRotation, {bool native = true}) {
  final me = w.mePoseOrPoint;
  final pose = w.driverCar == null ? w.driverPose : null;
  final still = w.driverCar == null ? w.driver : null;
  Widget turning(Widget Function(double rot) child) => Builder(builder: (ctx) => child(mapRotation(ctx)));
  return [
    for (final o in w.overlays) MapPin(point: o.point, size: o.size, alignment: o.alignment, child: o.child),
    if (native) ...[
      if (w.nearbyCars == null)
        for (final car in w.cars) MapPin(point: car.position, size: const Size(42, 42), child: turning((r) => NearbyCarGlyph(heading: car.heading, mapRotation: r))),
      if (w.pickup != null) MapPin(point: w.pickup!, size: avatarPinSize(46), alignment: Alignment.bottomCenter, child: MapAvatarPin(photo: w.person?.photo, name: w.person?.name ?? '', diameter: 46)),
      if (w.dropoff != null) MapPin(point: w.dropoff!, size: destinationPinSize(36), alignment: Alignment.bottomCenter, child: const DestinationPin(diameter: 36)),
      if (me != null && w.meAsAvatar)
        MapPin(point: me.position, size: avatarPinSize(46), alignment: Alignment.bottomCenter, child: MapAvatarPin(photo: w.person?.photo, name: w.person?.name ?? '', diameter: 46))
      else if (me != null)
        MapPin(point: me.position, size: const Size(48, 48), child: turning((r) => MeDot(heading: me.heading == null ? null : me.heading! + r))),
      if (pose != null)
        MapPin(point: LatLng(pose.lat, pose.lng), size: const Size(44, 44), child: turning((r) => CarMarker(heading: pose.heading, stale: pose.stale, mapRotation: r)))
      else if (still != null)
        MapPin(point: still.position, size: const Size(44, 44), child: turning((r) => CarMarker(heading: still.heading ?? 0, stale: still.stale, onTrip: still.onTrip, mapRotation: r))),
    ],
    for (final m in w.callouts.take(3)) MapPin(point: m.point, size: const Size(240, 34), alignment: Alignment(0, -m.offsetY / 17), child: Center(child: FadeSlideIn(key: ValueKey('callout:${m.point.latitude.toStringAsFixed(5)},${m.point.longitude.toStringAsFixed(5)}'), offset: 0.3, child: MapCalloutChip(callout: m)))),
  ];
}

/// The controls on the map's right edge: the 2D / 3D / satellite switch, a north needle when the
/// map is turned, and recenter. Small flat squares; a word where a word says it better.
class MapControls extends ConsumerWidget {
  const MapControls({
    super.key,
    required this.rotation,
    required this.onResetNorth,
    required this.showRecenter,
    required this.recenterActive,
    required this.onRecenter,
    this.showModeSwitch = true,
    this.round = false,
  });
  /// round white buttons (the GoRide kit's map controls)
  final bool round;
  /// degrees; the north needle shows when it isn't 0
  final double rotation;
  final VoidCallback onResetNorth;
  final bool showRecenter;
  final bool recenterActive;
  final VoidCallback onRecenter;
  final bool showModeSwitch;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final mode = ref.watch(effectiveMapModeProvider);
    if (round) {
      return MapControlColumn(
        gap: 12,
        children: [
          if (showModeSwitch) RoundIconButton(icon: Icons.layers_outlined, tooltip: l.mapModeTitle, onTap: () => showMapModePicker(context)),
          if (rotation.abs() > 0.5)
            Tooltip(
              message: l.resetNorth,
              child: Material(
                color: context.colors.surface,
                shape: const CircleBorder(),
                elevation: 0,
                child: InkWell(customBorder: const CircleBorder(), onTap: onResetNorth, child: SizedBox.square(dimension: 44, child: Center(child: Transform.rotate(angle: rotation * pi / 180, child: const _NorthNeedle())))),
              ),
            ),
          if (showRecenter) RoundIconButton(icon: recenterActive ? Icons.my_location_rounded : Icons.location_searching_rounded, tooltip: l.recenter, onTap: onRecenter),
        ],
      );
    }
    return MapControlColumn(
      children: [
        if (showModeSwitch)
          MapControlButton(
            tooltip: l.mapModeTitle,
            onTap: () => showMapModePicker(context),
            child: Text(mapModeShort(l, mode), style: AnbessaType.label.copyWith(fontWeight: FontWeight.w800, color: context.colors.text)),
          ),
        if (rotation.abs() > 0.5)
          MapControlButton(
            tooltip: l.resetNorth,
            onTap: onResetNorth,
            child: Transform.rotate(angle: rotation * pi / 180, child: const _NorthNeedle()),
          ),
        if (showRecenter) MapControlButton(icon: Icons.my_location, tooltip: l.recenter, active: recenterActive, onTap: onRecenter),
      ],
    );
  }
}

/// A plain north needle: red half up, grey half down.
class _NorthNeedle extends StatelessWidget {
  const _NorthNeedle();
  @override
  Widget build(BuildContext context) => CustomPaint(size: const Size(12, 24), painter: _NeedlePainter(context.colors.danger, context.colors.faint));
}

class _NeedlePainter extends CustomPainter {
  const _NeedlePainter(this.north, this.south);
  final Color north;
  final Color south;
  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    canvas.drawPath(Path()..moveTo(w / 2, 0)..lineTo(w, h / 2)..lineTo(0, h / 2)..close(), Paint()..color = north);
    canvas.drawPath(Path()..moveTo(0, h / 2)..lineTo(w, h / 2)..lineTo(w / 2, h)..close(), Paint()..color = south);
  }

  @override
  bool shouldRepaint(_NeedlePainter old) => old.north != north || old.south != south;
}

String mapModeShort(AppLocalizations l, MapMode m) => switch (m) { MapMode.flat => '2D', MapMode.threeD => '3D', MapMode.satellite => l.mapModeSatelliteShort };

/// The map mode picker: three choices, each with a one-line description.
Future<void> showMapModePicker(BuildContext context) => showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (ctx) => const _MapModeSheet(),
    );

class _MapModeSheet extends ConsumerWidget {
  const _MapModeSheet();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final current = ref.watch(effectiveMapModeProvider);
    final has3d = ref.watch(vectorMapsProvider);
    Widget option(MapMode m, String title, String body, {bool enabled = true}) {
      final selected = current == m;
      return Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Semantics(
          button: true,
          selected: selected,
          enabled: enabled,
          child: InkWell(
            borderRadius: BorderRadius.circular(AnbessaRadius.md),
            onTap: !enabled
                ? null
                : () {
                    Haptics.selection();
                    ref.read(mapModeProvider.notifier).set(m);
                    Navigator.pop(context);
                  },
            child: Opacity(
              opacity: enabled ? 1 : 0.45,
              child: Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: c.surface,
                  borderRadius: BorderRadius.circular(AnbessaRadius.md),
                  border: Border.all(color: selected ? c.text : c.border, width: 2),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 48,
                      height: 48,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(color: selected ? c.text : c.canvas, borderRadius: BorderRadius.circular(AnbessaRadius.sm)),
                      child: Text(mapModeShort(l, m), style: AnbessaType.label.copyWith(fontWeight: FontWeight.w800, color: selected ? c.surface : c.text)),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(title, style: AnbessaType.title.copyWith(color: c.text)),
                          const SizedBox(height: 2),
                          Text(body, style: AnbessaType.caption.copyWith(color: c.muted)),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    }

    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(l.mapModeTitle, style: AnbessaType.h2.copyWith(color: c.text)),
            const SizedBox(height: 14),
            option(MapMode.flat, l.mapModeFlat, l.mapModeFlatLede),
            option(MapMode.threeD, l.mapMode3d, has3d ? l.mapMode3dLede : l.mapMode3dPhonesOnly, enabled: has3d),
            option(MapMode.satellite, l.mapModeSatellite, l.mapModeSatelliteLede),
          ],
        ),
      ),
    );
  }
}

/// The credit line for the map data, small and never wider than the map.
class MapCredit extends StatelessWidget {
  const MapCredit(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return IgnorePointer(
      child: Align(
        alignment: Alignment.bottomLeft,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
          decoration: BoxDecoration(color: c.surface.withValues(alpha: 0.8), borderRadius: BorderRadius.circular(4)),
          child: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, textScaler: TextScaler.noScaling, style: TextStyle(fontSize: 9, color: c.muted)),
        ),
      ),
    );
  }
}

enum PinTone { pickup, dropoff }

/// A pin whose tip is the point (align its bottom centre to the point). Pickup: a ring; drop-off:
/// a filled square, like a flag.
class PinMarker extends StatelessWidget {
  const PinMarker({super.key, required this.tone, this.lifted = false});
  final PinTone tone;
  /// raised while the map is being dragged under it
  final bool lifted;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final ink = c.isDark ? Colors.white : c.text;
    final head = tone == PinTone.pickup
        ? Container(width: 22, height: 22, decoration: BoxDecoration(color: c.surface, shape: BoxShape.circle, border: Border.all(color: ink, width: 6)))
        : Container(width: 20, height: 20, decoration: BoxDecoration(color: ink, borderRadius: BorderRadius.circular(4), border: Border.all(color: c.surface, width: 3)));
    return AnimatedSlide(
      duration: AnbessaMotion.of(context, AnbessaMotion.base),
      curve: AnbessaMotion.emphasized,
      offset: lifted ? const Offset(0, -0.25) : Offset.zero,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          head,
          Container(width: 3, height: 14, color: ink),
          AnimatedContainer(
            duration: AnbessaMotion.of(context, AnbessaMotion.base),
            width: lifted ? 10 : 6,
            height: 3,
            decoration: BoxDecoration(color: Color(lifted ? 0x22000000 : 0x44000000), borderRadius: BorderRadius.circular(3)),
          ),
        ],
      ),
    );
  }
}

@immutable
class DriverMarkerData {
  const DriverMarkerData({required this.position, this.heading, required this.stale, this.onTrip = true});
  final LatLng position;
  final double? heading;
  /// no ping for 20 s
  final bool stale;
  final bool onTrip;
}

/// The car: the kit's white top-down car, turned to its heading (grey when stale). Adds the map's
/// rotation so its heading stays true when the camera turns.
class CarMarker extends StatelessWidget {
  const CarMarker({super.key, required this.heading, this.stale = false, this.onTrip = true, this.mapRotation = 0, this.size = 40});
  final double heading;
  final bool stale;
  final bool onTrip;
  final double mapRotation;
  /// the box the car is drawn in (the car is about half as wide)
  final double size;
  @override
  Widget build(BuildContext context) => Semantics(
        label: 'driver',
        child: Center(child: TopDownCar(width: size * 0.55, heading: heading + mapRotation, body: stale ? const Color(0xFFB9BCC2) : Colors.white)),
      );
}

/// A small anonymous car around the rider: the same white top-down car, smaller.
class NearbyCarGlyph extends StatelessWidget {
  const NearbyCarGlyph({super.key, this.heading, this.mapRotation = 0});
  final double? heading;
  final double mapRotation;
  @override
  Widget build(BuildContext context) => FadeSlideIn(offset: 0, child: Center(child: TopDownCar(width: 18, heading: (heading ?? 0) + mapRotation)));
}

/// Keep the old name working for screens not yet rewritten.
class DriverMarker extends StatelessWidget {
  const DriverMarker({super.key, required this.data});
  final DriverMarkerData data;
  @override
  Widget build(BuildContext context) => CarMarker(heading: data.heading ?? 0, stale: data.stale, onTrip: data.onTrip);
}

/// The pin at the map centre while dragging to pick a place.
class CenterPin extends StatelessWidget {
  const CenterPin({super.key, this.tone = PinTone.pickup, this.lifted = false});
  final PinTone tone;
  final bool lifted;
  @override
  Widget build(BuildContext context) {
    final size = tone == PinTone.pickup ? avatarPinSize(46) : destinationPinSize(36);
    final pin = tone == PinTone.pickup ? const MapAvatarPin(name: '', diameter: 46) : const DestinationPin(diameter: 36);
    return IgnorePointer(
      child: Center(
        child: Padding(
          // the tip on the centre
          padding: EdgeInsets.only(bottom: size.height),
          child: AnimatedSlide(duration: AnbessaMotion.of(context, AnbessaMotion.base), curve: AnbessaMotion.emphasized, offset: lifted ? const Offset(0, -0.2) : Offset.zero, child: pin),
        ),
      ),
    );
  }
}

LatLng latLngOf(double lat, double lng) => LatLng(lat, lng);
LatLng placeLatLng(TripPlace p) => LatLng(p.lat, p.lng);
