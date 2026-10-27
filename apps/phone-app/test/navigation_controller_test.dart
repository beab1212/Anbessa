import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/features/maps/nav/navigation_controller.dart';
import 'package:ride_app_core/ride_app_core.dart';

void main() {
  // an L-shaped route: east along a street, then north
  const start = (lat: 9.0107, lng: 38.7613);
  const corner = (lat: 9.0107, lng: 38.7713);
  const end = (lat: 9.0207, lng: 38.7713);
  final route = [start, corner, end];
  final polyline = encodePolyline6(route);
  var fetches = 0;

  RouteSteps fake({required double fromLat, required double fromLng, required double toLat, required double toLng, bool steps = false}) {
    fetches++;
    return RouteSteps(
      polyline6: polyline,
      distanceMeters: totalMeters(route).round(),
      durationSeconds: 300,
      approximate: false,
      steps: [
        RouteStep(type: 'depart', lat: start.lat, lng: start.lng, bearingAfter: 90, name: 'Africa Avenue', distanceMeters: 1100, durationSeconds: 150),
        RouteStep(type: 'turn', modifier: 'left', lat: corner.lat, lng: corner.lng, bearingAfter: 0, name: 'Churchill Avenue', distanceMeters: 1100, durationSeconds: 150),
        RouteStep(type: 'arrive', lat: end.lat, lng: end.lng, bearingAfter: 0, name: '', distanceMeters: 0, durationSeconds: 0),
      ],
    );
  }

  late ProviderContainer c;
  final target = NavTarget(lat: end.lat, lng: end.lng);
  setUp(() {
    fetches = 0;
    c = ProviderContainer(overrides: [routeFetcherProvider.overrideWithValue(({required fromLat, required fromLng, required toLat, required toLng, steps = false}) async => fake(fromLat: fromLat, fromLng: fromLng, toLat: toLat, toLng: toLng, steps: steps))]);
    c.listen(navigationProvider(target), (_, _) {});
  });
  tearDown(() => c.dispose());

  test('reports the next turn and the distance to it as the car moves', () async {
    final nav = c.read(navigationProvider(target).notifier);
    await nav.start(start);
    var s = c.read(navigationProvider(target));
    expect(s.hasRoute, isTrue);
    expect(s.nextStep!.modifier, 'left');
    expect(s.metersToManeuver, closeTo(1100, 30));
    // a third of the way along the first leg
    nav.update((lat: 9.0107, lng: 38.7646), speed: 10);
    s = c.read(navigationProvider(target));
    expect(s.metersToManeuver, closeTo(735, 40));
    expect(s.remainingMeters, closeTo(1835, 60));
    expect(s.traversed.length, 2);
    expect(s.remaining.length, 3);
    expect(s.offRoute, isFalse);
    // past the corner: the next step is the arrival
    nav.update((lat: 9.0150, lng: 38.7713));
    s = c.read(navigationProvider(target));
    expect(s.nextStep!.type, 'arrive');
    expect(fetches, 1);
  });

  test('asks for a new route after staying off the road for 8 s, at most every 20 s', () async {
    var now = DateTime.utc(2026, 10, 27, 9);
    final nav = c.read(navigationProvider(target).notifier)..now = () => now;
    await nav.start(start);
    const off = (lat: 9.0127, lng: 38.7646); // ~220 m north of the first leg
    nav.update(off);
    expect(c.read(navigationProvider(target)).offRoute, isTrue);
    expect(fetches, 1);
    now = now.add(const Duration(seconds: 5));
    nav.update(off);
    expect(fetches, 1); // not yet 8 s off the road
    now = now.add(const Duration(seconds: 4));
    nav.update(off);
    expect(fetches, 1); // 9 s off, but the last route is only 9 s old (< 20 s)
    now = now.add(const Duration(seconds: 15));
    nav.update(off);
    await Future<void>.delayed(Duration.zero);
    expect(fetches, 2);
  });
}
