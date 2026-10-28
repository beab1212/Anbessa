// The map scene: the imperative owner of everything the app draws natively on the vector map.
//
// When a style has loaded, attach() registers the images once (top-down cars, the avatar and
// destination pins, the person's dot, labels; the avatar pins again when the person changes), creates fixed GeoJSON sources and the layers that draw them (routes with round caps
// and joins, nearby cars, pins, the person, the followed car and its label) and, in 3D, the
// extruded buildings under the routes. After that, every set*() call only replaces the data of
// its own source through updateGeoJsonSource: no layer is ever removed and re-added for a data
// change. Updates are coalesced per source to at most ~30 a second (the latest data wins; the
// followed car goes out on every frame, so it moves in step with a camera that follows it), and
// identical data is not sent again.
//
// In 3D the cars are standing low-poly cars (car3d.dart): their 36 frames are painted when 3D
// is first shown on a style, and each car picks the frame for its heading relative to the
// camera's bearing (setViewBearing). The search pulse and the labels at points are native too,
// so nothing on the map trails it while it moves. A style change (theme, 2D/3D/satellite) drops everything
// native; attach() is called again for the new style and re-creates it from the last data.

import 'dart:async';

import 'package:latlong2/latlong.dart' show LatLng;
import 'package:maplibre/maplibre.dart' as ml;
import 'package:ride_app_core/ride_app_core.dart';
import '../map_styles.dart';
import '../marker_animator.dart';
import '../me_marker.dart';
import '../route_layer.dart';
import 'car3d.dart';
import 'scene_geojson.dart';
import 'scene_images.dart';
import 'scene_style.dart';

class MapScene {
  MapScene({this.minInterval = const Duration(milliseconds: 33)});

  /// the shortest time between two updates of one source (the followed car: every frame)
  final Duration minInterval;

  Duration _intervalOf(String id) => id == SceneIds.driver ? Duration.zero : minInterval;

  ml.StyleController? _style;
  SceneLook? _look;
  int _gen = 0;
  bool _disposed = false;
  bool _buildings = false;

  final _wanted = <String, String>{};
  final _sent = <String, String>{};
  final _flushedAt = <String, DateTime>{};
  final _timers = <String, Timer>{};

  // the last values, to rebuild a source when something next to it changes (a label)
  String? _routesKey;
  AnimatedPose? _driver;
  String? _driverLabel;
  List<NearbyCarFrame> _nearby = const [];
  String? _nearbyLabel;
  String? _shownDriverLabel;
  String? _shownNearbyLabel;
  ScenePerson _person = ScenePerson.nobody;
  // 3D cars: whether the style has their frames, and the camera's bearing they are seen from
  bool _car3dReady = false;
  double _viewBearing = 0;
  // the pulse: where (or on the followed car), and its phase
  GeoPoint? _pulseAt;
  bool _pulseOnCar = false;
  double _pulsePhase = 0;
  // labels at points, and the images the style has for them
  List<({GeoPoint point, String text, double lift})> _callouts = const [];
  final _calloutImages = <String>{};

  /// The scene's layers and sources exist on the current style.
  bool get isAttached => _style != null;

  // ── style lifecycle ─────────────────────────────────────────────────────────

  /// Build the scene on a freshly loaded [style].
  Future<void> attach(ml.StyleController style, SceneLook look) async {
    if (_disposed) return;
    final gen = ++_gen;
    _style = null;
    _sent.clear();
    _shownDriverLabel = _shownNearbyLabel = null;
    _buildings = look.buildings;
    _car3dReady = false;
    _calloutImages.clear();
    try {
      await _addImages(style, look);
      if (gen != _gen) return;
      if (look.buildings) {
        await _addCar3dImages(style, look);
        if (gen != _gen) return;
        _car3dReady = true;
      }
      for (final id in SceneIds.sources) {
        final data = _wanted[id] ?? emptyFeatureCollection;
        try {
          await style.addSource(ml.GeoJsonSource(id: id, data: data));
          _sent[id] = data;
        } catch (_) {
          // already there (attach ran twice on one style): data is sent below
        }
      }
      if (gen != _gen) return;
      if (look.buildings) await _addBuildings(style, look);
      for (final layer in sceneLayers(look)) {
        try {
          await style.addLayer(layer);
        } catch (_) {}
      }
    } catch (_) {
      // the style went away while building (another setStyle): the next attach rebuilds it
      return;
    }
    if (gen != _gen || _disposed) return;
    _style = style;
    _look = look;
    // the cars as this style draws them (flat, or the 3D frames)
    _putDriver();
    _putNearby();
    for (final id in _wanted.keys) {
      if (_wanted[id] != _sent[id]) _schedule(id);
    }
    unawaited(_syncLabels());
    unawaited(_syncCallouts());
  }

