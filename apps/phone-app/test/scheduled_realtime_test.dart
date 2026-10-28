// Scheduled rides in Activity (listed, cancelled), the realtime pushes the backend added
// (`scheduled:status`, `trip:reassigned`, a new driver on `trip:status`), driver incentives on the
// earnings screen and the marketing switches in Notifications.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/core/network/providers.dart';
import 'package:phone_app/core/realtime/realtime_hub.dart';
import 'package:phone_app/core/session/secure_store.dart';
import 'package:phone_app/core/session/session_controller.dart';
import 'package:phone_app/features/config/client_config_provider.dart';
import 'package:phone_app/features/driver/earnings/earnings_screens.dart';
import 'package:phone_app/features/profile/preference_screens.dart';
import 'package:phone_app/features/rider/history/history_screens.dart';
import 'package:phone_app/features/rider/scheduled/scheduled_rides_controller.dart';
import 'package:phone_app/features/rider/trip/active_trip_controller.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'booking_extras_test.dart' show FlagConfig, pumpWithBackend, settle, tapText;
import 'driver_screens_test.dart' show pumpDriver;
import 'support/fakes.dart';

const sid = '5c1d2e3f-0000-4000-8000-0000000000a1';

/// A container over [backend] and a fake socket, for controller tests.
Future<(ProviderContainer, RealtimeHub)> container(FakeBackend backend, {Map<String, bool> flags = const {}}) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  final hub = fakeHub();
  final c = ProviderContainer(overrides: [
    prefsProvider.overrideWithValue(prefs),
    secureStoreProvider.overrideWithValue(MemorySecureStore()),
    realtimeHubProvider.overrideWithValue(hub),
    clientConfigProvider.overrideWith(() => FlagConfig(flags)),
    sessionProvider.overrideWith(() => FixedSession(session())),
    apisProvider.overrideWithValue(backend.apis()),
  ]);
  addTearDown(c.dispose);
  await c.read(clientConfigProvider.future);
  await c.read(sessionProvider.future);
  return (c, hub);
}

Future<void> flush() => Future<void>.delayed(const Duration(milliseconds: 150));

