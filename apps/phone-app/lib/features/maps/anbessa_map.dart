// The map (flutter_map, raster tiles). It draws routes, pins, the cars and the person, keeps its
// subject inside the part not covered by sheets and banners, animates every camera move, and can
// follow the car (north up, or turned the way the car is going for the driver's navigation).
// The older parameters (`fit`, `pickup`, `dropoff`, `driver`, `me` as a point, `line`) still work.

import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_map_animations/flutter_map_animations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart' show LatLng;
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../../core/state.dart';
import '../config/client_config_provider.dart';
import 'callouts.dart';
import 'fit.dart';
import 'map_tiles.dart';
import 'marker_animator.dart';
import 'me_marker.dart';
import 'route_layer.dart';

export 'callouts.dart' show MapCallout;
export 'marker_animator.dart' show AnimatedPose;
export 'me_marker.dart' show MePose;
export 'route_layer.dart' show RouteLine, RouteKind;

/// Tiles failed to load (the self-hosted stack is down, or no network).
final mapTilesDownProvider = valueProvider<bool>(false);

enum FollowMode { none, me, driver, driverBearing }

/// A car around the rider (anonymous).
@immutable
class CarPose {
  const CarPose({required this.position, this.heading});
  final LatLng position;
  final double? heading;
}

class AnbessaMap extends ConsumerStatefulWidget {
  const AnbessaMap({
    super.key,
    this.fit = const [],
    this.center,
    this.zoom = 13,
    this.pickup,
    this.dropoff,
    this.driver,
    this.driverPose,
    this.me,
    this.mePose,
    this.line = const [],
    this.routes = const [],
    this.cars = const [],
    this.callouts = const [],
    this.topInset = 0,
    this.bottomInset = 0,
    this.follow = FollowMode.none,
    this.followZoom = 16,
    this.showControls = true,
    this.onUserGesture,
    this.onTap,
    this.onMove,
    this.controller,
    this.mapController,
    this.padding = const EdgeInsets.all(48),
    this.interactive = true,
    this.children = const [],
  });

  /// Points to keep in view. Empty: [center] or the city.
  final List<LatLng> fit;
  final LatLng? center;
  final double zoom;
  final LatLng? pickup;
  final LatLng? dropoff;
  /// a static car (older screens); prefer [driverPose]
  final DriverMarkerData? driver;
  /// the animated car (from a [MarkerAnimator])
  final AnimatedPose? driverPose;
  /// the person's position as a point (older screens); prefer [mePose]
  final LatLng? me;
  final MePose? mePose;
  /// a straight dotted line (older screens); prefer [routes]
  final List<LatLng> line;
  final List<RouteLine> routes;
  final List<CarPose> cars;
  final List<MapCallout> callouts;
  /// pixels covered at the top (banners) and bottom (the sheet)
  final double topInset;
  final double bottomInset;
  final FollowMode follow;
  final double followZoom;
  final bool showControls;
  /// the person panned or zoomed; screens use it to drop follow mode
  final VoidCallback? onUserGesture;
  final void Function(LatLng)? onTap;
  /// the map centre after the person dragged it (drag-to-pick)
  final void Function(LatLng)? onMove;
  final AnimatedMapController? controller;
  /// a plain controller to drive (older screens); the map animates through it
  final MapController? mapController;
  final EdgeInsets padding;
  final bool interactive;
  final List<Widget> children;

  @override
  ConsumerState<AnbessaMap> createState() => AnbessaMapState();
}

class AnbessaMapState extends ConsumerState<AnbessaMap> with TickerProviderStateMixin {
  late final AnimatedMapController _anim = widget.controller ?? AnimatedMapController(vsync: this, mapController: widget.mapController, duration: AnbessaMotion.camera, curve: AnbessaMotion.emphasized);
  MapController get _ctrl => _anim.mapController;
  List<LatLng> _lastFit = const [];
  Timer? _moveDebounce;
  Timer? _refit;
  bool _ready = false;
  bool _userBroke = false;
  double _rotation = 0;

