// The raster engine (flutter_map): the map on the desktop and in tests. Flat or satellite; 3D
// needs the vector engine and shows flat here.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_map_animations/flutter_map_animations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart' show LatLng;
import 'package:ride_app_core/ride_app_core.dart';
import '../config/client_config_provider.dart';
import 'anbessa_map.dart';
import 'fit.dart';
import 'map_mode.dart';
import 'map_styles.dart';
import 'map_tiles.dart';
import 'route_layer.dart';

class RasterMap extends ConsumerStatefulWidget {
  const RasterMap({super.key, required this.spec});
  final AnbessaMap spec;
  @override
  ConsumerState<RasterMap> createState() => _RasterMapState();
}

class _RasterMapState extends ConsumerState<RasterMap> with TickerProviderStateMixin {
  late final AnimatedMapController _anim = AnimatedMapController(vsync: this, duration: AnbessaMotion.camera, curve: AnbessaMotion.emphasized);
  MapController get _ctrl => _anim.mapController;
  List<LatLng> _lastFit = const [];
  Timer? _moveDebounce;
  Timer? _refit;
  bool _ready = false;
  bool _userBroke = false;
  double _rotation = 0;

  AnbessaMap get w => widget.spec;

  @override
  void didUpdateWidget(covariant RasterMap oldWidget) {
    super.didUpdateWidget(oldWidget);
    final old = oldWidget.spec;
    if (old.follow != w.follow) _userBroke = false;
    final insetsChanged = old.topInset != w.topInset || old.bottomInset != w.bottomInset;
    if (w.follow == FollowMode.none || _userBroke) {
      if (w.fit.isNotEmpty && (!sameLatLngs(w.fit, _lastFit) || insetsChanged)) {
        _refit?.cancel();
        _refit = Timer(insetsChanged && sameLatLngs(w.fit, _lastFit) ? const Duration(milliseconds: 200) : Duration.zero, () => _fitTo(w.fit));
      }
    } else {
      _followTick();
    }
  }

  void _followTick() {
    if (!_ready || _userBroke) return;
    final s = w.subject;
    if (s == null) return;
    final bearing = w.follow == FollowMode.driverBearing ? w.subjectHeading : 0.0;
    // keep the car in the lower middle of the free area while navigating; centred otherwise
    final size = context.size ?? const Size(360, 640);
    final freeHeight = size.height - w.topInset - w.bottomInset;
    final offsetY = w.follow == FollowMode.driverBearing ? freeHeight * 0.18 : 0.0;
    _rotation = w.follow == FollowMode.driverBearing ? -bearing : 0;
    // tiny moves every frame: no animation, or the camera lags the car
    _ctrl.move(s, w.followZoom, offset: Offset(0, offsetY + (w.topInset - w.bottomInset) / 2));
    if ((_ctrl.camera.rotation - _rotation).abs() > 0.5) _ctrl.rotate(_rotation);
  }

  void _fitTo(List<LatLng> pts, {bool animate = true}) {
    if (!mounted || !_ready || pts.isEmpty) return;
    _lastFit = List.of(pts);
    final fit = fitWithInsets(pts, top: w.topInset, bottom: w.bottomInset, side: w.padding.left);
    if (!animate || MediaQuery.disableAnimationsOf(context)) {
      _ctrl.fitCamera(fit);
    } else {
      _anim.animatedFitCamera(cameraFit: fit, rotation: 0);
    }
  }

  void _recenter() {
    _userBroke = false;
    w.onRecenter?.call();
    if (w.follow != FollowMode.none) {
      final s = w.subject;
      if (s != null) _anim.animateTo(dest: s, zoom: w.followZoom, rotation: w.follow == FollowMode.driverBearing ? _rotation : 0);
      return;
    }
    if (w.fit.isNotEmpty) _fitTo(w.fit);
    setState(() {});
  }

  @override
  void dispose() {
    _moveDebounce?.cancel();
    _refit?.cancel();
    _anim.dispose();
    super.dispose();
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
    final pins = pinsFor(w, (_) => rot);
    return Stack(
      children: [
        FlutterMap(
          mapController: _ctrl,
          options: MapOptions(
            initialCenter: initial,
            initialZoom: w.zoom,
            minZoom: 9,
            maxZoom: 19,
            interactionOptions: InteractionOptions(flags: w.interactive ? (rotating ? InteractiveFlag.all : InteractiveFlag.all & ~InteractiveFlag.rotate) : InteractiveFlag.none),
            onTap: w.onTap == null ? null : (_, p) => w.onTap!(p),
            onMapEvent: (e) {
              if (e.source == MapEventSource.dragStart || e.source == MapEventSource.multiFingerGestureStart || e.source == MapEventSource.doubleTap || e.source == MapEventSource.scrollWheel) {
                if (w.follow != FollowMode.none && !_userBroke) {
                  _userBroke = true;
                  setState(() {});
                }
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
              if (w.follow != FollowMode.none && w.subject != null) {
                _followTick();
              } else if (w.fit.isNotEmpty) {
                _fitTo(w.fit, animate: false);
              }
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
            MarkerLayer(
              rotate: true,
              markers: [for (final p in pins) Marker(point: p.point, width: p.size.width, height: p.size.height, alignment: _markerAlignment(p.alignment), child: p.child)],
            ),
          ],
        ),
        Positioned(left: 6, right: 72, bottom: w.bottomInset + 4, child: MapCredit(satellite ? satelliteAttribution : tiles.attribution)),
        if (w.showControls && w.interactive)
          Positioned(
            right: 12,
            bottom: w.bottomInset + 12,
            child: MapControls(
              rotation: rotating ? 0 : rot,
              onResetNorth: _anim.animatedRotateReset,
              showRecenter: w.follow != FollowMode.none || w.fit.isNotEmpty || w.onRecenter != null,
              recenterActive: w.follow != FollowMode.none && !_userBroke,
              onRecenter: _recenter,
              showModeSwitch: w.showModeSwitch,
            ),
          ),
      ],
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
