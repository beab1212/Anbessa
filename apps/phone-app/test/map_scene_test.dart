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
import 'package:phone_app/features/maps/scene/car3d.dart';
import 'package:phone_app/features/maps/scene/map_scene.dart';
import 'package:phone_app/features/maps/scene/scene_geojson.dart';
import 'package:phone_app/features/maps/scene/scene_images.dart';
import 'package:phone_app/features/maps/scene/scene_style.dart';
import 'package:ride_app_core/ride_app_core.dart';

Map<String, dynamic> parse(String s) => jsonDecode(s) as Map<String, dynamic>;
List<dynamic> features(String s) => parse(s)['features'] as List<dynamic>;

void main() {
  group('booked rides, 3D cars, the pulse and labels', () {
    test('once booked, the pickup is a plain pin without the photo', () {
      final avatar = features(pinsGeoJson(pickup: (lat: 9.0, lng: 38.7)));
      final plain = features(pinsGeoJson(pickup: (lat: 9.0, lng: 38.7), plainPickup: true));
      expect(avatar.single['properties']['pin'], SceneIds.imgPinPickup);
      expect(plain.single['properties']['pin'], SceneIds.imgPinPickupPlain);
    });

    test('in 3D a car carries its standing frame for its heading; flat cars carry none', () {
      String frame(double b) => car3dImageId(car3dFrameFor(b, 0));
      final flat = features(driverGeoJson(at: (lat: 9.0, lng: 38.7), bearing: 95));
      final standing = features(driverGeoJson(at: (lat: 9.0, lng: 38.7), bearing: 95, frame3d: frame, stale: true));
      expect(flat.single['properties'].containsKey('car3d'), isFalse);
      expect(standing.single['properties']['car3d'], true);
      expect(standing.single['properties']['icon3'], 'anb-car3d-10');
      expect(standing.single['properties']['opacity'], 0.55);
      final cars = features(nearbyGeoJson(const [NearbyCarFrame(id: 1, lat: 9, lng: 38.7, bearing: 180)], frame3d: frame));
      expect(cars.single['properties']['icon3'], 'anb-car3d-18');
    });

    test('the frame is the heading relative to the camera, every 10°, the short way round', () {
      expect(car3dFrameFor(0, 0), 0);
      expect(car3dFrameFor(94, 0), 9);
      expect(car3dFrameFor(96, 0), 10);
      // the map turned with the car (navigation): seen from behind
      expect(car3dFrameFor(250, 250), 0);
      expect(car3dFrameFor(10, 350), 2);
      expect(car3dFrameFor(356, 0), 0);
      expect(car3dFrameFor(-90, 0), 27);
    });

    test('every frame paints, the car centred on its ground point', () {
      final img = car3dImage(7, 2);
      expect(img.width, img.height);
      expect(img.width, (car3dImageSize * 2).ceil());
    });

    test('the pulse: two still rings and two waves half a period apart, nothing without a point', () {
      expect(features(pulseGeoJson(null, 0.3)), isEmpty);
      final rings = features(pulseGeoJson((lat: 9.0, lng: 38.7), 0.25));
      expect(rings, hasLength(4));
      final waves = rings.skip(2).map((f) => f['properties']).toList();
      expect(waves[0]['r'], lessThan(waves[1]['r']));
      expect(waves[0]['o'], greaterThan(waves[1]['o']));
    });

    test('labels at points carry their image', () {
      final f = features(calloutsGeoJson(const [SceneCallout(point: (lat: 9.0, lng: 38.7), image: 'anb-callout-x', lift: 48)]));
      expect(f.single['properties']['img'], 'anb-callout-x');
    });

    test('a lifted label has the room under its tail in its image', () {
      final plain = labelImage(AnbessaColors.light, 1, 'Arrive 14:32');
      final lifted = labelImage(AnbessaColors.light, 1, 'Arrive 14:32', lift: 48);
      expect(lifted.height - plain.height, 48);
    });

    test('flat and standing car layers never draw the same car', () {
      final layers = sceneLayers(SceneLook(colors: AnbessaColors.light, buildings: true, imageScale: 3));
      T layer<T extends ml.StyleLayer>(String id) => layers.firstWhere((l) => l.id == id) as T;
      for (final id in [SceneIds.driverCar, SceneIds.driverShadow, SceneIds.nearbyCars, SceneIds.nearbyShadow]) {
        expect(layer<ml.SymbolStyleLayer>(id).filter, ['!=', ['get', 'car3d'], true]);
      }
      for (final id in [SceneIds.driverCar3d, SceneIds.nearbyCar3d]) {
        final l = layer<ml.SymbolStyleLayer>(id);
        expect(l.filter, ['==', ['get', 'car3d'], true]);
        expect(l.layout['icon-image'], ['get', 'icon3']);
        // standing up, facing the screen; the frame already accounts for the turn
        expect(l.layout['icon-pitch-alignment'], 'viewport');
        expect(l.layout['icon-rotation-alignment'], 'viewport');
        expect(l.layout.containsKey('icon-rotate'), isFalse);
      }
      final pulse = layer<ml.CircleStyleLayer>(SceneIds.pulseLayer);
      expect(pulse.paint['circle-pitch-alignment'], 'map');
    });
  });

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

    test('3D cars: sized with the zoom, never past the image, a sensible minimum', () {
      for (final (id, stops) in [(SceneIds.driverCar, driverCarWidthStops), (SceneIds.nearbyCars, nearbyCarWidthStops)]) {
        final size = layer<ml.SymbolStyleLayer>(id).layout['icon-size']! as List;
        expect(size.sublist(0, 3), [
          'interpolate',
          ['exponential', 1.5],
          ['zoom'],
        ]);
        final values = [for (var i = 4; i < size.length; i += 2) size[i] as double];
        expect(values, hasLength(stops.length));
        // grows with the zoom, from at least 12 px wide, and only ever scales the image down
        for (var i = 1; i < values.length; i++) {
          expect(values[i], greaterThan(values[i - 1]));
        }
        expect(values.first * carImageWidth * look.imageScale, greaterThanOrEqualTo(12));
        expect(values.last, lessThanOrEqualTo(1 / look.imageScale));
        expect(layer<ml.SymbolStyleLayer>(id).layout['icon-anchor'], 'center');
      }
      // the followed car is never smaller than the cars around
      for (var i = 0; i < driverCarWidthStops.length; i++) {
        expect(driverCarWidthStops[i].$2, greaterThanOrEqualTo(nearbyCarWidthStops[i].$2));
      }
    });

    test('a soft contact shadow lies right under each car, the same size, flat on the map', () {
      final ids = layers.map((l) => l.id).toList();
      for (final (shadow, car) in [(SceneIds.driverShadow, SceneIds.driverCar), (SceneIds.nearbyShadow, SceneIds.nearbyCars)]) {
        expect(ids.indexOf(shadow), ids.indexOf(car) - 1);
        final s = layer<ml.SymbolStyleLayer>(shadow), c = layer<ml.SymbolStyleLayer>(car);
        expect(s.sourceId, c.sourceId);
        expect(s.layout['icon-image'], SceneIds.imgCarShadow);
        for (final k in ['icon-size', 'icon-rotate', 'icon-rotation-alignment', 'icon-pitch-alignment', 'icon-anchor']) {
          expect(s.layout[k], c.layout[k], reason: k);
        }
      }
      expect(layer<ml.SymbolStyleLayer>(SceneIds.nearbyShadow).paint['icon-opacity'], ['get', 'opacity']);
      // the shadow image has room for its blur around the car's footprint
      final car = carImage(AnbessaColors.light, 3), shadow = carShadowImage(AnbessaColors.light, 3);
      expect(shadow.width, greaterThan(car.width + 3 * 10));
      expect(shadow.height, greaterThan(car.height + 3 * 10));
      // the car image is painted at its largest shown size, crisp at the device's pixel ratio
      expect(car.width, ((carImageWidth + 2) * 3).ceil());
    });

    test('labels over cars rise with the car as it grows', () {
      for (final id in [SceneIds.driverLabel, SceneIds.nearbyLabel]) {
        final off = layer<ml.SymbolStyleLayer>(id).layout['icon-offset']! as List;
        expect(off.first, 'interpolate');
        final ys = [for (var i = 4; i < off.length; i += 2) ((off[i] as List)[1] as List)[1] as double];
        for (var i = 1; i < ys.length; i++) {
          expect(ys[i], lessThan(ys[i - 1]));
        }
      }
    });

    test('the car is drawn above the routes and pins', () {
      final ids = layers.map((l) => l.id).toList();
      expect(ids.indexOf(SceneIds.driverCar), greaterThan(ids.indexOf(SceneIds.routeFill)));
      expect(ids.indexOf(SceneIds.driverCar), greaterThan(ids.indexOf(SceneIds.pinLayer)));
      expect(ids.indexOf(SceneIds.driverCar3d), greaterThan(ids.indexOf(SceneIds.pinLayer)));
      // only the labels at points are drawn over the car's label
      expect(ids.last, SceneIds.calloutLayer);
      expect(ids[ids.length - 2], SceneIds.driverLabel);
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