  @override
  void didUpdateWidget(covariant AnbessaMap oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.follow != widget.follow) _userBroke = false;
    final insetsChanged = oldWidget.topInset != widget.topInset || oldWidget.bottomInset != widget.bottomInset;
    if (widget.follow == FollowMode.none || _userBroke) {
      if (widget.fit.isNotEmpty && (!sameLatLngs(widget.fit, _lastFit) || insetsChanged)) {
        _refit?.cancel();
        _refit = Timer(insetsChanged && sameLatLngs(widget.fit, _lastFit) ? const Duration(milliseconds: 200) : Duration.zero, () => _fitTo(widget.fit));
      }
    } else {
      _followTick();
    }
  }

  LatLng? get _subject => switch (widget.follow) {
        FollowMode.me => widget.mePose?.position ?? widget.me,
        FollowMode.driver || FollowMode.driverBearing => widget.driverPose == null ? widget.driver?.position : LatLng(widget.driverPose!.lat, widget.driverPose!.lng),
        FollowMode.none => null,
      };

  void _followTick() {
    if (!_ready || _userBroke) return;
    final s = _subject;
    if (s == null) return;
    final bearing = widget.follow == FollowMode.driverBearing ? (widget.driverPose?.heading ?? widget.driver?.heading ?? 0) : 0.0;
    // keep the car in the lower middle of the free area while navigating; centred otherwise
    final free = _freeArea();
    final offsetY = widget.follow == FollowMode.driverBearing ? free.height * 0.18 : 0.0;
    _rotation = widget.follow == FollowMode.driverBearing ? -bearing : 0;
    // tiny moves every frame: no animation, or the camera lags the car
    _ctrl.move(s, widget.followZoom, offset: Offset(0, offsetY + (widget.topInset - widget.bottomInset) / 2));
    if ((_ctrl.camera.rotation - _rotation).abs() > 0.5) _ctrl.rotate(_rotation);
  }

  Rect _freeArea() {
    final size = context.size ?? const Size(360, 640);
    return Rect.fromLTRB(0, widget.topInset, size.width, size.height - widget.bottomInset);
  }

  void _fitTo(List<LatLng> pts, {bool animate = true}) {
    if (!mounted || !_ready || pts.isEmpty) return;
    _lastFit = List.of(pts);
    final fit = fitWithInsets(pts, top: widget.topInset, bottom: widget.bottomInset, side: widget.padding.left);
    if (!animate || MediaQuery.disableAnimationsOf(context)) {
      _ctrl.fitCamera(fit);
    } else {
      _anim.animatedFitCamera(cameraFit: fit, rotation: 0);
    }
  }

  /// Screens call this from the recenter control.
  void recenter() {
    _userBroke = false;
    widget.onUserGesture?.call();
    if (widget.follow != FollowMode.none) {
      final s = _subject;
      if (s != null) _anim.animateTo(dest: s, zoom: widget.followZoom, rotation: widget.follow == FollowMode.driverBearing ? _rotation : 0);
      return;
    }
    if (widget.fit.isNotEmpty) _fitTo(widget.fit);
  }

  void resetNorth() => _anim.animatedRotateReset();

  @override
  void dispose() {
    _moveDebounce?.cancel();
    _refit?.cancel();
    if (widget.controller == null && widget.mapController == null) _anim.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final l = context.l10n;
    final city = ref.watch(currentCityProvider);
    final tiles = ref.watch(tileStyleProvider);
    final initial = widget.center ?? _subject ?? (widget.fit.isNotEmpty ? widget.fit.first : LatLng(city.bbox.centerLat, city.bbox.centerLng));
    final routes = [
      ...widget.routes,
      if (widget.line.length >= 2) RouteLine(widget.line, kind: RouteKind.straight),
    ];
    final me = widget.mePose ?? (widget.me == null ? null : MePose(position: widget.me!));
    final driverPose = widget.driverPose;
    final driverStatic = widget.driver;
    final rotating = widget.follow == FollowMode.driverBearing;
    // the controller has no camera until flutter_map has rendered once
    final rot = _ready ? _ctrl.camera.rotation : 0.0;
    return Stack(
      children: [
        FlutterMap(
          mapController: _ctrl,
          options: MapOptions(
            initialCenter: initial,
            initialZoom: widget.zoom,
            minZoom: 9,
            maxZoom: 19,
            interactionOptions: InteractionOptions(flags: widget.interactive ? (rotating ? InteractiveFlag.all : InteractiveFlag.all & ~InteractiveFlag.rotate) : InteractiveFlag.none),
            onTap: widget.onTap == null ? null : (_, p) => widget.onTap!(p),
            onMapEvent: (e) {
              if (e.source == MapEventSource.dragStart || e.source == MapEventSource.multiFingerGestureStart || e.source == MapEventSource.doubleTap || e.source == MapEventSource.scrollWheel) {
                if (widget.follow != FollowMode.none && !_userBroke) {
                  _userBroke = true;
                  widget.onUserGesture?.call();
                  setState(() {});
                }
              }
              if (e is MapEventRotate || e is MapEventRotateEnd) setState(() {});
              if (widget.onMove != null && (e is MapEventMoveEnd || e is MapEventFlingAnimationEnd)) {
                _moveDebounce?.cancel();
                _moveDebounce = Timer(const Duration(milliseconds: 250), () => widget.onMove!(_ctrl.camera.center));
              }
            },
            onMapReady: () {
              _ready = true;
              if (widget.follow != FollowMode.none && _subject != null) {
                _followTick();
              } else if (widget.fit.isNotEmpty) {
                _fitTo(widget.fit, animate: false);
              }
            },
            backgroundColor: c.canvas,
          ),
          children: [
            TileLayer(
              key: ValueKey(tiles.url),
              urlTemplate: tiles.url,
              subdomains: tiles.subdomains,
              retinaMode: tiles.retina && MediaQuery.devicePixelRatioOf(context) > 1.5,
              userAgentPackageName: 'com.anbessa.phone_app',
              maxNativeZoom: 19,
              errorTileCallback: (_, _, _) => ref.read(mapTilesDownProvider.notifier).set(true),
            ),
            if (me != null) meAccuracyLayer(c, me),
            if (routes.isNotEmpty) PolylineLayer(polylines: routePolylines(c, routes)),
            MarkerLayer(
              rotate: true,
              markers: [
                for (final car in widget.cars) Marker(point: car.position, width: 30, height: 30, child: NearbyCarGlyph(heading: car.heading, mapRotation: rot)),
                if (widget.pickup != null) Marker(point: widget.pickup!, width: 40, height: 48, alignment: Alignment.topCenter, child: const PinMarker(tone: PinTone.amber)),
                if (widget.dropoff != null) Marker(point: widget.dropoff!, width: 40, height: 48, alignment: Alignment.topCenter, child: const PinMarker(tone: PinTone.ink)),
                if (me != null) meMarker(me),
                if (driverPose != null)
                  Marker(point: LatLng(driverPose.lat, driverPose.lng), width: 48, height: 48, child: CarMarker(heading: driverPose.heading, stale: driverPose.stale, mapRotation: rot))
                else if (driverStatic != null)
                  Marker(point: driverStatic.position, width: 48, height: 48, child: CarMarker(heading: driverStatic.heading ?? 0, stale: driverStatic.stale, onTrip: driverStatic.onTrip, mapRotation: rot)),
                for (final m in widget.callouts) calloutMarker(c, m),
              ],
            ),
            ...widget.children,
          ],
        ),
        // the tile credit, small and never wider than the map (flutter_map's own widget overflows at large text)
        Positioned(
          left: 6,
          right: 72,
          bottom: widget.bottomInset + 4,
          child: IgnorePointer(
            child: Align(
              alignment: Alignment.bottomLeft,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(color: c.surface.withValues(alpha: 0.75), borderRadius: BorderRadius.circular(4)),
                child: Text(tiles.attribution, maxLines: 1, overflow: TextOverflow.ellipsis, textScaler: TextScaler.noScaling, style: TextStyle(fontSize: 9, color: c.muted)),
              ),
            ),
          ),
        ),
        if (widget.showControls && widget.interactive)
          Positioned(
            right: 12,
            bottom: widget.bottomInset + 12,
            child: MapControlColumn(
              children: [
                if (rot.abs() > 0.5 && !rotating)
                  MapControlButton(
                    icon: Icons.explore,
                    tooltip: l.resetNorth,
                    onTap: resetNorth,
                    child: Transform.rotate(angle: rot * pi / 180, child: Icon(Icons.navigation, color: c.danger, size: 22)),
                  ),
                if (widget.follow != FollowMode.none || widget.fit.isNotEmpty)
                  MapControlButton(icon: widget.follow != FollowMode.none ? Icons.my_location : Icons.center_focus_strong, tooltip: l.recenter, active: widget.follow != FollowMode.none && !_userBroke, onTap: recenter),
              ],
            ),
          ),
      ],
    );
  }
}

