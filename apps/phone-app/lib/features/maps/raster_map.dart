// The raster engine (flutter_map): the map on the desktop and in tests. Flat or satellite; 3D
// needs the vector engine and shows flat here. Same AnbessaMap interface and the same
// CameraDirector as the vector engine; markers are Flutter widgets, and the animated car and
// nearby cars are drawn by layers that listen to their animators (no screen rebuilds). Gaps:
// no tilt, no native layers.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_map_animations/flutter_map_animations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart' show LatLng;
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../config/client_config_provider.dart';
import 'anbessa_map.dart';
import 'callouts.dart';
import 'map_mode.dart';
import 'map_styles.dart';
import 'map_tiles.dart';
import 'route_layer.dart';
import 'scene/camera_director.dart';
import 'scene/map_binding.dart';

LatLng _ll(GeoPoint p) => LatLng(p.lat, p.lng);

class RasterMap extends ConsumerStatefulWidget {
  const RasterMap({super.key, required this.spec});
  final AnbessaMap spec;
  @override
  ConsumerState<RasterMap> createState() => _RasterMapState();
}

class _RasterMapState extends ConsumerState<RasterMap> with TickerProviderStateMixin {
  late final AnimatedMapController _anim = AnimatedMapController(vsync: this, duration: AnbessaMotion.camera, curve: AnbessaMotion.emphasized, cancelPreviousAnimations: true);
  MapController get _ctrl => _anim.mapController;
  late final _RasterPort _port = _RasterPort(this);
  late final MapBinding _binding = MapBinding(_port);
  Timer? _moveDebounce;
  bool _ready = false;
  Size? _size;

  AnbessaMap get w => widget.spec;

  @override
  void initState() {
    super.initState();
    _binding.sync(w, ready: false);
  }

  @override
  void didUpdateWidget(covariant RasterMap oldWidget) {
    super.didUpdateWidget(oldWidget);
    _binding.sync(w, ready: _ready);
  }

  @override
  void dispose() {
    _moveDebounce?.cancel();
    _binding.dispose();
    _anim.dispose();
    super.dispose();
  }

