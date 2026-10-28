// The map scene's data, without a platform map: the GeoJSON sent to each native source, the
// layer definitions, and the nearby cars' frames (fade in and out, idle ticker).

import 'dart:convert';

import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:maplibre/maplibre.dart' as ml;
import 'package:phone_app/features/maps/anbessa_map.dart';
import 'package:phone_app/features/maps/nearby_cars_layer.dart';
import 'package:phone_app/features/maps/scene/map_scene.dart';
import 'package:phone_app/features/maps/scene/scene_geojson.dart';
import 'package:phone_app/features/maps/scene/scene_style.dart';
import 'package:ride_app_core/ride_app_core.dart';

Map<String, dynamic> parse(String s) => jsonDecode(s) as Map<String, dynamic>;
List<dynamic> features(String s) => parse(s)['features'] as List<dynamic>;

void main() {
  group('GeoJSON', () {
    test('routes: one LineString per drawable line, [lng, lat] order, kind as a property', () {
      final s = routesGeoJson(const [
        SceneRoute([(lat: 9.0, lng: 38.7), (lat: 9.1, lng: 38.8)], SceneRouteKind.primary),
        SceneRoute([(lat: 9.0, lng: 38.7)], SceneRouteKind.secondary), // one point: left out
        SceneRoute([(lat: 9.0, lng: 38.7), (lat: 9.05, lng: 38.75)], SceneRouteKind.traversed),
      ]);
      final f = features(s);
      expect(parse(s)['type'], 'FeatureCollection');
      expect(f, hasLength(2));
      expect(f[0]['geometry']['type'], 'LineString');
      expect(f[0]['geometry']['coordinates'][0], [38.7, 9.0]);
      expect(f[0]['properties']['kind'], 'primary');
      expect(f[1]['properties']['kind'], 'traversed');
    });

    test('coordinates are rounded to 6 decimals, bearings to 0.1° in 0–360', () {
      final s = driverGeoJson(at: (lat: 9.123456789, lng: 38.987654321), bearing: -90.04);
      final f = features(s).single;
      expect(f['geometry']['coordinates'], [38.987654, 9.123457]);
      expect(f['properties']['bearing'], 270.0);
      expect(f['properties']['icon'], SceneIds.imgCarDriver);
      expect(f['properties']['label'], false);
    });

    test('a stale car uses the grey image; no car is an empty collection', () {
      expect(features(driverGeoJson(at: (lat: 9, lng: 38), stale: true, label: true)).single['properties'], containsPair('icon', SceneIds.imgCarStale));
      expect(features(driverGeoJson()), isEmpty);
      expect(driverGeoJson(), emptyFeatureCollection);
    });

    test('pins carry their image', () {
      final f = features(pinsGeoJson(pickup: (lat: 9, lng: 38), dropoff: (lat: 9.1, lng: 38.1)));
      expect(f.map((x) => x['properties']['pin']), [SceneIds.imgPinPickup, SceneIds.imgPinDropoff]);
      expect(features(pinsGeoJson(dropoff: (lat: 9.1, lng: 38.1))).single['properties']['kind'], 'dropoff');
    });

    test('nearby cars: opacity clamped, only the first carries the label', () {
      final f = features(nearbyGeoJson(const [
        NearbyCarFrame(id: 3, lat: 9, lng: 38, bearing: 10, opacity: 1.4),
        NearbyCarFrame(id: 4, lat: 9.01, lng: 38.01, bearing: 20, opacity: 0.333),
      ], leadLabel: true));
      expect(f[0]['properties'], containsPair('opacity', 1.0));
      expect(f[0]['properties'], containsPair('lead', true));
      expect(f[1]['properties'], containsPair('opacity', 0.33));
      expect(f[1]['properties'], containsPair('lead', false));
      expect(f[1]['properties'], containsPair('id', 4));
    });

    test('me: the cone only with a heading', () {
      expect(features(meGeoJson(at: (lat: 9, lng: 38), heading: 45)).single['properties'], {'bearing': 45.0, 'cone': true});
      expect(features(meGeoJson(at: (lat: 9, lng: 38))).single['properties']['cone'], false);
    });

    test('css colours', () {
      expect(cssColor(const Color(0xFFFFB300)), 'rgba(255, 179, 0, 1.0)');
      expect(cssColor(const Color(0x80000000)), 'rgba(0, 0, 0, 0.5)');
    });

    test('the routes key ignores rebuilds with the same geometry and changes with it', () {
      final a = RouteLine([LatLng(9, 38), LatLng(9.1, 38.1)]);
      final b = RouteLine([LatLng(9, 38), LatLng(9.1, 38.1)]);
      expect(routesKey([a]), routesKey([b]));
      expect(routesKey([a]), isNot(routesKey([RouteLine([LatLng(9.0001, 38), LatLng(9.1, 38.1)])])));
      expect(routesKey([a]), isNot(routesKey([RouteLine(a.points, kind: RouteKind.secondary)])));
    });
  });

  group('layers', () {
    final look = SceneLook(colors: AnbessaColors.light, imageScale: 3);
    final layers = sceneLayers(look);
    T layer<T extends ml.StyleLayer>(String id) => layers.firstWhere((l) => l.id == id) as T;

    test("the person's own position never uses a car image: only the dot, its cone and the avatar pin", () {
      const cars = {SceneIds.imgCarDriver, SceneIds.imgCarStale, SceneIds.imgCarNearby};
      final mine = layers.whereType<ml.SymbolStyleLayer>().where((l) => l.sourceId == SceneIds.me).toList();
      expect(mine.map((l) => l.layout['icon-image']), unorderedEquals([SceneIds.imgMeCone, SceneIds.imgMeDot, SceneIds.imgMeAvatar]));
      // only the followed car and the cars nearby draw car images
      for (final l in layers.whereType<ml.SymbolStyleLayer>()) {
        final img = l.layout['icon-image'];
        if (img is String && cars.contains(img)) expect(l.sourceId, SceneIds.nearby);
        if (img is List) expect(l.sourceId, isNot(SceneIds.me));
      }
      for (final avatar in [false, true]) {
        final f = features(meGeoJson(at: (lat: 9.0, lng: 38.7), heading: 45, avatar: avatar)).single as Map<String, dynamic>;
        final props = f['properties'] as Map<String, dynamic>;
        expect(props.containsKey('icon'), isFalse);
        expect(props.values.where((v) => cars.contains(v)), isEmpty);
      }
    });

    test('route lines have round caps and joins and zoom-dependent widths, the casing under the fill', () {
      final ids = layers.map((l) => l.id).toList();
      expect(ids.indexOf(SceneIds.routeCasing), lessThan(ids.indexOf(SceneIds.routeFill)));
      for (final id in [SceneIds.routeCasing, SceneIds.routeFill, SceneIds.routeTraversed, SceneIds.routeSecondary, SceneIds.routeStraight]) {
        final l = layer<ml.LineStyleLayer>(id);
        expect(l.layout, containsPair('line-cap', 'round'));
        expect(l.layout, containsPair('line-join', 'round'));
        expect((l.paint['line-width']! as List).first, 'interpolate');
      }
      expect(layer<ml.LineStyleLayer>(SceneIds.routeFill).paint['line-color'], cssColor(AnbessaColors.light.accent));
    });

    test('cars lie on the map, turned by their bearing, never hidden by collisions', () {
      for (final id in [SceneIds.driverCar, SceneIds.nearbyCars]) {
        final l = layer<ml.SymbolStyleLayer>(id);
        expect(l.layout['icon-rotate'], ['get', 'bearing']);
        expect(l.layout['icon-rotation-alignment'], 'map');
        expect(l.layout['icon-pitch-alignment'], 'map');
        expect(l.layout['icon-allow-overlap'], true);
      }
      expect(layer<ml.SymbolStyleLayer>(SceneIds.nearbyCars).paint['icon-opacity'], ['get', 'opacity']);
    });

    test('the car is drawn above the routes and pins', () {
      final ids = layers.map((l) => l.id).toList();
      expect(ids.indexOf(SceneIds.driverCar), greaterThan(ids.indexOf(SceneIds.routeFill)));
      expect(ids.indexOf(SceneIds.driverCar), greaterThan(ids.indexOf(SceneIds.pinLayer)));
      expect(ids.last, SceneIds.driverLabel);
    });
  });

  group('CarsAnimator', () {
    testWidgets('fades cars in and out, publishes frames, and stops ticking when idle or paused', (tester) async {
      var now = DateTime.utc(2026, 10, 27, 9);
      final cars = CarsAnimator(vsync: const _TestVsync(), now: () => now);
      final seen = <List<NearbyCarFrame>>[];
      cars.frames.addListener(() => seen.add(cars.frames.value));
      cars.update(const [NearbyCar(lat: 9.0, lng: 38.7, heading: 90), NearbyCar(lat: 9.01, lng: 38.71)]);
      expect(cars.frames.value, hasLength(2));
      expect(cars.frames.value.first.opacity, 0);
      now = now.add(const Duration(milliseconds: 200));
      cars.tick(now);
      expect(cars.frames.value.first.opacity, closeTo(0.5, 0.01));
      now = now.add(const Duration(milliseconds: 300));
      cars.tick(now);
      expect(cars.frames.value.first.opacity, 1);
      // the second car leaves: it fades out, then is dropped
      cars.update(const [NearbyCar(lat: 9.0, lng: 38.7, heading: 90)]);
      expect(cars.frames.value, hasLength(2));
      now = now.add(const Duration(milliseconds: 200));
      cars.tick(now);
      expect(cars.frames.value.last.opacity, closeTo(0.5, 0.01));
      now = now.add(const Duration(milliseconds: 300));
      cars.tick(now);
      expect(cars.frames.value, hasLength(1));
      expect(cars.lead!.position.latitude, 9.0);
      // nothing moves: the ticker stops
      expect(cars.isTicking, isFalse);
      cars.paused = true;
      cars.update(const [NearbyCar(lat: 9.0005, lng: 38.7, heading: 90)]);
      expect(cars.isTicking, isFalse);
      cars.paused = false;
      expect(cars.isTicking, isTrue);
      cars.dispose();
    });

    testWidgets('a parked car keeps facing the same way though the server heading wobbles between polls', (tester) async {
      var now = DateTime.utc(2026, 10, 27, 9);
      final cars = CarsAnimator(vsync: const _TestVsync(), now: () => now);
      cars.update(const [NearbyCar(lat: 9.0, lng: 38.7, heading: 90)]);
      for (final h in [0.0, 250.0, 0.0, 12.0]) {
        now = now.add(const Duration(seconds: 10));
        cars.update([NearbyCar(lat: 9.0, lng: 38.7, heading: h)]);
        for (var ms = 0; ms <= 3000; ms += 100) {
          cars.tick(now.add(Duration(milliseconds: ms)));
          expect(cars.frames.value.single.bearing, closeTo(90, 1e-6));
        }
      }
      cars.dispose();
    });

    testWidgets('two cars that pass each other keep their identities (closest pair first)', (tester) async {
      var now = DateTime.utc(2026, 10, 27, 9);
      final cars = CarsAnimator(vsync: const _TestVsync(), now: () => now);
      // two cars 50 m apart on one street, both driving east; the server lists them nearest first
      const lngPerM = 1 / 109950;
      cars.update(const [NearbyCar(lat: 9.0, lng: 38.7, heading: 90), NearbyCar(lat: 9.0, lng: 38.7 + 50 * lngPerM, heading: 90)]);
      final ids = [for (final f in cars.frames.value) f.id];
      now = now.add(const Duration(seconds: 10));
      // the back one drove 40 m (now 10 m behind where the front one was), the front one 45 m
      cars.update(const [NearbyCar(lat: 9.0, lng: 38.7 + 40 * lngPerM, heading: 90), NearbyCar(lat: 9.0, lng: 38.7 + 95 * lngPerM, heading: 90)]);
      final idOf = {38.7 + 40 * lngPerM: ids[0], 38.7 + 95 * lngPerM: ids[1]};
      cars.tick(now.add(const Duration(seconds: 3)));
      for (final f in cars.frames.value) {
        expect(f.id, idOf.entries.firstWhere((e) => (e.key - f.lng).abs() < 1e-7).value, reason: 'a car swapped with its neighbour');
        expect(f.bearing, closeTo(90, 1e-6));
      }
      cars.dispose();
    });
  });
}

class _TestVsync implements TickerProvider {
  const _TestVsync();
  @override
  Ticker createTicker(TickerCallback onTick) => Ticker(onTick);
}