enum PinTone { amber, ink }

/// A pin whose tip is the point (align the marker to the top).
class PinMarker extends StatelessWidget {
  const PinMarker({super.key, required this.tone, this.lifted = false});
  final PinTone tone;
  /// raised while the map is being dragged under it
  final bool lifted;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final color = tone == PinTone.amber ? c.accent : c.text;
    return AnimatedSlide(
      duration: AnbessaMotion.of(context, AnbessaMotion.base),
      curve: AnbessaMotion.emphasized,
      offset: lifted ? const Offset(0, -0.25) : Offset.zero,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 20,
            height: 20,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 3), boxShadow: const [BoxShadow(color: Color(0x33000000), blurRadius: 4, offset: Offset(0, 2))]),
          ),
          Container(width: 2, height: 14, color: color),
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

/// The car: a rotated glyph, amber on a trip, grey when stale. Counter-rotates the map's rotation
/// so its heading stays true when the camera turns.
class CarMarker extends StatelessWidget {
  const CarMarker({super.key, required this.heading, this.stale = false, this.onTrip = true, this.mapRotation = 0, this.size = 44});
  final double heading;
  final bool stale;
  final bool onTrip;
  final double mapRotation;
  final double size;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final color = stale ? c.faint : (onTrip ? c.accent : c.success);
    return Semantics(
      label: 'driver',
      child: Transform.rotate(
        angle: (heading + mapRotation) * pi / 180,
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 3), boxShadow: const [BoxShadow(color: Color(0x44000000), blurRadius: 6, offset: Offset(0, 2))]),
          child: Icon(Icons.navigation, color: Colors.white, size: size * 0.5),
        ),
      ),
    );
  }
}