  Widget _withBottom(Widget Function(double bottom) builder) {
    final sheet = w.sheetHeight;
    if (sheet == null) return builder(w.bottomInset);
    return ValueListenableBuilder<double>(valueListenable: sheet, builder: (_, h, _) => builder(h));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final city = ref.watch(currentCityProvider);
    final mode = ref.watch(effectiveMapModeProvider);
    final tiles = ref.watch(tileStyleProvider);
    final satellite = mode == MapMode.satellite;
    final initial = w.center ?? w.subject ?? (w.fit.isNotEmpty ? w.fit.first : LatLng(city.bbox.centerLat, city.bbox.centerLng));
    final routes = w.allRoutes;
    final me = w.mePoseOrPoint;
    final rotating = w.follow == FollowMode.driverBearing;
    // the controller has no camera until flutter_map has rendered once
    final rot = _ready ? _ctrl.camera.rotation : 0.0;
    final pins = pinsFor(w, (ctx) => MapCamera.maybeOf(ctx)?.rotation ?? 0);
    final car = w.driverCar;
    final nearby = w.nearbyCars;
    return LayoutBuilder(
      builder: (context, box) {
        _size = box.biggest;
        return Stack(
          children: [
            FlutterMap(
              mapController: _ctrl,
              options: MapOptions(
                initialCenter: initial,
                initialZoom: w.follow != FollowMode.none ? w.followZoom : w.zoom,
                minZoom: 9,
                maxZoom: 19,
                interactionOptions: InteractionOptions(flags: w.interactive ? (rotating ? InteractiveFlag.all : InteractiveFlag.all & ~InteractiveFlag.rotate) : InteractiveFlag.none),
                onTap: w.onTap == null ? null : (_, p) => w.onTap!(p),
                onMapEvent: (e) {
                  if (e.source == MapEventSource.dragStart || e.source == MapEventSource.multiFingerGestureStart || e.source == MapEventSource.doubleTap || e.source == MapEventSource.scrollWheel) {
                    _binding.director.onUserGesture();
                    w.onUserGesture?.call();
                  }
                  if (e is MapEventRotate || e is MapEventRotateEnd) setState(() {});
                  if (w.onMove != null && (e is MapEventMoveEnd || e is MapEventFlingAnimationEnd)) {
                    _moveDebounce?.cancel();
                    _moveDebounce = Timer(const Duration(milliseconds: 250), () => w.onMove!(_ctrl.camera.center));
                  }
                },
                onMapReady: () {
                  _ready = true;
                  _binding.director.setLook(basePitch: 0, threeD: false, reduceMotion: MediaQuery.disableAnimationsOf(context));
                  _binding.sync(w, ready: true);
                },
                backgroundColor: c.canvas,
              ),
              children: [
                _tileLayer(context, satellite ? (url: satelliteTiles, subdomains: const <String>[], attribution: satelliteAttribution, retina: false, darken: false) : tiles),
                if (me?.accuracy != null && me!.accuracy! > 15)
                  CircleLayer(circles: [
                    CircleMarker(point: me.position, radius: me.accuracy!, useRadiusInMeter: true, color: c.info.withValues(alpha: 0.12), borderColor: c.info.withValues(alpha: 0.35), borderStrokeWidth: 1),
                  ]),
                if (routes.isNotEmpty) PolylineLayer(polylines: routePolylines(c, routes, onImagery: satellite)),
                if (nearby != null)
                  ValueListenableBuilder<List<NearbyCarFrame>>(
                    valueListenable: nearby,
                    builder: (context, cars, _) => MarkerLayer(
                      rotate: true,
                      markers: [
                        for (final f in cars)
                          Marker(
                            key: ValueKey('nearby:${f.id}'),
                            point: LatLng(f.lat, f.lng),
                            width: 26,
                            height: 26,
                            child: Opacity(opacity: f.opacity.clamp(0.0, 1.0), child: Builder(builder: (ctx) => NearbyCarGlyph(heading: f.bearing, mapRotation: MapCamera.maybeOf(ctx)?.rotation ?? 0))),
                          ),
                        if (cars.isNotEmpty && w.nearbyLabel != null)
                          Marker(point: LatLng(cars.first.lat, cars.first.lng), width: 240, height: 34, alignment: const Alignment(0, -1.6), child: Center(child: MapCalloutChip(callout: MapCallout(point: LatLng(cars.first.lat, cars.first.lng), label: w.nearbyLabel!, tone: Tone.amber)))),
                      ],
                    ),
                  ),
                MarkerLayer(
                  rotate: true,
                  markers: [for (final p in pins) Marker(point: p.point, width: p.size.width, height: p.size.height, alignment: _markerAlignment(p.alignment), child: p.child)],
                ),
                if (car != null)
                  ValueListenableBuilder<AnimatedPose?>(
                    valueListenable: car,
                    builder: (context, p, _) => p == null
                        ? const SizedBox.shrink()
                        : MarkerLayer(
                            rotate: true,
                            markers: [
                              Marker(
                                point: LatLng(p.lat, p.lng),
                                width: 44,
                                height: 44,
                                child: Builder(builder: (ctx) => CarMarker(heading: p.heading, stale: p.stale, mapRotation: MapCamera.maybeOf(ctx)?.rotation ?? 0)),
                              ),
                              if (w.driverCarLabel != null)
                                Marker(point: LatLng(p.lat, p.lng), width: 240, height: 34, alignment: const Alignment(0, -1.9), child: Center(child: MapCalloutChip(callout: MapCallout(point: LatLng(p.lat, p.lng), label: w.driverCarLabel!, tone: Tone.amber)))),
                            ],
                          ),
                  )
                else if (w.driverCarLabel != null && w.carNow != null)
                  MarkerLayer(markers: [
                    Marker(point: LatLng(w.carNow!.lat, w.carNow!.lng), width: 240, height: 34, alignment: const Alignment(0, -1.9), child: Center(child: MapCalloutChip(callout: MapCallout(point: LatLng(w.carNow!.lat, w.carNow!.lng), label: w.driverCarLabel!, tone: Tone.amber)))),
                  ]),
              ],
            ),
            _withBottom((bottom) => Positioned(left: 6, right: 72, bottom: bottom + 4, child: MapCredit(satellite ? satelliteAttribution : tiles.attribution))),
            if (w.interactive)
              _withBottom(
                (bottom) => Positioned(
                  left: 0,
                  right: 0,
                  bottom: bottom + 16,
                  child: Center(
                    child: ValueListenableBuilder<bool>(
                      valueListenable: _binding.director.showRecenter,
                      builder: (_, show, _) => RecenterPill(label: context.l10n.recenter, visible: show, onTap: _binding.recenter),
                    ),
                  ),
                ),
              ),
            if (w.showControls && w.interactive)
              _withBottom(
                (bottom) => Positioned(
                  right: 12,
                  bottom: bottom + 12,
                  child: ValueListenableBuilder<bool>(
                    valueListenable: _binding.director.showRecenter,
                    builder: (_, free, _) => MapControls(
                      rotation: rotating ? 0 : rot,
                      onResetNorth: _anim.animatedRotateReset,
                      showRecenter: w.follow != FollowMode.none || w.fit.isNotEmpty || w.onRecenter != null,
                      recenterActive: w.follow != FollowMode.none && !free,
                      onRecenter: _binding.recenter,
                      showModeSwitch: w.showModeSwitch,
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }

  /// One tile layer; dark mode without its own tiles puts one colour filter over all of them.
  Widget _tileLayer(BuildContext context, TileStyle tiles) {
    final layer = TileLayer(
      key: ValueKey('${tiles.url}|${tiles.darken}'),
      urlTemplate: tiles.url,
      subdomains: tiles.subdomains,
      retinaMode: tiles.retina && MediaQuery.devicePixelRatioOf(context) > 1.5,
      userAgentPackageName: 'com.anbessa.phone_app',
      maxNativeZoom: 19,
      errorTileCallback: (_, _, _) => ref.read(mapTilesDownProvider.notifier).set(true),
    );
    return tiles.darken ? darkModeTilesContainerBuilder(context, layer) : layer;
  }
}

/// flutter_map's marker alignment is where the point sits relative to the widget, inverted.
Alignment _markerAlignment(Alignment a) => Alignment(-a.x, -a.y);

/// The director's hands on the flutter_map camera. flutter_map moves are cheap Dart calls, so
/// follow moves happen on every subject change instead of chained animations.
class _RasterPort implements CameraPort {
  _RasterPort(this._s);
  final _RasterMapState _s;

  @override
  Size? get viewport => _s._size;

  @override
  double get bearing => _s._ready ? -_s._ctrl.camera.rotation : 0;

  @override
  bool get followsEveryFrame => true;

  Offset _offset(EdgeInsets p) => Offset((p.left - p.right) / 2, (p.top - p.bottom) / 2);

  @override
  Future<void> moveTo({required GeoPoint center, required double zoom, required double bearing, required double pitch, required EdgeInsets padding, required Duration duration}) async {
    if (!_s._ready || !_s.mounted) return;
    final ctrl = _s._ctrl;
    final rotation = -bearing;
    if ((ctrl.camera.rotation - rotation).abs() > 0.5) ctrl.rotate(rotation);
    if (duration <= Duration.zero) {
      ctrl.move(_ll(center), zoom, offset: _offset(padding));
      return;
    }
    await _s._anim.animateTo(dest: _ll(center), zoom: zoom, offset: _offset(padding), duration: duration);
  }

  @override
  Future<void> fit(List<GeoPoint> points, {required EdgeInsets padding, required double bearing, required double pitch, required Duration duration, double maxZoom = 17, double singleZoom = 15}) async {
    if (!_s._ready || !_s.mounted || points.isEmpty) return;
    final pts = [for (final p in points) _ll(p)];
    final fit = pts.length == 1
        ? CameraFit.bounds(bounds: LatLngBounds(pts.first, pts.first), padding: padding, maxZoom: singleZoom, minZoom: singleZoom)
        : CameraFit.bounds(bounds: LatLngBounds.fromPoints(pts), padding: padding, maxZoom: maxZoom);
    if (duration <= Duration.zero) {
      _s._ctrl.fitCamera(fit);
      return;
    }
    await _s._anim.animatedFitCamera(cameraFit: fit, duration: duration);
  }
}
