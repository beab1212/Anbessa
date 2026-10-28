// The vector engine (MapLibre): the map on Android and iOS. Flat, 3D (tilted, buildings extruded)
// or satellite, following the theme.
//
// Everything that moves is native: a MapScene owns GeoJSON sources and symbol/line layers for the
// routes, pins, the person, the followed car and the cars nearby, and updates only their data.
// The camera is driven by a CameraDirector through a MapBinding. The search pulse and the labels
// at points are native too (a ticker here moves the pulse); the only Flutter widgets over the map
// are a screen's own overlays, if any (WidgetLayer positions trail the native camera).

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart' show Ticker;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart' show LatLng;
import 'package:maplibre/maplibre.dart' as ml;
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../config/client_config_provider.dart';
import 'anbessa_map.dart';
import 'map_mode.dart';
import 'map_styles.dart';
import 'scene/camera_director.dart';
import 'scene/map_binding.dart';
import 'scene/map_scene.dart';
import 'scene/scene_images.dart';
import 'scene/scene_style.dart';

ml.Geographic _geo(LatLng p) => ml.Geographic(lon: p.longitude, lat: p.latitude);
ml.Geographic _geoP(GeoPoint p) => ml.Geographic(lon: p.lng, lat: p.lat);
LatLng _latLng(ml.Geographic g) => LatLng(g.lat, g.lon);

/// The camera never zooms closer than this when fitting points (two pins in the same building).
const _maxFitZoom = 17.0;

class VectorMap extends ConsumerStatefulWidget {
  const VectorMap({super.key, required this.spec});
  final AnbessaMap spec;
  @override
  ConsumerState<VectorMap> createState() => _VectorMapState();
}

class _VectorMapState extends ConsumerState<VectorMap> with SingleTickerProviderStateMixin {
  ml.MapController? _ctrl;
  final MapScene _scene = MapScene();
  late final _VectorPort _port = _VectorPort(this);
  late final MapBinding _binding = MapBinding(_port);
  /// the style the map has (or is loading); a different one is set after the frame
  String? _style;
  MapMode? _mode;
  bool? _dark;
  bool _styleLoaded = false;
  bool _gesture = false;
  Size? _size;
  ValueListenable<AnimatedPose?>? _carL;
  ValueListenable<List<NearbyCarFrame>>? _carsL;
  late final Ticker _pulseTicker = createTicker(_onPulseTick);

  AnbessaMap get w => widget.spec;

  @override
  void initState() {
    super.initState();
    _binding.sync(w, ready: false);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // content needs the context (reduced motion for the pulse)
    _syncContent();
  }

  @override
  void didUpdateWidget(covariant VectorMap oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncContent();
    _binding.sync(w, ready: _styleLoaded);
  }

  // ── content → scene ─────────────────────────────────────────────────────────

  void _syncContent() {
    _scene.setRoutes(w.allRoutes);
    _scene.setPins(pickup: w.pickup, dropoff: w.dropoff, plainPickup: !w.pickupAsAvatar);
    _scene.setCallouts([for (final m in w.callouts.take(3)) (point: m.point, text: m.label, lift: calloutLift(m))]);
    _syncPulse();
    _scene.setMe(w.mePoseOrPoint, avatar: w.meAsAvatar);
    _syncPerson();
    if (!identical(_carL, w.driverCar)) {
      _carL?.removeListener(_onCar);
      _carL = w.driverCar;
      _carL?.addListener(_onCar);
    }
    _scene.setDriverCar(w.carNow);
    _scene.setDriverLabel(w.carNow == null ? null : w.driverCarLabel);
    if (!identical(_carsL, w.nearbyCars)) {
      _carsL?.removeListener(_onCars);
      _carsL = w.nearbyCars;
      _carsL?.addListener(_onCars);
    }
    final frames = _carsL?.value ?? [for (final (i, c) in w.cars.indexed) NearbyCarFrame(id: i, lat: c.position.latitude, lng: c.position.longitude, bearing: c.heading ?? 0)];
    _scene.setNearbyCars(frames);
    _scene.setNearbyLabel(frames.isEmpty ? null : w.nearbyLabel);
  }

