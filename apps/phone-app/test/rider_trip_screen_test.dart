// The rider's trip stage in the map shell, in the GoRide kit's look, at each stage, in light and
// dark, with large text (1.3×) on a 360 dp phone: finding a driver (rings around the rider at the
// pickup), the driver heading over (car line, driver row, PIN, ride and fare cards, Cancel Ride),
// Driver Information, arrived, heading to the destination ("Arrive HH:MM"), "You have arrived!"
// (stats, fare, Finish), "Ride has been canceled!"; a stage change in place; no tab bar.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:phone_app/core/router/routes.dart';
import 'package:phone_app/features/maps/anbessa_map.dart';
import 'package:phone_app/features/maps/nav/navigation_controller.dart';
import 'package:phone_app/features/rider/rating/rating_screen.dart';
import 'package:phone_app/features/rider/shell/rider_map_shell.dart';
import 'package:phone_app/features/rider/trip/active_trip_controller.dart';
import 'package:ride_app_core/ride_app_core.dart';

import 'support/fakes.dart';
import 'support/rider_shell.dart';

Trip tripAt(String status, {bool withDriver = true}) => Trip.fromJson(tripJson(status, withDriver: withDriver));

Map<String, dynamic> tripJson(String status, {bool withDriver = true}) {
  final j = Map<String, dynamic>.from(fixture('trip.json'));
  j['status'] = status;
  if (!withDriver) j['driver'] = null;
  if (status == 'en_route') j['times'] = {...asJson(j['times']), 'arrivedAt': '2026-10-27T09:10:00Z'};
  if (status == 'completed') {
    j['times'] = {...asJson(j['times']), 'completedAt': '2026-10-27T09:30:00Z'};
    j['fare'] = {...asJson(j['fare']), 'finalMinor': 14000, 'payableMinor': 14000}; // the server recomputes what the rider pays
  }
  return j;
}

Future<ShellHarness> pumpTrip(WidgetTester tester, Trip trip, {Brightness brightness = Brightness.light, FakeBackend? backend}) => pumpRiderShell(
      tester,
      at: '/rider/trip/${trip.id}',
      brightness: brightness,
      backend: backend,
      overrides: [
        activeTripProvider.overrideWith(() => FixedActiveTrip(trip)),
        tripPartiesProvider.overrideWith((ref, id) async => const TripParties(driverName: 'Almaz Tadesse', driverRating: 4.8, driverRatingCount: 12, vehicle: PartyVehicle(plateNumber: '3-A40402', make: 'Hyundai', model: 'Atos', color: 'Blue', vehicleType: 'economy'))),
        driverLiveProvider.overrideWith((ref, id) => Stream.value(DriverLive(lat: trip.pickup.lat + 0.01, lng: trip.pickup.lng, heading: 180, speed: 8, at: DateTime.now().toUtc()))),
        routeFetcherProvider.overrideWithValue(({required fromLat, required fromLng, required toLat, required toLng, steps = false}) async => const RouteSteps(polyline6: '', distanceMeters: 1200, durationSeconds: 240, approximate: true, steps: [])),
      ],
    );