  /// The style is being replaced: forget it until the next attach.
  void detach() {
    _gen++;
    _style = null;
    for (final t in _timers.values) {
      t.cancel();
    }
    _timers.clear();
  }

  Future<void> _addImages(ml.StyleController style, SceneLook look) async {
    final c = look.colors, k = look.imageScale;
    final images = <String, SceneImage>{
      SceneIds.imgCarDriver: carImage(c, k),
      SceneIds.imgCarStale: carImage(c, k, stale: true),
      SceneIds.imgCarNearby: nearbyCarImage(c, k),
      SceneIds.imgCarShadow: carShadowImage(c, k),
      SceneIds.imgPinDropoff: destinationPinImage(c, k),
      SceneIds.imgPinPickupPlain: plainPickupPinImage(c, k),
      SceneIds.imgMeDot: meDotImage(c, k),
      SceneIds.imgMeCone: meConeImage(c, k),
    };
    for (final e in images.entries) {
      await _addImage(style, e.key, e.value);
    }
    await _addPersonImages(style, look);
  }

  /// The pickup pin and "you" on the home map: the person's avatar pin.
  Future<void> _addPersonImages(ml.StyleController style, SceneLook look) async {
    final img = avatarPinImage(look.colors, look.imageScale, _person);
    await _addImage(style, SceneIds.imgPinPickup, img);
    await _addImage(style, SceneIds.imgMeAvatar, img);
  }

  /// Who the avatar pins show; the images are drawn again when it changes.
  void setPerson(ScenePerson person) {
    if (identical(person, _person) || (person.photo == _person.photo && person.initials == _person.initials)) return;
    _person = person;
    final style = _style, look = _look;
    if (style == null || look == null) return;
    unawaited(_addPersonImages(style, look));
  }

  /// The standing 3D car, one image per direction.
  Future<void> _addCar3dImages(ml.StyleController style, SceneLook look) async {
    for (var i = 0; i < car3dFrames; i++) {
      await _addImage(style, car3dImageId(i), car3dImage(i, look.car3dScale));
    }
  }

  Future<void> _addImage(ml.StyleController style, String id, SceneImage img) async {
    try {
      await style.addImageFromCanvas(id: id, painter: img.paint, width: img.width, height: img.height);
    } catch (_) {}
  }

  /// 3D: extruded buildings, under the route lines.
  Future<void> setBuildings(bool on) async {
    if (on == _buildings) return;
    _buildings = on;
    final style = _style, look = _look;
    if (style == null || look == null) return;
    if (on) {
      await _addBuildings(style, look, below: SceneIds.routeSecondary);
      if (!_car3dReady) {
        final gen = _gen;
        await _addCar3dImages(style, look);
        if (gen != _gen || !_buildings) return;
        _car3dReady = true;
      }
      _putDriver();
      _putNearby();
    } else {
      _putDriver();
      _putNearby();
      try {
        await style.removeLayer(buildingsLayerId);
      } catch (_) {}
    }
  }

  Future<void> _addBuildings(ml.StyleController style, SceneLook look, {String? below}) async {
    final layer = ml.FillExtrusionStyleLayer(id: buildingsLayerId, sourceId: buildingsSourceId, sourceLayerId: 'building', minZoom: 14, paint: buildingsPaint(look.colors));
    try {
      await style.addLayer(layer, belowLayerId: below);
    } catch (_) {
      // a style without OpenMapTiles buildings (a custom MAP_STYLE_URL): 3D is the tilt alone
    }
  }

