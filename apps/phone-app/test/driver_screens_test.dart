// The driver's home (offline and online) and trip screen (waiting at the pickup, with the PIN
// sheet), in light and dark, with large text.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/core/l10n/generated/app_localizations.dart';
import 'package:phone_app/core/location/location_source.dart';
import 'package:phone_app/core/network/providers.dart';
import 'package:phone_app/core/push/local_notifications.dart';
import 'package:phone_app/core/realtime/realtime_hub.dart';
import 'package:phone_app/core/session/secure_store.dart';
import 'package:phone_app/core/session/session_controller.dart';
import 'package:phone_app/features/config/client_config_provider.dart';
import 'package:phone_app/features/driver/earnings/earnings_controller.dart';
import 'package:phone_app/features/driver/earnings/earnings_summary_controller.dart';
import 'package:phone_app/features/driver/shift/driver_home_screen.dart';
import 'package:phone_app/features/driver/shift/shift_controller.dart';
import 'package:phone_app/features/driver/trip/driver_trip_screen.dart';
import 'package:phone_app/features/maps/nav/navigation_controller.dart';
import 'package:phone_app/features/rider/trip/active_trip_controller.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';

class FixedConfig extends ClientConfigController {
  @override
  Future<ClientConfig> build() async {
    final j = Map<String, dynamic>.from(fixture('client_config.json'));
    j['features'] = {...asJson(j['features']), 'tripPin': true}; // the PIN sheet is under test
    return ClientConfig.fromJson(j);
  }
}

class FixedShift extends ShiftController {
  FixedShift(this.value);
  final ShiftState value;
  @override
  ShiftState build() => value;
}

class FixedBalance extends BalanceController {
  FixedBalance(this.value);
  final Balance? value;
  @override
  Future<Balance?> build() async => value;
}

class FixedEarnings extends EarningsSummaryController {
  FixedEarnings(super.period, this.value);
  final EarningsSummary value;
  @override
  Future<EarningsSummary> build() async => value;
}

const driverRoles = [{'r': 'RIDER'}, {'r': 'DRIVER'}];

Future<void> pumpDriver(WidgetTester tester, Widget home, {ShiftState shift = const ShiftState(), Trip? trip, Brightness brightness = Brightness.light, DriverHome? driverHome, EarningsSummary? summary, List<Incentive> incentives = const [], List<Override> overrides = const []}) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  tester.view.physicalSize = const Size(360 * 3, 740 * 3);
  tester.view.devicePixelRatio = 3;
  tester.platformDispatcher.textScaleFactorTestValue = 1.3;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  final home0 = driverHome ?? DriverHome.fromJson(fixture('driver_home.json'));
  final balance = Balance.fromJson(fixture('balance.json'));
  final summary0 = summary ?? EarningsSummary.fromJson({'from': '2026-10-27T00:00:00Z', 'to': '2026-10-28T00:00:00Z', 'trips': 4, 'cancellations': 0, 'grossMinor': 60000, 'commissionMinor': 9000, 'vatMinor': 1350, 'netMinor': 49650, 'cashCollectedMinor': 30000, 'byDay': []});
  await tester.pumpWidget(ProviderScope(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      secureStoreProvider.overrideWithValue(MemorySecureStore()),
      localNotificationsProvider.overrideWithValue(NoLocalNotifications()),
      realtimeHubProvider.overrideWithValue(fakeHub()),
      clientConfigProvider.overrideWith(FixedConfig.new),
      sessionProvider.overrideWith(() => FixedSession(session(roles: driverRoles))),
      modeProvider.overrideWith(() => FixedMode(AppMode.driver)),
      driverHomeProvider.overrideWith(() => FixedDriverHome(home0)),
      drivableVehiclesProvider.overrideWith((ref) async => home0.allVehicles),
      shiftProvider.overrideWith(() => FixedShift(shift)),
      balanceProvider.overrideWith(() => FixedBalance(balance)),
      earningsSummaryProvider.overrideWith2((period) => FixedEarnings(period, summary0)),
      incentivesProvider.overrideWith((ref) async => incentives),
      activeTripProvider.overrideWith(() => FixedActiveTrip(trip)),
      locationSourceProvider.overrideWithValue(FakeLocationSource(lat: 9.0107, lng: 38.7613)),
      tripPartiesProvider.overrideWith((ref, id) async => const TripParties(riderName: 'Sara Getachew')),
      routeFetcherProvider.overrideWithValue(({required fromLat, required fromLng, required toLat, required toLng, steps = false}) async => RouteSteps(
            polyline6: encodePolyline6([(lat: fromLat, lng: fromLng), (lat: toLat, lng: toLng)]),
            distanceMeters: 900,
            durationSeconds: 180,
            approximate: false,
            steps: const [RouteStep(type: 'turn', modifier: 'left', lat: 9.012, lng: 38.762, bearingAfter: 0, name: 'Churchill Avenue', distanceMeters: 400, durationSeconds: 80)],
          )),
      ...overrides,
    ],
    child: MaterialApp(
      theme: anbessaTheme(brightness: brightness),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: home,
    ),
  ));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 600));
  await tester.pump();
  await tester.pump(const Duration(seconds: 1));
}

