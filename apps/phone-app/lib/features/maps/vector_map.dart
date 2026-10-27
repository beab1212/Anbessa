// The vector engine (MapLibre): the map on Android and iOS. Flat, 3D (tilted, buildings extruded)
// or satellite, following the theme. Pins are Flutter widgets placed over the map (the same ones
// the raster engine draws); routes are native line layers.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart' show LatLng;
import 'package:maplibre/maplibre.dart' as ml;
import 'package:ride_app_core/ride_app_core.dart';
import '../config/client_config_provider.dart';
import 'anbessa_map.dart';
import 'fit.dart';
import 'map_mode.dart';
import 'map_styles.dart';
import 'route_layer.dart';

ml.Geographic _geo(LatLng p) => ml.Geographic(lon: p.longitude, lat: p.latitude);
LatLng _latLng(ml.Geographic g) => LatLng(g.lat, g.lon);

/// The camera never zooms closer than this when fitting points (two pins in the same building).
const _maxFitZoom = 17.0;

class VectorMap extends ConsumerStatefulWidget {
  const VectorMap({super.key, required this.spec});
  final AnbessaMap spec;
  @override
  ConsumerState<VectorMap> createState() => _VectorMapState();
}

class _VectorMapState extends ConsumerState<VectorMap> {
  ml.MapController? _ctrl;
  ml.StyleController? _styleCtrl;
  /// the style the map has (or is loading); a different one is set after the frame
  String? _style;
  MapMode? _mode;
  bool _userBroke = false;
  bool _gesture = false;
  List<LatLng> _lastFit = const [];
  Timer? _refit;
  DateTime _lastFollow = DateTime(0);
  // The plugin compares layers by identity, so they're rebuilt only when the routes change.
  List<ml.Layer> _layers = const [];
  String? _layersKey;

  AnbessaMap get w => widget.spec;

  Duration get _cameraTime => MediaQuery.disableAnimationsOf(context) ? Duration.zero : AnbessaMotion.camera;

  // ── camera ──────────────────────────────────────────────────────────────────

  Future<void> _fitTo(List<LatLng> pts) async {
    final c = _ctrl;
    if (c == null || pts.isEmpty || !mounted) return;
    _lastFit = List.of(pts);
    final pad = EdgeInsets.fromLTRB(w.padding.left, w.topInset + 48, w.padding.right, w.bottomInset + 32);
    final pitch = pitchFor(_mode ?? MapMode.flat);
    if (pts.length == 1) {
      await c.animateCamera(center: _geo(pts.first), zoom: 15, bearing: 0, pitch: pitch, padding: pad, nativeDuration: _cameraTime);
      return;
    }
    await c.fitBounds(bounds: ml.LngLatBounds.fromPoints(pts.map(_geo).toList()), bearing: 0, pitch: pitch, padding: pad, nativeDuration: _cameraTime);
    if (!mounted) return;
    final cam = c.camera;
    if (cam != null && cam.zoom > _maxFitZoom) await c.animateCamera(zoom: _maxFitZoom, padding: pad, nativeDuration: _cameraTime);
  }

  void _followTick({bool force = false}) {
    final c = _ctrl;
    final s = w.subject;
    if (c == null || s == null || _userBroke || !mounted) return;
    // the car's pose changes every frame; the native camera is moved ~12 times a second
    final now = DateTime.now();
    if (!force && now.difference(_lastFollow) < const Duration(milliseconds: 80)) return;
    _lastFollow = now;
    final nav = w.follow == FollowMode.driverBearing;
    final size = context.size ?? const Size(360, 640);
    final free = size.height - w.topInset - w.bottomInset;
    // navigating: the car sits in the lower part of the free area, the road ahead above it
    c.moveCamera(
      center: _geo(s),
      zoom: w.followZoom,
      bearing: nav ? w.subjectHeading : 0,
      pitch: _mode == MapMode.threeD ? (nav ? 60 : pitchFor(MapMode.threeD)) : 0,
      padding: EdgeInsets.only(top: w.topInset + (nav ? free * 0.36 : 0), bottom: w.bottomInset),
    );
  }

  void _recenter() {
    _userBroke = false;
    w.onRecenter?.call();
    if (w.follow != FollowMode.none) {
      _followTick(force: true);
    } else if (w.fit.isNotEmpty) {
      _fitTo(w.fit);
    }
    setState(() {});
  }

  void _resetNorth() => _ctrl?.animateCamera(bearing: 0, nativeDuration: _cameraTime);

