// The map scene: the imperative owner of everything the app draws natively on the vector map.
//
// When a style has loaded, attach() registers the images once (top-down cars, the avatar and
// destination pins, the person's dot, labels; the avatar pins again when the person changes), creates fixed GeoJSON sources and the layers that draw them (routes with round caps
// and joins, nearby cars, pins, the person, the followed car and its label) and, in 3D, the
// extruded buildings under the routes. After that, every set*() call only replaces the data of
// its own source through updateGeoJsonSource: no layer is ever removed and re-added for a data
// change. Updates are coalesced per source to at most ~30 a second (the latest data wins), and
// identical data is not sent again. A style change (theme, 2D/3D/satellite) drops everything
// native; attach() is called again for the new style and re-creates it from the last data.

import 'dart:async';

import 'package:latlong2/latlong.dart' show LatLng;
import 'package:maplibre/maplibre.dart' as ml;
import 'package:ride_app_core/ride_app_core.dart';
import '../map_styles.dart';
import '../marker_animator.dart';
import '../me_marker.dart';
import '../route_layer.dart';
import 'scene_geojson.dart';
import 'scene_images.dart';
import 'scene_style.dart';

class MapScene {
  MapScene({this.minInterval = const Duration(milliseconds: 33)});

  /// the shortest time between two updates of one source
  final Duration minInterval;

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
    try {
      await _addImages(style, look);
      if (gen != _gen) return;
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
    for (final id in _wanted.keys) {
      if (_wanted[id] != _sent[id]) _schedule(id);
    }
    unawaited(_syncLabels());
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
    } else {
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

  void setPins({LatLng? pickup, LatLng? dropoff}) => _put(SceneIds.pins, pinsGeoJson(pickup: _gp(pickup), dropoff: _gp(dropoff)));

  void setDriverCar(AnimatedPose? pose) {
    _driver = pose;
    _putDriver();
  }

  void _putDriver() {
    final p = _driver;
    _put(SceneIds.driver, driverGeoJson(at: p?.point, bearing: p?.heading ?? 0, stale: p?.stale ?? false, label: _driverLabel != null && _shownDriverLabel == _driverLabel));
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

  void _putNearby() => _put(SceneIds.nearby, nearbyGeoJson(_nearby, leadLabel: _nearbyLabel != null && _shownNearbyLabel == _nearbyLabel));

  /// The label above the nearest car around the rider; null hides it.
  void setNearbyLabel(String? text) {
    if (text == _nearbyLabel) return;
    _nearbyLabel = text;
    if (text == null) _putNearby();
    unawaited(_syncLabels());
  }

  /// The person: a dot (and heading cone), or their avatar pin with [avatar].
  void setMe(MePose? me, {bool avatar = false}) => _put(SceneIds.me, meGeoJson(at: _gp(me?.position), heading: me?.heading, avatar: avatar));

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
    final wait = last == null ? Duration.zero : minInterval - DateTime.now().difference(last);
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
