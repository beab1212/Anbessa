// The driver's home (offline and online, searching with the radar on the map), trip screen (guidance from the location stream
// without a rebuild loop, waiting at the pickup with the PIN sheet) and the offer sheet, in light
// and dark, at 360 dp with 1.3x text.

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
import 'package:phone_app/features/driver/offers/offer_controller.dart';
import 'package:phone_app/features/driver/offers/offer_sheet.dart';
import 'package:phone_app/features/maps/anbessa_map.dart';
import 'package:phone_app/features/maps/nav/navigation_controller.dart';
import 'package:phone_app/features/maps/nav/turn_banner.dart';
import 'package:phone_app/features/maps/nav/voice_guide.dart';
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

class FixedOffer extends OfferController {
  FixedOffer(this.value);
  final OfferState value;
  @override
  OfferState build() => value;
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

class SilentTts implements TtsEngine {
  final spoken = <String>[];
  @override
  Future<bool> setLanguage(String languageTag) async => languageTag == 'en-US';
  @override
  Future<void> speak(String text) async => spoken.add(text);
  @override
  Future<void> stop() async {}
}

TripOffer offer({Duration left = const Duration(seconds: 12)}) => TripOffer.fromJson({
      'tripId': 't1',
      'offerId': 'o1',
      'expiresAt': DateTime.now().toUtc().add(left).toIso8601String(),
      'etaToPickupSeconds': 240,
      'pickup': {'lat': 9.0107, 'lng': 38.7613, 'address': 'Meskel Square'},
      'dropoff': {'lat': 8.9806, 'lng': 38.7578, 'address': 'Bole Airport'},
      'vehicleType': 'economy',
      'fare': {'estimateMinor': 25000, 'currency': 'ETB'},
      'paymentMethod': 'CASH',
    });

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
    expect(find.text('Looking for trips…'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  group('searching for trips', () {
    ShiftState onlineShift() {
      final v = DriverHome.fromJson(fixture('driver_home.json')).allVehicles.first;
      return ShiftState(session: DrivingSession(id: 's1', vehicleId: v.id, startedAt: DateTime.now().toUtc()), vehicle: v, pingsOk: 3);
    }

    Future<void> at(WidgetTester tester) async {
      ProviderScope.containerOf(tester.element(find.byType(DriverHomeScreen))).read(lastPositionProvider.notifier).set(DevicePosition(lat: 9.0107, lng: 38.7613, at: DateTime.now()));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
    }

    final radar = find.byKey(const ValueKey('driver-radar'));
    final dot = find.byKey(const ValueKey('driver-searching'));

    for (final b in Brightness.values) {
      testWidgets('online, no offer: radar rings around the driver on the map and "Looking for trips…" (${b.name})', (tester) async {
        await pumpDriver(tester, const DriverHomeScreen(), shift: onlineShift(), brightness: b);
        await at(tester);
        expect(radar, findsOneWidget);
        expect(find.descendant(of: find.byType(AnbessaMap), matching: find.byType(RadarRings)), findsOneWidget);
        expect(dot, findsOneWidget);
        expect(find.text('Looking for trips…'), findsOneWidget);
        expect(find.textContaining('Searching for riders near you'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('offline: no radar, no searching headline', (tester) async {
      await pumpDriver(tester, const DriverHomeScreen());
      await at(tester);
      expect(radar, findsNothing);
      expect(dot, findsNothing);
      expect(find.text('Looking for trips…'), findsNothing);
    });

    testWidgets('an offer stops the search', (tester) async {
      await pumpDriver(tester, const DriverHomeScreen(), shift: onlineShift(), overrides: [offerProvider.overrideWith(() => FixedOffer(OfferState(offer: offer())))]);
      await at(tester);
      expect(radar, findsNothing);
      expect(find.text('Looking for trips…'), findsNothing);
    });

    testWidgets('on a trip there is no search', (tester) async {
      await pumpDriver(tester, const DriverHomeScreen(), shift: onlineShift(), trip: driverTrip('matched'));
      await at(tester);
      expect(radar, findsNothing);
      expect(find.text('Looking for trips…'), findsNothing);
    });

    testWidgets('reduced motion: the rings stand still', (tester) async {
      await pumpDriver(tester, Builder(builder: (ctx) => MediaQuery(data: MediaQuery.of(ctx).copyWith(disableAnimations: true), child: const DriverHomeScreen())), shift: onlineShift());
      await at(tester);
      expect(radar, findsOneWidget);
      final paint = find.descendant(of: radar, matching: find.byType(CustomPaint)).first;
      final before = tester.widget<CustomPaint>(paint).painter! as Listenable;
      var ticks = 0;
      void tick() => ticks++;
      before.addListener(tick);
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pump(const Duration(milliseconds: 500));
      before.removeListener(tick);
      expect(ticks, 0);
    });
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

  for (final b in Brightness.values) {
    testWidgets('trip guidance follows the location stream without rebuilding the screen (${b.name})', (tester) async {
      final t = driverTrip('matched'); // on the way to the pickup (Bole)
      final tts = SilentTts();
      await pumpDriver(tester, DriverTripScreen(tripId: t.id), trip: t, brightness: b, overrides: [ttsEngineProvider.overrideWithValue(tts)]);
      final c = ProviderScope.containerOf(tester.element(find.byType(DriverTripScreen)));
      final pos = c.read(lastPositionProvider.notifier);
      // ~1.2 km north of the pickup, driving south towards it
      var lat = 8.9916;
      pos.set(DevicePosition(lat: lat, lng: 38.7578, heading: 180, speed: 12, at: DateTime.now()));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 100));
      final before = DriverTripScreen.debugBuilds;
      // a fix every 4 s for 40 s, frames in between
      for (var i = 0; i < 10; i++) {
        lat -= 0.0004; // ~44 m
        pos.set(DevicePosition(lat: lat, lng: 38.7578, heading: 180, speed: 11, at: DateTime.now()));
        for (var f = 0; f < 8; f++) {
          await tester.pump(const Duration(milliseconds: 500));
        }
      }
      // nothing in the screen depends on each fix: the banner, the car and the map update alone
      expect(DriverTripScreen.debugBuilds - before, lessThanOrEqualTo(1));
      // and with no new fix, frames don't build it at all
      final idle = DriverTripScreen.debugBuilds;
      for (var f = 0; f < 20; f++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      expect(DriverTripScreen.debugBuilds, idle);
      final nav = c.read(navigationProvider(NavTarget(lat: t.pickup.lat, lng: t.pickup.lng)));
      expect(nav.hasRoute, isTrue);
      expect(nav.fixSeq, greaterThanOrEqualTo(10));
      expect(find.byType(TurnBanner), findsOneWidget);
      expect(find.text('Slide: on my way'), findsOneWidget);
      expect(find.byTooltip('Mute voice guidance'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('trip: arriving within 40 m says so and speaks it once', (tester) async {
    final t = driverTrip('matched');
    final tts = SilentTts();
    await pumpDriver(tester, DriverTripScreen(tripId: t.id), trip: t, overrides: [ttsEngineProvider.overrideWithValue(tts)]);
    final c = ProviderScope.containerOf(tester.element(find.byType(DriverTripScreen)));
    final pos = c.read(lastPositionProvider.notifier);
    pos.set(DevicePosition(lat: 8.9830, lng: 38.7578, heading: 180, speed: 8, at: DateTime.now()));
    await tester.pump(const Duration(milliseconds: 300));
    pos.set(DevicePosition(lat: 8.9808, lng: 38.7578, heading: 180, speed: 2, at: DateTime.now()));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('You have arrived'), findsWidgets);
    expect(tts.spoken.where((s) => s == 'You have arrived at the pickup'), hasLength(1));
    // muting from the map
    await tester.tap(find.byTooltip('Mute voice guidance'));
    await tester.pump();
    expect(find.byTooltip('Turn on voice guidance'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  for (final b in Brightness.values) {
    testWidgets('offer sheet: fare, class, ring and swipe to accept (${b.name})', (tester) async {
      final o = offer();
      await pumpDriver(tester, Scaffold(body: Stack(children: [OfferSheet(state: OfferState(offer: o))])), brightness: b);
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.textContaining('250'), findsWidgets); // 250 ETB
      expect(find.text('Slide to accept'), findsOneWidget);
      expect(find.byType(VehicleArt), findsOneWidget);
      expect(find.byType(OfferRing), findsOneWidget);
      expect(find.text('Meskel Square'), findsOneWidget);
      // time runs out: the slide is disabled
      await tester.pump(const Duration(seconds: 13));
      await tester.pump();
      final swipe = tester.widget<SwipeToConfirm>(find.byType(SwipeToConfirm));
      expect(swipe.enabled, isFalse);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('offer sheet: an expired offer shows the notice', (tester) async {
    await pumpDriver(tester, const Scaffold(body: Stack(children: [OfferSheet(state: OfferState(notice: 'expired'))])));
    expect(find.byType(SwipeToConfirm), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