void main() {
  testWidgets('finding a driver: the rings at the pickup, time searching, Cancel Ride; no tab bar', (tester) async {
    final t = tripAt('requested', withDriver: false);
    final h = await pumpTrip(tester, t);
    expect(find.text('Finding you a nearby driver...'), findsOneWidget);
    expect(find.text('Cancel Ride'), findsOneWidget);
    expect(find.byType(LocatingDot), findsOneWidget);
    // the rings sit on the map at the pickup, the rider's avatar in them (no pickup pin)
    final map = tester.widget<AnbessaMap>(find.byType(AnbessaMap));
    expect(map.overlays.single.point, LatLng(t.pickup.lat, t.pickup.lng));
    expect(map.overlays.single.child, isA<RadarRings>());
    expect(map.pickup, isNull);
    expect(find.byType(ElapsedText), findsOneWidget);
    expect(find.byType(RoutePointsCard), findsOneWidget);
    expect(find.byTooltip('Share trip'), findsNothing); // nothing to follow until a driver is on it
    expect(find.byType(NavigationBar), findsNothing);
    expect(tester.takeException(), isNull);
    await endShell(tester, h);
  });

  for (final b in Brightness.values) {
    testWidgets('driver heading over: car line, photo (Hero), name, rating, cards, share and SOS (${b.name})', (tester) async {
      final t = tripAt('matched');
      final h = await pumpTrip(tester, t, brightness: b);
      expect(find.text('Driver is heading to your location...'), findsOneWidget);
      expect(find.textContaining('Driver will arrive in'), findsOneWidget);
      expect(find.text('Hyundai Atos, Blue · 3-A40402'), findsOneWidget);
      expect(find.text('Almaz Tadesse'), findsOneWidget);
      expect(find.text('4.8 (12)'), findsOneWidget);
      expect(find.byWidgetPredicate((w) => w is Hero && w.tag == driverAvatarHeroTag(t.id)), findsOneWidget);
      expect(find.byType(KeyValueCard), findsNWidgets(2));
      expect(find.text('Trip Fare'), findsOneWidget);
      expect(find.text('Cancel Ride'), findsOneWidget);
      expect(find.byTooltip('Share trip'), findsOneWidget);
      expect(find.byTooltip('SOS'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await endShell(tester, h);
    });
  }

  testWidgets('the driver row opens Driver Information', (tester) async {
    final h = await pumpTrip(tester, tripAt('matched'));
    await tapText(tester, 'Almaz Tadesse');
    expect(find.text('Driver Information'), findsOneWidget);
    expect(find.byType(StatTriple), findsOneWidget);
    expect(find.text('Car Model'), findsOneWidget);
    expect(find.text('Hyundai Atos'), findsOneWidget);
    expect(find.text('Plate Number'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await endShell(tester, h);
  });

  testWidgets('arrived, then heading to the destination with "Arrive HH:MM", in dark mode', (tester) async {
    var h = await pumpTrip(tester, tripAt('en_route'), brightness: Brightness.dark);
    expect(find.text('Your driver is here'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await endShell(tester, h);
    h = await pumpTrip(tester, tripAt('in_progress'), brightness: Brightness.dark);
    expect(find.text('Heading to destination...'), findsOneWidget);
    expect(find.byKey(const ValueKey('arrive-at')), findsOneWidget);
    expect(find.textContaining(RegExp(r'^Arrive \d\d:\d\d$')), findsWidgets);
    expect(find.text('Cancel Ride'), findsNothing);
    expect(tester.takeException(), isNull);
    await endShell(tester, h);
  });

  testWidgets('a stage change swaps the sheet in place, on the same map', (tester) async {
    final h = await pumpTrip(tester, tripAt('matched'));
    final map = tester.state(find.byType(RiderMapShell));
    h.container.read(activeTripProvider.notifier).replace(tripAt('in_progress'));
    await settle(tester);
    expect(find.text('Heading to destination...'), findsOneWidget);
    expect(tester.state(find.byType(RiderMapShell)), same(map)); // the shell (and its map) stayed
    expect(tester.takeException(), isNull);
    await endShell(tester, h);
  });

  for (final b in Brightness.values) {
    testWidgets('completed: "You have arrived!", the stats, the total and Finish (${b.name})', (tester) async {
      final t = tripAt('completed');
      final h = await pumpTrip(tester, t, brightness: b);
      expect(find.text('You have arrived!'), findsOneWidget);
      expect(find.byType(StatTriple), findsOneWidget);
      expect(find.text('Duration'), findsOneWidget);
      expect(find.text('Avg. Speed'), findsOneWidget);
      expect(find.text(birr(14000)), findsWidgets);
      expect(find.text('Total Paid'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.ensureVisible(find.byKey(const ValueKey('finish')));
      await tester.tap(find.byKey(const ValueKey('finish')));
      await settle(tester);
      // a digital payment goes to the pay page; cash would go straight to the rating
      expect(locationOf(h.router), t.isDigital ? Routes.riderPay(t.id) : Routes.riderRate(t.id));
      await endShell(tester, h);
    });
  }

  testWidgets('completed with a promo: the rider pays the fare minus the discount', (tester) async {
    final j = Map<String, dynamic>.from(fixture('trip.json'));
    j['status'] = 'completed';
    j['times'] = {...asJson(j['times']), 'completedAt': '2026-10-27T09:30:00Z'};
    j['fare'] = {...asJson(j['fare']), 'finalMinor': 14000, 'promoDiscountMinor': 3000, 'promoCode': 'WELCOME30', 'payableMinor': 11000};
    final h = await pumpTrip(tester, Trip.fromJson(j), brightness: Brightness.dark);
    expect(find.text(birr(11000)), findsWidgets);
    expect(find.text('Discounts (WELCOME30)'), findsOneWidget);
    expect(find.text('−${birr(3000)}'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await endShell(tester, h);
  });

  for (final b in Brightness.values) {
    testWidgets('cancelled: "Ride has been canceled!", OK goes home (${b.name})', (tester) async {
      final h = await pumpTrip(tester, tripAt('cancelled'), brightness: b);
      expect(find.text('Ride has been canceled!'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.tap(find.byKey(const ValueKey('canceled-ok')));
      await settle(tester);
      expect(locationOf(h.router), Routes.riderHome);
      await endShell(tester, h);
    });
  }

  for (final b in Brightness.values) {
    testWidgets('rating: "How was the driver?", stars, what stood out, the cards, Give Rate, thanks (${b.name})', (tester) async {
      final t = tripAt('completed');
      final backend = FakeBackend();
      backend.on('POST', '/api/trips/${t.id}/rating', (_) => {'ok': true});
      backend.on('GET', '/api/trips/${t.id}', (_) => {'trip': tripJson('completed')});
      final h = await pumpTrip(tester, t, brightness: b, backend: backend);
      h.router.go(Routes.riderRate(t.id));
      await settle(tester);
      expect(find.text('How was the driver?'), findsOneWidget);
      expect(find.byType(RatingStars), findsOneWidget);
      expect(find.text('What stood out?'), findsNothing);
      expect(find.text('Total Paid'), findsOneWidget);
      expect(tester.widget<PrimaryButton>(find.byKey(const ValueKey('give-rate'))).onPressed, isNull);
      expect(tester.takeException(), isNull);
      await tester.tap(find.byIcon(Icons.star_outline_rounded).last);
      await settle(tester);
      expect(find.text('What stood out?'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('Hide details'), 200, scrollable: find.descendant(of: find.byType(RatingScreen), matching: find.byType(Scrollable)).first);
      await tapText(tester, 'Hide details');
      expect(find.text('Total Paid'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('give-rate')));
      await settle(tester);
      expect(backend.bodies('POST', '/api/trips/${t.id}/rating').single['stars'], 5);
      expect(find.text('Thanks for your feedback!'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.tap(find.byKey(const ValueKey('thanks-ok')));
      await settle(tester);
      expect(locationOf(h.router), Routes.riderHome);
      await endShell(tester, h);
    });
  }
}