Trip driverTrip(String status) {
  final j = Map<String, dynamic>.from(fixture('trip.json'));
  j['status'] = status;
  if (status == 'en_route') j['times'] = {...asJson(j['times']), 'arrivedAt': DateTime.now().toUtc().subtract(const Duration(minutes: 1)).toIso8601String()};
  return Trip.fromJson(j);
}

void main() {
  testWidgets('offline home: the car, today\'s numbers and the slide to go online', (tester) async {
    await pumpDriver(tester, const DriverHomeScreen());
    expect(find.text('Slide to go online'), findsOneWidget);
    expect(find.textContaining('3-A40402'), findsWidgets);
    expect(find.textContaining('496'), findsWidgets); // 496.50 ETB today
    expect(tester.takeException(), isNull);
  });

  testWidgets('online home in dark mode: waiting for offers and the slide to go offline', (tester) async {
    final home = DriverHome.fromJson(fixture('driver_home.json'));
    final v = home.allVehicles.first;
    final shift = ShiftState(session: DrivingSession(id: 's1', vehicleId: v.id, startedAt: DateTime.now().toUtc().subtract(const Duration(minutes: 42))), vehicle: v, pingsOk: 10);
    await pumpDriver(tester, const DriverHomeScreen(), shift: shift, brightness: Brightness.dark);
    expect(find.text('Slide to go offline'), findsOneWidget);
    expect(find.text('Waiting for trips nearby…'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('trip: on the way to the pickup shows the turn banner and the arrival slide', (tester) async {
    final t = driverTrip('matched');
    await pumpDriver(tester, DriverTripScreen(tripId: t.id), trip: t);
    expect(find.text('Slide: on my way'), findsOneWidget);
    expect(find.textContaining('Sara Getachew'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('trip: waiting at the pickup, then the PIN sheet', (tester) async {
    final t = driverTrip('en_route');
    await pumpDriver(tester, DriverTripScreen(tripId: t.id), trip: t, brightness: Brightness.dark);
    expect(find.text('Slide to start the trip'), findsOneWidget);
    expect(find.textContaining('Waiting'), findsWidgets);
    await tester.longPress(find.byType(SwipeToConfirm));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text("Rider's PIN"), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('completed cash trip with a promo: collect what the rider pays, not the full fare', (tester) async {
    final j = Map<String, dynamic>.from(fixture('trip.json'));
    j['status'] = 'completed';
    j['paymentMethod'] = 'CASH';
    j['times'] = {...asJson(j['times']), 'completedAt': DateTime.now().toUtc().toIso8601String()};
    j['fare'] = {...asJson(j['fare']), 'finalMinor': 14000, 'promoDiscountMinor': 3000, 'promoCode': 'WELCOME30', 'payableMinor': 11000};
    final t = Trip.fromJson(j);
    await pumpDriver(tester, DriverTripScreen(tripId: t.id), trip: t);
    expect(find.textContaining(birr(11000)), findsWidgets);
    expect(find.textContaining(birr(14000)).evaluate().any((e) => ((e.widget as Text).data ?? '').contains('Collect')), isFalse);
    expect(find.textContaining(birr(11000)).evaluate().any((e) => ((e.widget as Text).data ?? '').contains('Collect')), isTrue);
    expect(tester.takeException(), isNull);
  });
}