  // ── content ─────────────────────────────────────────────────────────────────

  /// The route lines. Same geometry as last time: nothing is sent.
  void setRoutes(List<RouteLine> routes) {
    final key = routesKey(routes);
    if (key == _routesKey) return;
    _routesKey = key;
    _put(SceneIds.routes, routesGeoJson([for (final r in routes) if (!r.isEmpty) SceneRoute(toGeoPoints(r.points), sceneKindOf(r.kind))]));
  }

  /// The pickup and drop-off pins; [plainPickup] draws the pickup without the person's photo.
  void setPins({LatLng? pickup, LatLng? dropoff, bool plainPickup = false}) =>
      _put(SceneIds.pins, pinsGeoJson(pickup: _gp(pickup), dropoff: _gp(dropoff), plainPickup: plainPickup));

  /// The camera's bearing: the 3D cars are seen from it.
  void setViewBearing(double bearing) {
    final old = _viewBearing;
    _viewBearing = bearing;
    if (!_cars3d) return;
    // only when some car's frame changes (a frame is 10°)
    bool moved(double heading) => car3dFrameFor(heading, old) != car3dFrameFor(heading, bearing);
    final d = _driver;
    if (d != null && moved(d.heading)) _putDriver();
    if (_nearby.any((c) => moved(c.bearing))) _putNearby();
  }

  bool get _cars3d => _buildings && _car3dReady;

  Car3dFrame? get _frame3d => _cars3d ? (b) => car3dImageId(car3dFrameFor(b, _viewBearing)) : null;

  void setDriverCar(AnimatedPose? pose) {
    _driver = pose;
    _putDriver();
  }

  void _putDriver() {
    final p = _driver;
    _put(SceneIds.driver, driverGeoJson(at: p?.point, bearing: p?.heading ?? 0, stale: p?.stale ?? false, label: _driverLabel != null && _shownDriverLabel == _driverLabel, frame3d: _frame3d));
    if (_pulseOnCar) _putPulse();
  }

  /// The label above the followed car ("4 min"); null hides it.
  void setDriverLabel(String? text) {
    if (text == _driverLabel) return;
    _driverLabel = text;
    if (text == null) _putDriver();
    unawaited(_syncLabels());
  }

  void setNearbyCars(List<NearbyCarFrame> cars) {
    _nearby = cars;
    _putNearby();
  }

  void _putNearby() => _put(SceneIds.nearby, nearbyGeoJson(_nearby, leadLabel: _nearbyLabel != null && _shownNearbyLabel == _nearbyLabel, frame3d: _frame3d));

  /// The label above the nearest car around the rider; null hides it.
  void setNearbyLabel(String? text) {
    if (text == _nearbyLabel) return;
    _nearbyLabel = text;
    if (text == null) _putNearby();
    unawaited(_syncLabels());
  }

  /// The person: a dot (and heading cone), or their avatar pin with [avatar].
  void setMe(MePose? me, {bool avatar = false}) => _put(SceneIds.me, meGeoJson(at: _gp(me?.position), heading: me?.heading, avatar: avatar));

  /// The search pulse at [at], or around the followed car with [onCar] ([at] until there is
  /// one); neither hides it.
  void setPulse({LatLng? at, bool onCar = false}) {
    _pulseAt = _gp(at);
    _pulseOnCar = onCar;
    _putPulse();
  }

  /// The pulse's phase (0–1 of a wave); the map's ticker moves it.
  void setPulsePhase(double t) {
    _pulsePhase = t;
    _putPulse();
  }

  bool get hasPulse => _pulseAt != null || _pulseOnCar;

  void _putPulse() {
    final at = _pulseOnCar ? (_driver?.point ?? _pulseAt) : _pulseAt;
    _put(SceneIds.pulse, pulseGeoJson(at, _pulsePhase));
  }

  /// Labels at points, each [lift] logical pixels above its point.
  void setCallouts(List<({LatLng point, String text, double lift})> callouts) {
    final next = [for (final c in callouts) (point: _gp(c.point)!, text: c.text, lift: c.lift)];
    _callouts = next;
    unawaited(_syncCallouts());
  }

