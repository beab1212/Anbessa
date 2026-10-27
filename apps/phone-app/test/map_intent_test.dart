// The rider map shell's pure parts: "Arrive HH:MM", the growing route, intent equality (a rebuild
// with the same state must not look like a new intent), and the choose-ride and trip intents
// derived from state.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:phone_app/core/network/providers.dart';
import 'package:phone_app/features/maps/anbessa_map.dart';
import 'package:phone_app/features/rider/booking/booking_controller.dart';
import 'package:phone_app/features/rider/shell/map_intent.dart';
import 'package:phone_app/features/rider/trip/active_trip_controller.dart';
import 'package:phone_app/features/shell/shells.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';

void main() {
  test('arrive at: now + the car to the pickup + the ride, in local time', () {
    final now = DateTime(2026, 10, 27, 14, 10, 30);
    final at = arriveAt(now, etaSeconds: 240, durationSeconds: 1080);
    expect(at, DateTime(2026, 10, 27, 14, 32, 30));
    expect(clockHHmm(at), '14:32');
    expect(clockHHmm(DateTime(2026, 1, 1, 7, 5)), '07:05');
    // past midnight
    expect(clockHHmm(arriveAt(DateTime(2026, 10, 27, 23, 50), etaSeconds: 300, durationSeconds: 900)), '00:10');
  });

  test('minutes for a label are whole and at least 1', () {
    expect(minutesCeil(20), 1);
    expect(minutesCeil(60), 1);
    expect(minutesCeil(61), 2);
    expect(minutesCeil(240), 4);
  });

  test('the route grows from its start', () {
    const pts = [LatLng(9, 38.7), LatLng(9, 38.71), LatLng(9, 38.72)];
    expect(routePrefix(pts, 1), same(pts));
    expect(routePrefix(pts, 0), hasLength(2));
    final half = routePrefix(pts, 0.5);
    expect(half.first, pts.first);
    expect(half.last.longitude, closeTo(38.71, 1e-6));
    final quarter = routePrefix(pts, 0.25);
    expect(quarter, hasLength(2));
    expect(quarter.last.longitude, closeTo(38.705, 1e-6));
  });

  test('intents with the same content are equal; a moved pin is not', () {
    final line = RouteLine(const [LatLng(9, 38.7), LatLng(9.01, 38.71)]);
    MapIntent a(LatLng p) => MapIntent(pickup: p, routes: [line], fit: const [LatLng(9, 38.7)], fitKey: 'k', callouts: [IntentCallout.minutes(p, 4)]);
    expect(a(const LatLng(9, 38.7)), a(const LatLng(9, 38.7)));
    expect(a(const LatLng(9, 38.7)) == a(const LatLng(9.001, 38.7)), isFalse);
    // the same points in a new list are the same road
    expect(sameRoutes([line], [RouteLine(List.of(line.points))]), isTrue);
    expect(sameRoutes([line], [RouteLine(line.points, kind: RouteKind.secondary)]), isFalse);
  });

  test('the tab bar hides on the booking and trip stages only', () {
    expect(riderTabsHiddenAt(Uri.parse('/rider/home')), isFalse);
    expect(riderTabsHiddenAt(Uri.parse('/rider/activity')), isFalse);
    expect(riderTabsHiddenAt(Uri.parse('/rider/book/route?focus=dropoff')), isTrue);
    expect(riderTabsHiddenAt(Uri.parse('/rider/book/quote')), isTrue);
    expect(riderTabsHiddenAt(Uri.parse('/rider/trip/t1')), isTrue);
  });

  group('derived intents', () {
    late ProviderContainer c;
    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      c = ProviderContainer(overrides: [prefsProvider.overrideWithValue(prefs)]);
      addTearDown(c.dispose);
    });

    test('choose ride: the road revealed once, "N min" at the pickup, "Arrive" at the drop-off', () {
      final est = Estimates.fromJson({...fixture('estimates_promo.json'), 'route': {'polyline6': encodePolyline6(const [(lat: 9.0107, lng: 38.7613), (lat: 9.0, lng: 38.78), (lat: 8.9779, lng: 38.7993)]), 'distanceMeters': 7400, 'durationSeconds': 1080}});
      final b = c.read(bookingProvider.notifier);
      b.setPickup(const Place(name: 'Meskel Square', lat: 9.0107, lng: 38.7613), quote: false);
      b.setDropoff(const Place(name: 'Bole', lat: 8.9779, lng: 38.7993), quote: false);
      // before the quote: a straight line, no reveal
      var i = c.read(quoteMapIntentProvider);
      expect(i.routes.single.kind, RouteKind.straight);
      expect(i.revealKey, isNull);
      // the quote lands
      c.read(bookingProvider.notifier).state = c.read(bookingProvider).copyWith(quotes: est.quotes, route: est.route, vehicleType: 'economy');
      i = c.read(quoteMapIntentProvider);
      expect(i.routes.single.points, hasLength(3));
      expect(i.revealKey, est.route!.polyline6);
      expect(i.callouts.first.kind, IntentCalloutKind.minutes);
      expect(i.callouts.first.minutes, 4);
      expect(i.callouts.last.kind, IntentCalloutKind.arriveAt);
      expect(i.callouts.last.point, const LatLng(8.9779, 38.7993));
      final expected = DateTime.now().add(const Duration(seconds: 240 + 1080));
      expect(i.callouts.last.time!.difference(expected).inSeconds.abs(), lessThan(5));
      // the same state again is the same intent (the map doesn't refit)
      expect(c.read(quoteMapIntentProvider), i);
      // re-quoting after a change: the old road stays, dimmed
      c.read(bookingProvider.notifier).state = c.read(bookingProvider).copyWith(quotes: const [], clearRoute: true, quoting: true);
      i = c.read(quoteMapIntentProvider);
      expect(i.routes.single.kind, RouteKind.secondary);
      expect(i.routes.single.points, hasLength(3));
    });

    test('riding: the road behind the car is grey, the road ahead amber', () async {
      final road = encodePolyline6(const [(lat: 9.00, lng: 38.70), (lat: 9.00, lng: 38.72), (lat: 9.00, lng: 38.74)]);
      final j = Map<String, dynamic>.from(fixture('trip.json'));
      j['status'] = 'in_progress';
      j['route'] = {...asJson(j['route']), 'polyline': road};
      final trip = Trip.fromJson(j);
      final c2 = ProviderContainer(overrides: [
        activeTripProvider.overrideWith(() => FixedActiveTrip(trip)),
        driverLiveProvider.overrideWith((ref, id) => Stream.value(DriverLive(lat: 9.0001, lng: 38.725, heading: 90, at: DateTime.now().toUtc()))),
      ]);
      addTearDown(c2.dispose);
      final sub = c2.listen(tripMapIntentProvider(trip.id), (_, _) {});
      addTearDown(sub.close);
      await c2.read(activeTripProvider.future);
      await c2.read(driverLiveProvider(trip.id).future);
      final i = c2.read(tripMapIntentProvider(trip.id));
      expect(i.car, isTrue);
      expect(i.routes.map((r) => r.kind), [RouteKind.traversed, RouteKind.primary]);
      expect(i.routes.first.points.last.longitude, closeTo(38.725, 1e-3));
      expect(i.routes.last.points.last, const LatLng(9.0, 38.74));
      expect(i.carRoad, hasLength(3));
      expect(i.pickup, isNull); // picked up
      expect(i.callouts.single.kind, IntentCalloutKind.arriveAt);
    });
  });
}
