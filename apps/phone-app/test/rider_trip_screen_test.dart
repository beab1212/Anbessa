// The rider's trip screen at each stage, in light and dark, with large text.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/core/l10n/generated/app_localizations.dart';
import 'package:phone_app/core/network/providers.dart';
import 'package:phone_app/core/push/local_notifications.dart';
import 'package:phone_app/core/realtime/realtime_hub.dart';
import 'package:phone_app/core/session/secure_store.dart';
import 'package:phone_app/core/session/session_controller.dart';
import 'package:phone_app/features/config/client_config_provider.dart';
import 'package:phone_app/features/maps/nav/navigation_controller.dart';
import 'package:phone_app/features/rider/trip/active_trip_controller.dart';
import 'package:phone_app/features/rider/trip/rider_trip_screen.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';

class FixedConfig extends ClientConfigController {
  @override
  Future<ClientConfig> build() async => ClientConfig.fromJson(fixture('client_config.json'));
}

Trip tripAt(String status, {bool withDriver = true}) {
  final j = Map<String, dynamic>.from(fixture('trip.json'));
  j['status'] = status;
  if (!withDriver) j['driver'] = null;
  if (status == 'en_route') j['times'] = {...asJson(j['times']), 'arrivedAt': '2026-10-27T09:10:00Z'};
  if (status == 'completed') {
    j['times'] = {...asJson(j['times']), 'completedAt': '2026-10-27T09:30:00Z'};
    j['fare'] = {...asJson(j['fare']), 'finalMinor': 14000};
  }
  return Trip.fromJson(j);
}

Future<void> pumpTrip(WidgetTester tester, Trip trip, {Brightness brightness = Brightness.light}) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  tester.view.physicalSize = const Size(360 * 3, 740 * 3);
  tester.view.devicePixelRatio = 3;
  tester.platformDispatcher.textScaleFactorTestValue = 1.3;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  await tester.pumpWidget(ProviderScope(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      secureStoreProvider.overrideWithValue(MemorySecureStore()),
      localNotificationsProvider.overrideWithValue(NoLocalNotifications()),
      realtimeHubProvider.overrideWithValue(fakeHub()),
      clientConfigProvider.overrideWith(FixedConfig.new),
      sessionProvider.overrideWith(() => FixedSession(session())),
      activeTripProvider.overrideWith(() => FixedActiveTrip(trip)),
      tripPartiesProvider.overrideWith((ref, id) async => const TripParties(driverName: 'Almaz Tadesse', driverRating: 4.8, driverRatingCount: 12, vehicle: PartyVehicle(plateNumber: '3-A40402', make: 'Hyundai', model: 'Atos', color: 'Blue', vehicleType: 'economy'))),
      driverLiveProvider.overrideWith((ref, id) => Stream.value(DriverLive(lat: trip.pickup.lat + 0.01, lng: trip.pickup.lng, heading: 180, speed: 8, at: DateTime.now().toUtc()))),
      routeFetcherProvider.overrideWithValue(({required fromLat, required fromLng, required toLat, required toLng, steps = false}) async => const RouteSteps(polyline6: '', distanceMeters: 1200, durationSeconds: 240, approximate: true, steps: [])),
    ],
    child: MaterialApp(
      theme: anbessaTheme(brightness: brightness),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: RiderTripScreen(tripId: trip.id),
    ),
  ));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 600));
  // the parties and ETA futures land a frame later
  await tester.pump();
  await tester.pump(const Duration(seconds: 1));
}

void main() {
  testWidgets('finding a driver: radar, elapsed time, cancel', (tester) async {
    await pumpTrip(tester, tripAt('requested', withDriver: false));
    expect(find.text('Finding your driver'), findsOneWidget);
    expect(find.text('Cancel trip'), findsOneWidget);
    expect(find.text('Share trip'), findsNothing); // nothing to follow until a driver is on it
    expect(tester.takeException(), isNull);
  });

  testWidgets('driver assigned: name, rating, plate, PIN, ETA', (tester) async {
    await pumpTrip(tester, tripAt('matched'));
    expect(find.textContaining('Almaz Tadesse'), findsWidgets);
    expect(find.text('3-A40402'), findsOneWidget);
    expect(find.textContaining('4.8'), findsOneWidget);
    expect(find.textContaining('min'), findsWidgets);
    expect(find.text('Share trip'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('arrived and riding, in dark mode', (tester) async {
    await pumpTrip(tester, tripAt('en_route'), brightness: Brightness.dark);
    expect(find.textContaining('arrived'), findsWidgets);
    expect(tester.takeException(), isNull);
    await pumpTrip(tester, tripAt('in_progress'), brightness: Brightness.dark);
    expect(find.text('Riding'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('completed: the total and the pay button', (tester) async {
    await pumpTrip(tester, tripAt('completed'));
    expect(find.text("You've arrived"), findsOneWidget);
    expect(find.textContaining('140'), findsWidgets);
    expect(tester.takeException(), isNull);
  });
}
