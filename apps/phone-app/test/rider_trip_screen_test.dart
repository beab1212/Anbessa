// The rider's trip stage in the map shell at each stage, in light and dark, with large text; a
// stage change in place; and the tab bar hidden.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:phone_app/features/maps/anbessa_map.dart';
import 'package:phone_app/features/maps/nav/navigation_controller.dart';
import 'package:phone_app/features/rider/shell/rider_map_shell.dart';
import 'package:phone_app/features/rider/trip/active_trip_controller.dart';
import 'package:ride_app_core/ride_app_core.dart';

import 'support/fakes.dart';
import 'support/rider_shell.dart';

Trip tripAt(String status, {bool withDriver = true}) {
  final j = Map<String, dynamic>.from(fixture('trip.json'));
  j['status'] = status;
  if (!withDriver) j['driver'] = null;
  if (status == 'en_route') j['times'] = {...asJson(j['times']), 'arrivedAt': '2026-10-27T09:10:00Z'};
  if (status == 'completed') {
    j['times'] = {...asJson(j['times']), 'completedAt': '2026-10-27T09:30:00Z'};
    j['fare'] = {...asJson(j['fare']), 'finalMinor': 14000, 'payableMinor': 14000}; // the server recomputes what the rider pays
  }
  return Trip.fromJson(j);
}

Future<ShellHarness> pumpTrip(WidgetTester tester, Trip trip, {Brightness brightness = Brightness.light}) => pumpRiderShell(
      tester,
      at: '/rider/trip/${trip.id}',
      brightness: brightness,
      overrides: [
        activeTripProvider.overrideWith(() => FixedActiveTrip(trip)),
        tripPartiesProvider.overrideWith((ref, id) async => const TripParties(driverName: 'Almaz Tadesse', driverRating: 4.8, driverRatingCount: 12, vehicle: PartyVehicle(plateNumber: '3-A40402', make: 'Hyundai', model: 'Atos', color: 'Blue', vehicleType: 'economy'))),
        driverLiveProvider.overrideWith((ref, id) => Stream.value(DriverLive(lat: trip.pickup.lat + 0.01, lng: trip.pickup.lng, heading: 180, speed: 8, at: DateTime.now().toUtc()))),
        routeFetcherProvider.overrideWithValue(({required fromLat, required fromLng, required toLat, required toLng, steps = false}) async => const RouteSteps(polyline6: '', distanceMeters: 1200, durationSeconds: 240, approximate: true, steps: [])),
      ],
    );

void main() {
  testWidgets('finding a driver: the pulse at the pickup, time searching, cancel; no tab bar', (tester) async {
    final t = tripAt('requested', withDriver: false);
    final h = await pumpTrip(tester, t);
    expect(find.text('Finding your driver'), findsOneWidget);
    expect(find.text('Cancel trip'), findsOneWidget);
    // the pulse sits on the map at the pickup
    final map = tester.widget<AnbessaMap>(find.byType(AnbessaMap));
    expect(map.overlays.single.point, LatLng(t.pickup.lat, t.pickup.lng));
    expect(map.overlays.single.child, isA<RadarPulse>());
    expect(find.byType(ElapsedText), findsOneWidget);
    expect(find.byTooltip('Share trip'), findsNothing); // nothing to follow until a driver is on it
    expect(find.byType(NavigationBar), findsNothing);
    expect(tester.takeException(), isNull);
    await endShell(tester, h);
  });

  testWidgets('driver assigned: photo (Hero), name, rating, car, plate, ETA, share and SOS', (tester) async {
    final t = tripAt('matched');
    final h = await pumpTrip(tester, t);
    expect(find.textContaining('Almaz Tadesse'), findsWidgets);
    expect(find.byType(PlateBadge), findsOneWidget);
    expect(find.textContaining('A40402'), findsOneWidget);
    expect(find.textContaining('4.8'), findsOneWidget);
    expect(find.text('Blue Hyundai Atos'), findsOneWidget);
    expect(find.textContaining('min'), findsWidgets);
    expect(find.byWidgetPredicate((w) => w is Hero && w.tag == driverAvatarHeroTag(t.id)), findsOneWidget);
    expect(find.byTooltip('Share trip'), findsOneWidget);
    expect(find.byTooltip('SOS'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await endShell(tester, h);
  });

  testWidgets('arrived, then riding with "Arrive HH:MM", in dark mode', (tester) async {
    var h = await pumpTrip(tester, tripAt('en_route'), brightness: Brightness.dark);
    expect(find.textContaining('arrived'), findsWidgets);
    expect(tester.takeException(), isNull);
    await endShell(tester, h);
    h = await pumpTrip(tester, tripAt('in_progress'), brightness: Brightness.dark);
    expect(find.text('Riding'), findsOneWidget);
    expect(find.byKey(const ValueKey('arrive-at')), findsOneWidget);
    expect(find.textContaining(RegExp(r'^Arrive \d\d:\d\d$')), findsWidgets);
    expect(tester.takeException(), isNull);
    await endShell(tester, h);
  });

  testWidgets('a stage change swaps the sheet in place, on the same map', (tester) async {
    final h = await pumpTrip(tester, tripAt('matched'));
    final map = tester.state(find.byType(RiderMapShell));
    h.container.read(activeTripProvider.notifier).replace(tripAt('in_progress'));
    await settle(tester);
    expect(find.text('Riding'), findsOneWidget);
    expect(tester.state(find.byType(RiderMapShell)), same(map)); // the shell (and its map) stayed
    expect(tester.takeException(), isNull);
    await endShell(tester, h);
  });

  testWidgets('completed: the total and the pay button', (tester) async {
    final h = await pumpTrip(tester, tripAt('completed'));
    expect(find.text("You've arrived"), findsOneWidget);
    expect(find.textContaining('140'), findsWidgets);
    expect(tester.takeException(), isNull);
    await endShell(tester, h);
  });

  testWidgets('completed with a promo: the rider pays the fare minus the discount', (tester) async {
    final j = Map<String, dynamic>.from(fixture('trip.json'));
    j['status'] = 'completed';
    j['times'] = {...asJson(j['times']), 'completedAt': '2026-10-27T09:30:00Z'};
    j['fare'] = {...asJson(j['fare']), 'finalMinor': 14000, 'promoDiscountMinor': 3000, 'promoCode': 'WELCOME30', 'payableMinor': 11000};
    final h = await pumpTrip(tester, Trip.fromJson(j), brightness: Brightness.dark);
    expect(find.text(birr(11000)), findsWidgets);
    expect(find.text('Promo code WELCOME30 · −${birr(3000)}'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await endShell(tester, h);
  });
}