  /// The pulse: native rings, moved by a ticker while shown (one still frame with reduced motion).
  void _syncPulse() {
    final p = w.pulse;
    _scene.setPulse(at: p?.point, onCar: p?.onCar ?? false);
    if (p == null) {
      if (_pulseTicker.isActive) _pulseTicker.stop();
      return;
    }
    if (!mounted) return;
    if (MediaQuery.maybeDisableAnimationsOf(context) ?? false) {
      if (_pulseTicker.isActive) _pulseTicker.stop();
      _scene.setPulsePhase(0.5);
    } else if (!_pulseTicker.isActive) {
      _pulseTicker.start();
    }
  }

  static const _pulsePeriod = 2400;

  void _onPulseTick(Duration elapsed) => _scene.setPulsePhase((elapsed.inMilliseconds % _pulsePeriod) / _pulsePeriod);

  MapPerson? _person;
  int _personGen = 0;

  /// The avatar pins show [AnbessaMap.person]: their photo is decoded off the frame, then drawn.
  void _syncPerson() {
    final p = w.person;
    if (p == _person) return;
    _person = p;
    final gen = ++_personGen;
    final initials = p == null || p.name.trim().isEmpty ? '' : AvatarImage.initialsOf(p.name);
    _scene.setPerson(ScenePerson(initials: initials));
    if (p?.photo == null) return;
    unawaited(loadAvatarImage(p!.photo).then((img) {
      if (img == null || gen != _personGen || !mounted) return;
      _scene.setPerson(ScenePerson(photo: img, initials: initials));
    }));
  }

  void _onCar() {
    final p = _carL?.value;
    _scene.setDriverCar(p);
    if (p == null) _scene.setDriverLabel(null);
  }

  void _onCars() {
    final frames = _carsL?.value ?? const <NearbyCarFrame>[];
    _scene.setNearbyCars(frames);
    _scene.setNearbyLabel(frames.isEmpty ? null : w.nearbyLabel);
  }

  // ── style: base map, 3D buildings, mode changes ─────────────────────────────

  SceneLook _look(MapMode mode) => SceneLook(
        colors: context.colors,
        imagery: mode == MapMode.satellite,
        buildings: mode == MapMode.threeD,
        imageScale: sceneImageScale(MediaQuery.devicePixelRatioOf(context)),
      );

  void _updateDirectorLook() {
    final mode = _mode ?? MapMode.flat;
    _binding.director.setLook(basePitch: pitchFor(mode), threeD: mode == MapMode.threeD, reduceMotion: MediaQuery.disableAnimationsOf(context));
  }

  void _onStyleLoaded(ml.StyleController style) {
    if (!mounted) return;
    final first = !_styleLoaded;
    _styleLoaded = true;
    unawaited(_scene.attach(style, _look(_mode ?? MapMode.flat)));
    _updateDirectorLook();
    if (first) _binding.sync(w, ready: true);
  }

  /// Called after a frame when the mode or the theme asks for something else.
  void _applyLook(MapMode mode, String style, bool dark) {
    final c = _ctrl;
    if (c == null || !mounted) return;
    final previous = _mode;
    final themeChanged = _dark != null && _dark != dark;
    _mode = mode;
    _dark = dark;
    if (style != _style || themeChanged) {
      // a new style drops every source and layer; the scene rebuilds them when it has loaded
      _style = style;
      _scene.detach();
      c.setStyle(style);
    } else if (previous != mode) {
      unawaited(_scene.setBuildings(mode == MapMode.threeD));
    }
    _updateDirectorLook();
  }

  // ── events ──────────────────────────────────────────────────────────────────

  void _onEvent(ml.MapEvent e) {
    switch (e) {
      case ml.MapEventStartMoveCamera(:final reason) when reason == ml.CameraChangeReason.apiGesture:
        _gesture = true;
        _binding.director.onUserGesture();
        w.onUserGesture?.call();
      case ml.MapEventCameraIdle():
        if (_gesture) {
          _gesture = false;
          final cam = _ctrl?.camera;
          if (cam != null) w.onMove?.call(_latLng(cam.center));
        }
      case ml.MapEventMoveCamera(:final camera):
        _scene.setViewBearing(camera.bearing);
      case ml.MapEventClick(:final point):
        w.onTap?.call(_latLng(point));
      default:
        break;
    }
  }

  void _resetNorth() => _ctrl?.animateCamera(bearing: 0, nativeDuration: MediaQuery.disableAnimationsOf(context) ? Duration.zero : AnbessaMotion.camera).catchError((Object _) {});