  @override
  void didUpdateWidget(covariant VectorMap oldWidget) {
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

  // ── style: base map, 3D buildings, mode changes ─────────────────────────────

  void _placeCamera() {
    if (w.follow != FollowMode.none && w.subject != null) {
      _followTick(force: true);
    } else if (w.fit.isNotEmpty) {
      _fitTo(w.fit);
    }
  }

  void _onStyleLoaded(ml.StyleController style) {
    final first = _styleCtrl == null;
    _styleCtrl = style;
    if (_mode == MapMode.threeD) _addBuildings();
    if (first) _placeCamera();
  }

  Future<void> _addBuildings() async {
    final style = _styleCtrl;
    if (style == null || !mounted) return;
    final layer = ml.FillExtrusionStyleLayer(
      id: buildingsLayerId,
      sourceId: buildingsSourceId,
      sourceLayerId: 'building',
      minZoom: 14,
      paint: buildingsPaint(context.colors),
    );
    try {
      // under the route lines, so the route stays visible between buildings
      await style.addLayer(layer, belowLayerId: _layers.isEmpty ? null : _layers.first is ml.PolylineLayer ? 'maplibre-layer-0' : null);
    } catch (_) {
      try {
        await style.addLayer(layer);
      } catch (_) {
        // a style without OpenMapTiles buildings (a custom MAP_STYLE_URL): 3D is the tilt alone
      }
    }
  }

  Future<void> _removeBuildings() async {
    try {
      await _styleCtrl?.removeLayer(buildingsLayerId);
    } catch (_) {}
  }

  /// Called after a frame when the mode or the theme asks for something else.
  void _applyLook(MapMode mode, String style) {
    final c = _ctrl;
    if (c == null || !mounted) return;
    final previous = _mode;
    _mode = mode;
    if (style != _style) {
      _style = style;
      _styleCtrl = null; // buildings, if any, are added again when it has loaded
      c.setStyle(style);
    } else if (previous != mode) {
      if (mode == MapMode.threeD) {
        _addBuildings();
      } else if (previous == MapMode.threeD) {
        _removeBuildings();
      }
    }
    if (previous != mode && w.follow == FollowMode.none) c.animateCamera(pitch: pitchFor(mode), nativeDuration: _cameraTime);
    if (previous != mode && w.follow != FollowMode.none) _followTick(force: true);
  }

  // ── events ──────────────────────────────────────────────────────────────────

  void _onEvent(ml.MapEvent e) {
    switch (e) {
      case ml.MapEventStartMoveCamera(:final reason) when reason == ml.CameraChangeReason.apiGesture:
        _gesture = true;
        if (w.follow != FollowMode.none && !_userBroke) {
          _userBroke = true;
          setState(() {});
        }
        w.onUserGesture?.call();
      case ml.MapEventCameraIdle():
        if (_gesture) {
          _gesture = false;
          final cam = _ctrl?.camera;
          if (cam != null) w.onMove?.call(_latLng(cam.center));
        }
      case ml.MapEventClick(:final point):
        w.onTap?.call(_latLng(point));
      default:
        break;
    }
  }

  // ── layers ──────────────────────────────────────────────────────────────────

  List<ml.Layer> _routeLayers(AnbessaColors c, List<RouteLine> routes, bool imagery) {
    final key = '${c.isDark}|$imagery|${routes.where((r) => !r.isEmpty).map((r) => '${r.kind.index}:${r.points.length}:${r.points.first.latitude},${r.points.first.longitude}:${r.points.last.latitude},${r.points.last.longitude}').join(';')}';
    if (key == _layersKey) return _layers;
    _layersKey = key;
    final out = <ml.Layer>[];
    for (final r in routes) {
      if (r.isEmpty) continue;
      final s = routeStroke(c, r.kind, onImagery: imagery);
      final line = [ml.Feature(geometry: ml.LineString.from(r.points.map(_geo)))];
      if (s.casing != null) out.add(ml.PolylineLayer(polylines: line, color: s.casing!, width: s.casingWidth.round()));
      out.add(ml.PolylineLayer(
        polylines: line,
        color: s.color,
        width: s.width.round(),
        dashArray: s.dash == null ? null : [for (final d in s.dash!) (d < 1 ? 1 : d.round())],
      ));
    }
    return _layers = out;
  }

  @override
  void dispose() {
    _refit?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final city = ref.watch(currentCityProvider);
    final mode = ref.watch(effectiveMapModeProvider);
    final style = vectorStyleFor(mode, dark: c.isDark);
    if (_ctrl == null) {
      _style ??= style;
      _mode ??= mode;
    } else if (style != _style || mode != _mode) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _applyLook(mode, style));
    }
    final initial = w.center ?? w.subject ?? (w.fit.isNotEmpty ? w.fit.first : LatLng(city.bbox.centerLat, city.bbox.centerLng));
    final satellite = mode == MapMode.satellite;
    final layers = _routeLayers(c, w.allRoutes, satellite);
    final nav = w.follow == FollowMode.driverBearing;
    double bearingOf(BuildContext ctx) => ml.MapCamera.maybeOf(ctx)?.bearing ?? 0;
    final pins = pinsFor(w, (ctx) => -bearingOf(ctx));
    return ml.MapLibreMap(
      options: ml.MapOptions(
        initStyle: _style!,
        initCenter: _geo(initial),
        initZoom: w.zoom,
        initPitch: pitchFor(_mode!),
        minZoom: 3,
        maxZoom: 19,
        maxPitch: 60,
        gestures: w.interactive ? const ml.MapGestures.all() : const ml.MapGestures.none(),
        androidForegroundLoadColor: c.canvas,
      ),
      onMapCreated: (ctrl) => _ctrl = ctrl,
      onStyleLoaded: _onStyleLoaded,
      onEvent: _onEvent,
      layers: layers,
      children: [
        ml.WidgetLayer(markers: [for (final p in pins) ml.Marker(point: _geo(p.point), size: p.size, alignment: p.alignment, child: p.child)]),
        Positioned(left: 6, right: 72, bottom: w.bottomInset + 4, child: MapCredit(vectorAttributionFor(mode))),
        if (w.showControls && w.interactive)
          Positioned(
            right: 12,
            bottom: w.bottomInset + 12,
            child: Builder(
              builder: (ctx) => MapControls(
                rotation: nav ? 0 : -bearingOf(ctx),
                onResetNorth: _resetNorth,
                showRecenter: w.follow != FollowMode.none || w.fit.isNotEmpty || w.onRecenter != null,
                recenterActive: w.follow != FollowMode.none && !_userBroke,
                onRecenter: _recenter,
                showModeSwitch: w.showModeSwitch,
              ),
            ),
          ),
      ],
    );
  }
}
