// What stands for the rider on their map at each stage: never a car. Home and search draw the
// rider as their avatar pin, choose ride lets the pickup avatar stand for them, finding a driver
// puts their avatar in the rings, and while the driver comes the rider is the small blue dot;
// the only car is the driver's, and only once its position is known (before that, no car at
// all, and nothing falls back to the rider's position).

import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/core/router/routes.dart';
import 'package:phone_app/features/maps/anbessa_map.dart';
import 'package:phone_app/features/maps/me_marker.dart';
import 'package:phone_app/features/maps/raster_map.dart';
import 'package:phone_app/features/rider/trip/active_trip_controller.dart';
import 'package:ride_app_core/ride_app_core.dart';

import 'rider_trip_screen_test.dart' show tripAt;
import 'support/fakes.dart';
import 'support/rider_shell.dart';

AnbessaMap theMap(WidgetTester tester) => tester.widget<AnbessaMap>(find.byType(AnbessaMap));

/// The rider is not drawn as a car: no car widgets anywhere on the map but the driver's.
void expectNoCarFor(WidgetTester tester, {bool driverCarAllowed = false}) {
  final m = theMap(tester);
  expect(m.driverPose, isNull);
  expect(m.driver, isNull);
  expect(m.cars, isEmpty);
  if (!driverCarAllowed) {
    expect(m.carNow, isNull);
    expect(find.descendant(of: find.byType(RasterMap), matching: find.byType(CarMarker)), findsNothing);
  }
  // every top-down car on the map is the driver's or one of the cars around the rider
  final inMap = find.byType(RasterMap);
  final tops = find.descendant(of: inMap, matching: find.byType(TopDownCar)).evaluate().length;
  final nearby = find.descendant(of: inMap, matching: find.byType(NearbyCarGlyph)).evaluate().length;
  final driver = find.descendant(of: inMap, matching: find.byType(CarMarker)).evaluate().length;
  expect(tops, nearby + driver);
  if (!driverCarAllowed) expect(driver, 0);
}

void main() {
  testWidgets('home: the rider is their avatar pin; cars are only the ones around them', (tester) async {
    final h = await pumpRiderShell(tester, at: Routes.riderHome);
    final m = theMap(tester);
    expect(m.mePose, isNotNull);
    expect(m.meAsAvatar, isTrue);
    expect(find.descendant(of: find.byType(RasterMap), matching: find.byType(MapAvatarPin)), findsWidgets);
    expect(find.descendant(of: find.byType(RasterMap), matching: find.byType(MeDot)), findsNothing);
    expectNoCarFor(tester);
    await endShell(tester, h);
  });

  testWidgets('finding a driver: the rider is the avatar in the rings; no car, no dot', (tester) async {
    final t = tripAt('requested', withDriver: false);
    final h = await pumpRiderShell(tester, at: '/rider/trip/${t.id}', overrides: [activeTripProvider.overrideWith(() => FixedActiveTrip(t))]);
    final m = theMap(tester);
    expect(m.mePose, isNull);
    expect(m.driverCar, isNull);
    expectNoCarFor(tester);
    await endShell(tester, h);
  });

  testWidgets('driver assigned, car position not known yet: no car at all; the rider is the blue dot', (tester) async {
    final t = tripAt('matched');
    final h = await pumpRiderShell(tester, at: '/rider/trip/${t.id}', overrides: [
      activeTripProvider.overrideWith(() => FixedActiveTrip(t)),
      tripPartiesProvider.overrideWith((ref, id) async => const TripParties(driverName: 'Almaz Tadesse')),
      driverLiveProvider.overrideWith((ref, id) => const Stream<DriverLive>.empty()),
    ]);
    final m = theMap(tester);
    expect(m.mePose, isNotNull);
    expect(m.meAsAvatar, isFalse);
    expect(m.carNow, isNull); // the animator has no pose: nothing is drawn for the car
    expectNoCarFor(tester);
    await endShell(tester, h);
  });

  testWidgets('driver heading over: one car (the driver), away from the rider, who stays the blue dot', (tester) async {
    final t = tripAt('matched');
    final h = await pumpRiderShell(tester, at: '/rider/trip/${t.id}', overrides: [
      activeTripProvider.overrideWith(() => FixedActiveTrip(t)),
      tripPartiesProvider.overrideWith((ref, id) async => const TripParties(driverName: 'Almaz Tadesse')),
      driverLiveProvider.overrideWith((ref, id) => Stream.value(DriverLive(lat: t.pickup.lat + 0.01, lng: t.pickup.lng, heading: 180, speed: 8, at: DateTime.now().toUtc()))),
    ]);
    await settle(tester);
    final m = theMap(tester);
    final car = m.carNow!;
    expect(car.lat, closeTo(t.pickup.lat + 0.01, 1e-6));
    expect(m.mePose!.position.latitude, isNot(closeTo(car.lat, 1e-4)));
    expect(find.descendant(of: find.byType(RasterMap), matching: find.byType(CarMarker)), findsOneWidget);
    expect(find.descendant(of: find.byType(RasterMap), matching: find.byType(MeDot)), findsOneWidget);
    await endShell(tester, h);
  });
}