  @override
  void dispose() {
    _carL?.removeListener(_onCar);
    _carsL?.removeListener(_onCars);
    _pulseTicker.dispose();
    _binding.dispose();
    _scene.dispose();
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
    final style = vectorStyleFor(mode, dark: c.isDark);
    if (_ctrl == null) {
      _style ??= style;
      _mode ??= mode;
      _dark ??= c.isDark;
    } else if (style != _style || mode != _mode || c.isDark != _dark) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _applyLook(mode, style, c.isDark));
    }
    final initial = w.center ?? w.subject ?? (w.fit.isNotEmpty ? w.fit.first : LatLng(city.bbox.centerLat, city.bbox.centerLng));
    final nav = w.follow == FollowMode.driverBearing;
    double bearingOf(BuildContext ctx) => ml.MapCamera.maybeOf(ctx)?.bearing ?? 0;
    final overlays = pinsFor(w, (ctx) => -bearingOf(ctx), native: false);
    ml.Marker marker(MapPin p) => ml.Marker(point: _geo(p.point), size: p.size, alignment: p.alignment, child: p.child);
    return LayoutBuilder(
      builder: (context, box) {
        _size = box.biggest;
        return ml.MapLibreMap(
          options: ml.MapOptions(
            initStyle: _style!,
            initCenter: _geo(initial),
            initZoom: w.follow != FollowMode.none ? w.followZoom : w.zoom,
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
          children: [
            if (overlays.isNotEmpty) ml.WidgetLayer(markers: [for (final p in overlays) marker(p)]),
            _withBottom((bottom) => MapInfoSlot(bottom: bottom, attribution: vectorAttributionFor(mode))),
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
                  child: Builder(
                    builder: (ctx) => ValueListenableBuilder<bool>(
                      valueListenable: _binding.director.showRecenter,
                      builder: (_, free, _) => MapControls(
                        rotation: nav ? 0 : -bearingOf(ctx),
                        onResetNorth: _resetNorth,
                        showRecenter: w.follow != FollowMode.none || w.fit.isNotEmpty || w.onRecenter != null,
                        recenterActive: w.follow != FollowMode.none && !free,
                        onRecenter: _binding.recenter,
                        showModeSwitch: w.showModeSwitch,
                      round: w.roundControls,
                      ),
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

/// The director's hands on the MapLibre camera.
class _VectorPort implements CameraPort {
  _VectorPort(this._s);
  final _VectorMapState _s;

  @override
  Size? get viewport => _s._size;

  @override
  double get bearing => _s._ctrl?.camera?.bearing ?? 0;

  @override
  CameraView? get current {
    final cam = _s._ctrl?.camera;
    return cam == null ? null : (center: (lat: cam.center.lat, lng: cam.center.lon), zoom: cam.zoom, bearing: cam.bearing, pitch: cam.pitch);
  }

  @override
  bool get followsEveryFrame => false;

  @override
  Future<void> moveTo({required GeoPoint center, required double zoom, required double bearing, required double pitch, required EdgeInsets padding, required Duration duration}) async {
    final c = _s._ctrl;
    if (c == null || !_s.mounted) return;
    if (duration <= Duration.zero) {
      await c.moveCamera(center: _geoP(center), zoom: zoom, bearing: bearing, pitch: pitch, padding: padding);
    } else {
      await c.animateCamera(center: _geoP(center), zoom: zoom, bearing: bearing, pitch: pitch, padding: padding, nativeDuration: duration);
    }
  }

  @override
  Future<void> fit(List<GeoPoint> points, {required EdgeInsets padding, required double bearing, required double pitch, required Duration duration, double maxZoom = _maxFitZoom, double singleZoom = 15}) async {
    final c = _s._ctrl;
    if (c == null || !_s.mounted || points.isEmpty) return;
    final vp = viewport;
    // close points: centre at the zoom cap in one move (fitBounds would zoom in past it first)
    final z = points.length == 1 ? double.infinity : (vp == null ? 0.0 : fitZoomFor(points, vp, padding));
    if (z > maxZoom) {
      final target = points.length == 1 ? points.first : boundsCenter(points);
      await moveTo(center: target, zoom: points.length == 1 ? singleZoom : maxZoom, bearing: bearing, pitch: pitch, padding: padding, duration: duration);
      return;
    }
    await c.fitBounds(
      bounds: ml.LngLatBounds.fromPoints([for (final p in points) _geoP(p)]),
      bearing: bearing,
      pitch: pitch,
      padding: padding,
      nativeDuration: duration <= Duration.zero ? const Duration(milliseconds: 1) : duration,
    );
  }
}