  static String _calloutImageId(String text, double lift) => 'anb-callout-${lift.round()}-${text.hashCode.toUnsigned(32)}';

  /// Draw the images the labels need, then show them.
  Future<void> _syncCallouts() async {
    final style = _style, look = _look;
    if (style == null || look == null) {
      _put(SceneIds.callouts, calloutsGeoJson([for (final c in _callouts) if (_calloutImages.contains(_calloutImageId(c.text, c.lift))) SceneCallout(point: c.point, image: _calloutImageId(c.text, c.lift))]));
      return;
    }
    final gen = _gen;
    for (final c in _callouts) {
      final id = _calloutImageId(c.text, c.lift);
      if (_calloutImages.contains(id)) continue;
      await _addImage(style, id, labelImage(look.colors, look.imageScale, c.text, lift: c.lift));
      if (gen != _gen) return;
      _calloutImages.add(id);
    }
    _put(SceneIds.callouts, calloutsGeoJson([for (final c in _callouts) SceneCallout(point: c.point, image: _calloutImageId(c.text, c.lift))]));
  }

  /// Draw the label images, then show the features that use them.
  Future<void> _syncLabels() async {
    final style = _style, look = _look;
    if (style == null || look == null) return;
    final gen = _gen;
    final d = _driverLabel;
    if (d != null && d != _shownDriverLabel) {
      await _addImage(style, SceneIds.imgLabelDriver, labelImage(look.colors, look.imageScale, d));
      if (gen != _gen) return;
      _shownDriverLabel = d;
      _putDriver();
    }
    final n = _nearbyLabel;
    if (n != null && n != _shownNearbyLabel) {
      await _addImage(style, SceneIds.imgLabelNearby, labelImage(look.colors, look.imageScale, n));
      if (gen != _gen) return;
      _shownNearbyLabel = n;
      _putNearby();
    }
  }

  // ── sending ─────────────────────────────────────────────────────────────────

  void _put(String id, String data) {
    if (_wanted[id] == data) return;
    _wanted[id] = data;
    _schedule(id);
  }

  void _schedule(String id) {
    if (_style == null || _disposed || _timers.containsKey(id)) return;
    final last = _flushedAt[id];
    final wait = last == null ? Duration.zero : _intervalOf(id) - DateTime.now().difference(last);
    if (wait <= Duration.zero) {
      _flush(id);
    } else {
      _timers[id] = Timer(wait, () {
        _timers.remove(id);
        _flush(id);
      });
    }
  }

  void _flush(String id) {
    final style = _style, data = _wanted[id];
    if (style == null || data == null || _sent[id] == data) return;
    _sent[id] = data;
    _flushedAt[id] = DateTime.now();
    style.updateGeoJsonSource(id: id, data: data).catchError((Object _) {});
  }

  void dispose() {
    _disposed = true;
    detach();
  }
}

GeoPoint? _gp(LatLng? p) => p == null ? null : (lat: p.latitude, lng: p.longitude);

SceneRouteKind sceneKindOf(RouteKind k) => switch (k) {
      RouteKind.primary => SceneRouteKind.primary,
      RouteKind.traversed => SceneRouteKind.traversed,
      RouteKind.secondary => SceneRouteKind.secondary,
      RouteKind.straight => SceneRouteKind.straight,
    };

/// A cheap identity for a set of lines: kind, length, and the first, middle and last points of
/// each (a decoded polyline that hasn't changed gives the same key).
String routesKey(List<RouteLine> routes) {
  final sb = StringBuffer();
  String p(LatLng q) => '${q.latitude.toStringAsFixed(6)},${q.longitude.toStringAsFixed(6)}';
  for (final r in routes) {
    if (r.isEmpty) continue;
    sb
      ..write(r.kind.index)
      ..write(':')
      ..write(r.points.length)
      ..write(':')
      ..write(p(r.points.first))
      ..write(':')
      ..write(p(r.points[r.points.length ~/ 2]))
      ..write(':')
      ..write(p(r.points.last))
      ..write(';');
  }
  return sb.toString();
}
