// NavigationController: progress along the route (monotonic, never onto the other pass of a road
// the route drives twice), the next turn and distances, reroute rules (off the route for 6 s,
// the wrong way for 5 s, at most every 15 s / 60 s when approximate), the heading-aware reroute,
// the arrival geofence, and being driven by the location stream rather than a widget build.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/core/location/location_source.dart';
import 'package:phone_app/features/maps/nav/navigation_controller.dart';
import 'package:ride_app_core/ride_app_core.dart';

typedef Fetch = ({double fromLat, double fromLng, double toLat, double toLng});

void main() {
  // an L-shaped route: east along a street, then north
  const start = (lat: 9.0107, lng: 38.7613);
  const corner = (lat: 9.0107, lng: 38.7713);
  const end = (lat: 9.0207, lng: 38.7713);

  RouteSteps lRoute({bool approximate = false}) => RouteSteps(
        polyline6: encodePolyline6([start, corner, end]),
        distanceMeters: totalMeters([start, corner, end]).round(),
        durationSeconds: 300,
        approximate: approximate,
        steps: [
          RouteStep(type: 'depart', lat: start.lat, lng: start.lng, bearingAfter: 90, name: 'Africa Avenue', distanceMeters: 1100, durationSeconds: 150),
          RouteStep(type: 'turn', modifier: 'left', lat: corner.lat, lng: corner.lng, bearingAfter: 0, name: 'Churchill Avenue', distanceMeters: 1100, durationSeconds: 150),
          RouteStep(type: 'arrive', lat: end.lat, lng: end.lng, bearingAfter: 0, name: '', distanceMeters: 0, durationSeconds: 0),
        ],
      );

  late List<Fetch> fetches;
  late RouteSteps Function(Fetch f) answer;
  late ProviderContainer c;
  late NavTarget target;
  late DateTime now;

  ProviderContainer make() {
    final container = ProviderContainer(overrides: [
      routeFetcherProvider.overrideWithValue(({required fromLat, required fromLng, required toLat, required toLng, steps = false}) async {
        final f = (fromLat: fromLat, fromLng: fromLng, toLat: toLat, toLng: toLng);
        fetches.add(f);
        return answer(f);
      }),
    ]);
    container.listen(navigationProvider(target), (_, _) {});
    return container;
  }

  NavigationController nav() => c.read(navigationProvider(target).notifier)..now = () => now;
  NavState st() => c.read(navigationProvider(target));

  setUp(() {
    fetches = [];
    answer = (_) => lRoute();
    target = NavTarget(lat: end.lat, lng: end.lng);
    now = DateTime.utc(2026, 10, 27, 9);
    c = make();
  });
  tearDown(() => c.dispose());

  test('reports the next turn and the distances as the car moves', () async {
    final n = nav();
    await n.start(start);
    var s = st();
    expect(s.hasRoute, isTrue);
    expect(s.nextStep!.modifier, 'left');
    expect(s.metersToManeuver, closeTo(1100, 30));
    // a third of the way along the first leg
    n.update((lat: 9.0107, lng: 38.7646), speed: 10);
    s = st();
    expect(s.metersToManeuver, closeTo(735, 40));
    expect(s.remainingMeters, closeTo(1835, 60));
    expect(s.traversed.length, 2);
    expect(s.remaining.length, 3);
    expect(s.offRoute, isFalse);
    expect(s.snapped!.lat, closeTo(start.lat, 1e-6), reason: 'snapped onto the street');
    expect(s.bearing, closeTo(90, 1));
    // past the corner: the next step is the arrival
    n.update((lat: 9.0150, lng: 38.7713), speed: 10);
    s = st();
    expect(s.nextStep!.type, 'arrive');
    expect(fetches, hasLength(1));
  });

  test('a state with the same values is equal (no rebuild for nothing)', () async {
    final n = nav();
    await n.start(start);
    final a = st();
    final b = a.copyWith();
    expect(a == b, isTrue);
    expect(a.hashCode, b.hashCode);
    n.update((lat: 9.0107, lng: 38.7646), speed: 10);
    expect(st() == a, isFalse);
  });

  test('is driven by the location stream, not by the screen', () async {
    // a fresh container whose controller reads the shift's positions
    c.dispose();
    c = make();
    final pos = c.read(lastPositionProvider.notifier);
    pos.set(DevicePosition(lat: start.lat, lng: start.lng, speed: 0, at: DateTime.now()));
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
    expect(fetches, hasLength(1));
    expect(st().hasRoute, isTrue);
    pos.set(DevicePosition(lat: 9.0107, lng: 38.7646, speed: 10, heading: 90, at: DateTime.now()));
    expect(st().metersToManeuver, closeTo(735, 40));
  });

  test('progress is monotonic: jitter behind the car and the return pass of the same road are ignored', () async {
    // out 300 m east along a street and straight back west along it (the road overlaps itself)
    const s0 = (lat: 9.0000, lng: 38.7500);
    const s1 = (lat: 9.0000, lng: 38.752729); // ~300 m east
    final pts = [s0, s1, s0];
    answer = (_) => RouteSteps(polyline6: encodePolyline6(pts), distanceMeters: 600, durationSeconds: 80, approximate: false, steps: const []);
    target = NavTarget(lat: 8.9900, lng: 38.7400); // away from the street: no arrival here
    c.dispose();
    c = make();
    GeoPoint east(double m) => (lat: 9.0000, lng: 38.7500 + m / 109950);
    final n = nav();
    await n.start(s0);
    n.update(east(100), speed: 20, heading: 90);
    expect(st().progressMeters!, closeTo(100, 5));
    // 200 m east, heading east: the outbound pass (200), not the return pass at the same spot (400),
    // although both are inside the search window
    n.update(east(200), speed: 20, heading: 90);
    final p1 = st().progressMeters!;
    expect(p1, closeTo(200, 5));
    // GPS jitter 15 m behind: progress stays
    n.update(east(185), speed: 20, heading: 90);
    expect(st().progressMeters, p1);
    expect(st().offRoute, isFalse);
    expect(st().wrongWay, isFalse);
    // past the end of the street and back: heading west at the same spot is the return pass
    n.update(east(290), speed: 10, heading: 90);
    n.update(east(250), speed: 10, heading: 270);
    expect(st().progressMeters!, closeTo(350, 8));
    expect(st().remainingMeters, closeTo(250, 10));
  });

  test('off the route for 6 s asks for a new route, at most every 15 s', () async {
    final n = nav();
    await n.start(start);
    const off = (lat: 9.0127, lng: 38.7646); // ~220 m north of the first leg
    n.update(off);
    expect(st().offRoute, isTrue);
    expect(fetches, hasLength(1));
    now = now.add(const Duration(seconds: 4));
    n.update(off);
    expect(fetches, hasLength(1)); // not yet 6 s off the road
    now = now.add(const Duration(seconds: 3));
    n.update(off);
    expect(fetches, hasLength(1)); // 7 s off, but the last route is only 7 s old (< 15 s)
    now = now.add(const Duration(seconds: 9));
    n.update(off);
    await Future<void>.delayed(Duration.zero);
    expect(fetches, hasLength(2));
  });

  test('an approximate route is asked for again at most every 60 s', () async {
    answer = (_) => lRoute(approximate: true);
    final n = nav();
    await n.start(start);
    const off = (lat: 9.0127, lng: 38.7646);
    n.update(off);
    now = now.add(const Duration(seconds: 30));
    n.update(off);
    expect(fetches, hasLength(1));
    now = now.add(const Duration(seconds: 31));
    n.update(off);
    await Future<void>.delayed(Duration.zero);
    expect(fetches, hasLength(2));
  });

  test('driving against the route for 5 s reroutes, with the heading', () async {
    final n = nav();
    await n.start(start, heading: 90, speed: 10);
    n.update((lat: 9.0107, lng: 38.7646), speed: 10, heading: 90);
    expect(st().wrongWay, isFalse);
    now = now.add(const Duration(seconds: 16));
    // turned round on the street: heading west
    n.update((lat: 9.0107, lng: 38.7640), speed: 10, heading: 270);
    expect(st().wrongWay, isTrue);
    expect(st().offRoute, isFalse);
    now = now.add(const Duration(seconds: 3));
    n.update((lat: 9.0107, lng: 38.7637), speed: 10, heading: 270);
    expect(fetches, hasLength(1));
    // the new route (from the fixture) starts east: a U-turn for a car going west, so it is
    // asked for again from 80 m ahead along the heading
    now = now.add(const Duration(seconds: 3));
    n.update((lat: 9.0107, lng: 38.7634), speed: 10, heading: 270);
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
    expect(fetches.length, greaterThanOrEqualTo(2));
    expect(fetches[1].fromLng, closeTo(38.7634, 1e-6));
    expect(fetches, hasLength(3));
    expect(fetches[2].fromLng, lessThan(38.7634), reason: 'the second request starts ahead (west) of the car');
  });

  test('a route that starts the way the car goes is kept as it is', () async {
    final n = nav();
    await n.start(start, heading: 90, speed: 10);
    expect(fetches, hasLength(1));
  });

  test('within 40 m of the target it says arrived', () async {
    final n = nav();
    await n.start(start);
    n.update((lat: 9.0150, lng: 38.7713), speed: 10, heading: 0);
    expect(st().arrived, isFalse);
    n.update((lat: 9.0204, lng: 38.7713), speed: 3, heading: 0);
    expect(st().arrived, isTrue);
    // and no reroute once there, even off the line
    now = now.add(const Duration(seconds: 30));
    n.update((lat: 9.0207, lng: 38.7720));
    now = now.add(const Duration(seconds: 30));
    n.update((lat: 9.0207, lng: 38.7720));
    await Future<void>.delayed(Duration.zero);
    expect(fetches, hasLength(1));
  });

  test('a failed route request says so and is tried again after 15 s', () async {
    var fail = true;
    answer = (_) => fail ? throw const AppError(status: 0, code: 'network', message: '') : lRoute();
    final n = nav();
    await n.start(start);
    expect(st().error, isNotNull);
    expect(st().hasRoute, isFalse);
    n.update(start);
    expect(st().error, isNotNull, reason: 'a fix keeps the error');
    expect(fetches, hasLength(1));
    fail = false;
    now = now.add(const Duration(seconds: 16));
    n.update(start);
    await Future<void>.delayed(Duration.zero);
    expect(fetches, hasLength(2));
    expect(st().hasRoute, isTrue);
    expect(st().error, isNull);
  });
}