void main() {
  group('scheduled rides in Activity', () {
    for (final b in Brightness.values) {
      testWidgets('upcoming rides above past trips, cancelled with a confirmation (${b.name})', (tester) async {
        final backend = FakeBackend()
          ..on('GET', '/api/trips', (_) => {'trips': [fixture('trip.json')], 'next': null})
          ..on('GET', '/api/trips/scheduled', (_) => {'scheduled': [fixture('scheduled_trip.json')]})
          ..on('POST', '/api/trips/scheduled/$sid/cancel', (_) => {...fixture('scheduled_trip.json'), 'status': 'CANCELLED'});
        await pumpWithBackend(tester, backend, HistoryScreen(as: 'rider', receiptRoute: (id) => '/rider/trip/$id'), flags: {'scheduledRides': true}, brightness: b);
        // the fixture trip is in progress, so Ongoing opens first; Scheduled lists the booking with
        // the pickup time on the right
        expect(find.widgetWithText(OutlineChip, 'Scheduled'), findsOneWidget);
        await tapText(tester, 'Scheduled');
        expect(find.text('Booked'), findsOneWidget);
        expect(find.text('Bole International Airport'), findsWidgets);
        expect(find.text(clockOf(DateTime.utc(2026, 10, 28, 5, 30))), findsOneWidget);
        expect(tester.takeException(), isNull);

        await tapText(tester, 'Cancel booking');
        expect(find.text("Cancel this ride? It's free until we start looking for a driver."), findsOneWidget);
        await tapText(tester, 'Cancel booking'); // the dialog's button
        expect(backend.requests.where((r) => r.uri.path == '/api/trips/scheduled/$sid/cancel'), hasLength(1));
        expect(find.text('Booked'), findsNothing);
        expect(find.text('Booking cancelled'), findsOneWidget);
      });
    }

    testWidgets('with the flag off nothing is asked for', (tester) async {
      final backend = FakeBackend()..on('GET', '/api/trips', (_) => {'trips': [], 'next': null});
      await pumpWithBackend(tester, backend, HistoryScreen(as: 'rider', receiptRoute: (id) => '/rider/trip/$id'));
      expect(find.widgetWithText(OutlineChip, 'Scheduled'), findsNothing);
      expect(backend.requests.where((r) => r.uri.path == '/api/trips/scheduled'), isEmpty);
    });
  });

  group('realtime', () {
    test('scheduled:status dispatched refreshes the list and loads the trip it created', () async {
      var listed = 0;
      final backend = FakeBackend()
        ..on('GET', '/api/trips/active', (_) => {'trip': null})
        ..on('GET', '/api/trips/scheduled', (_) => {'scheduled': listed++ == 0 ? [fixture('scheduled_trip.json')] : []});
      final (c, hub) = await container(backend, flags: {'scheduledRides': true});
      final subs = [c.listen(activeTripProvider, (_, _) {}), c.listen(scheduledRidesProvider, (_, _) {})];
      addTearDown(() {
        for (final s in subs) {
          s.close();
        }
      });
      await c.read(activeTripProvider.future);
      expect(await c.read(scheduledRidesProvider.future), hasLength(1));
      final tripsBefore = backend.requests.where((r) => r.uri.path == '/api/trips/active').length;
      backend.on('GET', '/api/trips/active', (_) => {'trip': fixture('trip.json')});

      hub.inject(const ScheduledStatusEvent(scheduledTripId: sid, status: ScheduledStatus.dispatched, tripId: 'fd0c5e2a'));
      await flush();
      expect(c.read(scheduledRidesProvider).value, isEmpty);
      expect(backend.requests.where((r) => r.uri.path == '/api/trips/active').length, tripsBefore + 1);
      expect(c.read(activeTripProvider).value?.id, Trip.fromJson(fixture('trip.json')).id);
    });

    test('trip:reassigned takes the trip away from this driver', () async {
      final trip = Trip.fromJson(fixture('trip.json'));
      final backend = FakeBackend()..on('GET', '/api/trips/active', (_) => {'trip': fixture('trip.json')});
      final (c, hub) = await container(backend);
      final sub = c.listen(activeTripProvider, (_, _) {});
      addTearDown(sub.close);
      expect((await c.read(activeTripProvider.future))?.id, trip.id);

      hub.inject(const TripReassignedEvent(tripId: 'another-trip'));
      await flush();
      expect(c.read(activeTripProvider).value?.id, trip.id);

      hub.inject(TripReassignedEvent(tripId: trip.id, reason: 'driver stuck in traffic'));
      await flush();
      expect(c.read(activeTripProvider).value, isNull);
      expect(c.read(tripReassignedProvider)?.tripId, trip.id);
    });

    test('a new driver on trip:status refetches the parties; the same driver does not', () async {
      final j = fixture('trip.json');
      final trip = Trip.fromJson(j);
      var fetched = 0;
      final backend = FakeBackend()
        ..on('GET', '/api/trips/active', (_) => {'trip': j})
        ..on('GET', '/api/trips/${trip.id}/parties', (_) {
          fetched++;
          return {'driver': {'name': fetched == 1 ? 'Almaz' : 'Dawit'}};
        });
      final (c, hub) = await container(backend);
      final active = c.listen(activeTripProvider, (_, _) {});
      addTearDown(active.close);
      await c.read(activeTripProvider.future);
      final sub = c.listen(tripPartiesProvider(trip.id), (_, _) {});
      addTearDown(sub.close);
      expect((await c.read(tripPartiesProvider(trip.id).future)).driverName, 'Almaz');

      hub.inject(TripStatusEvent(tripId: trip.id, status: trip.status, trip: trip));
      await flush();
      expect(fetched, 1);

      final moved = Trip.fromJson({...j, 'driver': {'userId': 'another-driver', 'vehicleId': 'v9'}});
      hub.inject(TripStatusEvent(tripId: trip.id, status: moved.status, trip: moved));
      await flush();
      expect((await c.read(tripPartiesProvider(trip.id).future)).driverName, 'Dawit');
      expect(fetched, 2);
    });
  });

  group('driver incentives', () {
    final now = DateTime.now().toUtc();
    final running = Incentive(id: 'i1', name: 'Weekend 20', cityId: 'addis-ababa', targetTrips: 20, rewardMinor: 50000, startsAt: now.subtract(const Duration(days: 1)), endsAt: now.add(const Duration(days: 2)), status: 'APPROVED', trips: 15, awardedMinor: 0);
    final paid = Incentive(id: 'i2', name: 'October 60', cityId: 'addis-ababa', vehicleType: 'economy', targetTrips: 60, rewardMinor: 150000, startsAt: now.subtract(const Duration(days: 20)), endsAt: now.subtract(const Duration(days: 2)), status: 'CLOSED', trips: 64, awardedMinor: 150000);
    for (final b in Brightness.values) {
      testWidgets('progress, reward and outcome on the earnings screen (${b.name})', (tester) async {
        await pumpDriver(tester, const EarningsScreen(), incentives: [running, paid], brightness: b);
        await tester.scrollUntilVisible(find.text('Incentives'), 200, scrollable: find.byType(Scrollable).first);
        await settle(tester);
        expect(find.text('Weekend 20'), findsOneWidget);
        expect(find.text('15 of 20 trips'), findsOneWidget);
        expect(find.text('Earn ${birr(50000)}'), findsOneWidget);
        expect(find.text('Economy trips only'), findsOneWidget);
        expect(find.text('Earned ${birr(150000)}'), findsOneWidget);
        expect(find.byType(ProgressMeter), findsNWidgets(2));
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('no programs, no section', (tester) async {
      await pumpDriver(tester, const EarningsScreen());
      expect(find.text('Incentives'), findsNothing);
    });
  });

  group('marketing preferences', () {
    Finder switchOf(String title) => find.descendant(of: find.widgetWithText(SwitchRow, title), matching: find.byType(Switch));

    testWidgets('the SMS switch is saved on the account', (tester) async {
      final backend = FakeBackend()
        ..on('GET', '/api/notifications/me/marketing', (_) => {'push': true, 'sms': true})
        ..on('PUT', '/api/notifications/me/marketing', (o) => {'push': true, 'sms': asJson(o.data)['sms'] ?? true});
      await pumpWithBackend(tester, backend, const NotificationsScreen(), brightness: Brightness.dark);
      expect(find.text('Offers and news from Anbessa'), findsOneWidget);
      expect(tester.widget<Switch>(switchOf('By SMS')).value, isTrue);
      await tester.tap(switchOf('By SMS'));
      await settle(tester);
      expect(backend.bodies('PUT', '/api/notifications/me/marketing').single, {'sms': false});
      expect(tester.widget<Switch>(switchOf('By SMS')).value, isFalse);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a refused change goes back and says so', (tester) async {
      final backend = FakeBackend()
        ..on('GET', '/api/notifications/me/marketing', (_) => {'push': true, 'sms': true})
        ..on('PUT', '/api/notifications/me/marketing', (_) => const FakeReply(400, {'error': 'bad_request', 'message': 'nope'}));
      await pumpWithBackend(tester, backend, const NotificationsScreen());
      await tester.tap(switchOf('By notification'));
      await settle(tester);
      expect(tester.widget<Switch>(switchOf('By notification')).value, isTrue);
      expect(find.text('nope'), findsOneWidget);
    });
  });
}