/// A small anonymous car around the rider.
class NearbyCarGlyph extends StatelessWidget {
  const NearbyCarGlyph({super.key, this.heading, this.mapRotation = 0});
  final double? heading;
  final double mapRotation;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return FadeSlideIn(
      offset: 0,
      child: Transform.rotate(
        angle: ((heading ?? 0) + mapRotation) * pi / 180,
        child: Container(
          decoration: BoxDecoration(color: c.surface, shape: BoxShape.circle, boxShadow: AnbessaElevation.card(c.brightness)),
          child: Icon(Icons.navigation_rounded, color: c.text2, size: 16),
        ),
      ),
    );
  }
}

/// Keep the old name working for screens not yet rewritten.
class DriverMarker extends StatelessWidget {
  const DriverMarker({super.key, required this.data});
  final DriverMarkerData data;
  @override
  Widget build(BuildContext context) => CarMarker(heading: data.heading ?? 0, stale: data.stale, onTrip: data.onTrip);
}

/// Something at the map centre while dragging to pick a place.
class CenterPin extends StatelessWidget {
  const CenterPin({super.key, this.tone = PinTone.amber, this.lifted = false});
  final PinTone tone;
  final bool lifted;
  @override
  Widget build(BuildContext context) => IgnorePointer(
        child: Center(child: Padding(padding: const EdgeInsets.only(bottom: 37), child: PinMarker(tone: tone, lifted: lifted))),
      );
}

LatLng latLngOf(double lat, double lng) => LatLng(lat, lng);
LatLng placeLatLng(TripPlace p) => LatLng(p.lat, p.lng);
LatLngBounds boundsOf(List<LatLng> pts) => LatLngBounds.fromPoints(pts);
