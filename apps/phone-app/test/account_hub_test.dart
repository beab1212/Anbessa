// The account hub in the GoRide layout: the profile card (photo, name, phone, rating · trips; the
// driver's balance with Top up) and one card of rows, on a 360 dp phone with 1.3× text, light and
// dark, English and Amharic; the light trip count; and the payment badge's re-check only when a
// trip ends.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:phone_app/core/l10n/l10n.dart';
import 'package:phone_app/core/network/providers.dart';
import 'package:phone_app/core/push/local_notifications.dart';
import 'package:phone_app/core/realtime/realtime_hub.dart';
import 'package:phone_app/core/router/routes.dart';
import 'package:phone_app/core/session/secure_store.dart';
import 'package:phone_app/core/session/session_controller.dart';
import 'package:phone_app/features/config/client_config_provider.dart';
import 'package:phone_app/features/profile/account_hub_screen.dart';
import 'package:phone_app/features/profile/settings_controllers.dart';
import 'package:phone_app/features/rider/history/history_screens.dart';
import 'package:phone_app/features/rider/payments/payment_due_controller.dart';
import 'package:phone_app/features/rider/trip/active_trip_controller.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'booking_extras_test.dart' show FlagConfig;
import 'support/fakes.dart';

class NoOrgs extends OrganizationsController {
  @override
  Future<({List<Organization> orgs, List<OrgInvitation> invitations})> build() async => (orgs: const <Organization>[], invitations: const <OrgInvitation>[]);
}

Json tripJson(String id, {String status = 'completed'}) => {...fixture('trip.json'), 'id': id, 'status': status};

/// A backend with [trips] rider trips (one page of 20 plus a cursor when more).
FakeBackend backendWith({int trips = 3, bool more = false}) => FakeBackend()
  ..on('GET', '/api/trips/active', (_) => {'trip': null})
  ..on('GET', '/api/trips/me/rating', (_) => {'average': 4.9, 'count': 128})
  ..on('GET', '/api/trips', (_) => {'trips': [for (var i = 0; i < trips; i++) tripJson('t$i')], 'next': more ? 'cursor' : null})
  ..on('GET', '/api/payments/balances/me', (_) => {...fixture('balance.json'), 'balanceMinor': 206950});

Future<ProviderContainer> pumpHub(WidgetTester tester, FakeBackend backend, {AppMode mode = AppMode.rider, Brightness brightness = Brightness.light, Locale locale = const Locale('en'), Map<String, bool> flags = const {'support': true, 'scheduledRides': true}}) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  tester.view.physicalSize = const Size(360 * 3, 740 * 3);
  tester.view.devicePixelRatio = 3;
  tester.platformDispatcher.textScaleFactorTestValue = 1.3;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  final container = ProviderContainer(overrides: [
    prefsProvider.overrideWithValue(prefs),
    secureStoreProvider.overrideWithValue(MemorySecureStore()),
    localNotificationsProvider.overrideWithValue(NoLocalNotifications()),
    realtimeHubProvider.overrideWithValue(fakeHub()),
    clientConfigProvider.overrideWith(() => FlagConfig(flags)),
    sessionProvider.overrideWith(() => FixedSession(session(roles: mode == AppMode.driver ? const [{'r': 'RIDER'}, {'r': 'DRIVER'}] : const [{'r': 'RIDER'}]))),
    modeProvider.overrideWith(() => FixedMode(mode)),
    apisProvider.overrideWithValue(backend.apis()),
    organizationsProvider.overrideWith(NoOrgs.new),
    appVersionProvider.overrideWith((ref) async => const AppVersion(version: '1.0.0', build: '7', platform: 'android')),
  ]);
  addTearDown(container.dispose);
  await container.read(clientConfigProvider.future);
  await container.read(sessionProvider.future);
  final hub = AccountScreen(mode: mode);
  final router = GoRouter(routes: [
    GoRoute(path: '/', builder: (_, _) => hub),
    for (final p in [Routes.profile, Routes.riderActivity, Routes.driverActivity, Routes.support, Routes.savedPlaces, Routes.appearance, Routes.driverEarnings, Routes.driverTopUp, Routes.security])
      GoRoute(path: p, builder: (_, _) => Scaffold(body: Text('page $p'))),
  ]);
  await tester.pumpWidget(UncontrolledProviderScope(
    container: container,
    child: MaterialApp.router(
      theme: anbessaTheme(brightness: brightness),
      locale: locale,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      routerConfig: router,
    ),
  ));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
  await tester.pump();
  return container;
}

int listCalls(FakeBackend b) => b.requests.where((r) => r.method == 'GET' && r.uri.path == '/api/trips').length;

void main() {
  for (final locale in const [Locale('en'), Locale('am')]) {
    for (final b in Brightness.values) {
      testWidgets('rider hub renders at 360 dp, 1.3× text (${locale.languageCode}, ${b.name})', (tester) async {
        await pumpHub(tester, backendWith(), brightness: b, locale: locale);
        final l = lookupAppLocalizations(locale);
        expect(find.text('Abebe'), findsOneWidget);
        expect(find.text(l.tripsCount(3)), findsOneWidget);
        expect(find.textContaining('4.9'), findsOneWidget);
        expect(find.text(l.accountTitle), findsOneWidget);
        for (final label in [l.accSavedAddresses, l.notifications, l.accPaymentMethods, l.accAccountSecurity]) {
          expect(find.widgetWithText(AccountRow, label), findsOneWidget);
        }
        // no balance row for riders, no quick-action circles any more
        expect(find.text(l.topUp), findsNothing);
        expect(find.byType(QuickActionCircle), findsNothing);
        expect(find.byType(Hero), findsOneWidget);
        expect(tester.widget<Hero>(find.byType(Hero)).tag, meAvatarHeroTag);
        // every row has its icon
        for (final r in tester.widgetList<AccountRow>(find.byType(AccountRow, skipOffstage: false))) {
          expect(r.icon.fontFamily, 'MaterialIcons');
        }
        await tester.scrollUntilVisible(find.text(l.appVersion('1.0.0+7')), 300);
        expect(find.widgetWithText(AccountRow, l.accHelpSupport), findsOneWidget);
        expect(find.text(l.signOut), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }
  }

  testWidgets('driver hub: the balance with Top up, the drive rows, dark Amharic', (tester) async {
    await pumpHub(tester, backendWith(), mode: AppMode.driver, brightness: Brightness.dark, locale: const Locale('am'));
    final l = lookupAppLocalizations(const Locale('am'));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text(l.accAvailableBalance), findsOneWidget);
    expect(find.text(birr(206950, locale: 'am')), findsOneWidget);
    expect(find.text(l.topUp), findsOneWidget);
    expect(find.widgetWithText(AccountRow, l.accSavedAddresses), findsNothing);
    expect(find.widgetWithText(AccountRow, l.switchToRider), findsOneWidget);
    await tester.scrollUntilVisible(find.text(l.vehicles), 200);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Top up opens the driver top-up', (tester) async {
    await pumpHub(tester, backendWith(), mode: AppMode.driver);
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('Top up'));
    await tester.pumpAndSettle();
    expect(find.text('page ${Routes.driverTopUp}'), findsOneWidget);
  });

  testWidgets('without the support flag there is no Help & Support row', (tester) async {
    await pumpHub(tester, backendWith(), flags: const {});
    expect(find.text('Help & Support', skipOffstage: false), findsNothing);
  });

  testWidgets('Saved Addresses opens its page', (tester) async {
    await pumpHub(tester, backendWith());
    await tester.tap(find.text('Saved Addresses'));
    await tester.pumpAndSettle();
    expect(find.text('page ${Routes.savedPlaces}'), findsOneWidget);
  });

  testWidgets('the profile card opens Personal Info', (tester) async {
    await pumpHub(tester, backendWith());
    await tester.tap(find.text('Abebe'));
    await tester.pumpAndSettle();
    expect(find.text('page ${Routes.profile}'), findsOneWidget);
  });

  testWidgets('Sign out asks first in a confirmation sheet', (tester) async {
    await pumpHub(tester, backendWith());
    await tester.ensureVisible(find.text('Sign out'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sign out'));
    await tester.pumpAndSettle();
    expect(find.text('Yes, Sign out'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(find.text('Yes, Sign out'), findsNothing);
  });

  group('trip count', () {
    testWidgets('one light page: "20+ trips" when there are more pages', (tester) async {
      final backend = backendWith(trips: tripCountPage, more: true);
      await pumpHub(tester, backend);
      expect(find.text('20+ trips'), findsOneWidget);
      expect(backend.requests.where((r) => r.uri.path == '/api/trips').single.uri.queryParameters['limit'], '$tripCountPage');
    });

    test('reuses a loaded Activity list instead of asking again, and does not follow its paging', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final backend = backendWith(trips: 5);
      final c = ProviderContainer(overrides: [
        prefsProvider.overrideWithValue(prefs),
        sessionProvider.overrideWith(() => FixedSession(session())),
        activeTripProvider.overrideWith(() => FixedActiveTrip(null)),
        apisProvider.overrideWithValue(backend.apis()),
      ]);
      addTearDown(c.dispose);
      await c.read(sessionProvider.future);
      c.listen(tripHistoryProvider('rider'), (_, _) {});
      await c.read(tripHistoryProvider('rider').future);
      expect(listCalls(backend), 1);
      expect(await c.read(tripCountProvider('rider').future), (count: 5, more: false));
      expect(listCalls(backend), 1);
    });
  });

  group('payment badge', () {
    test('re-checks when a trip ends, not on every status of a live trip', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final backend = backendWith(trips: 1);
      final c = ProviderContainer(overrides: [
        prefsProvider.overrideWithValue(prefs),
        sessionProvider.overrideWith(() => FixedSession(session())),
        activeTripProvider.overrideWith(() => FixedActiveTrip(null)),
        apisProvider.overrideWithValue(backend.apis()),
      ]);
      addTearDown(c.dispose);
      c.listen(paymentDueProvider, (_, _) {});
      await c.read(activeTripProvider.future);
      await c.read(paymentDueProvider.future);
      final atStart = listCalls(backend);
      expect(atStart, 1);

      final trips = c.read(activeTripProvider.notifier);
      Future<void> step(String status) async {
        trips.set(Trip.fromJson(tripJson('live', status: status)));
        await c.read(paymentDueProvider.future);
      }

      await step('requested'); // a trip starts: one re-check
      expect(listCalls(backend), atStart + 1);
      for (final s in ['matched', 'en_route', 'in_progress']) {
        await step(s);
      }
      expect(listCalls(backend), atStart + 1); // statuses of the live trip: nothing
      await step('completed');
      expect(listCalls(backend), atStart + 2); // it ended
      trips.clearIfEnded();
      await c.read(paymentDueProvider.future);
      expect(listCalls(backend), atStart + 2); // seen and cleared: no change for the badge
    });

    test('the key only tells the trip and whether it is live', () {
      final live = Trip.fromJson(tripJson('a', status: 'matched'));
      final ended = Trip.fromJson(tripJson('a', status: 'completed'));
      expect(paymentDueKeyOf(AsyncData(live)), (tripId: 'a', live: true));
      expect(paymentDueKeyOf(AsyncData(ended)), (tripId: null, live: false));
      expect(paymentDueKeyOf(const AsyncData(null)), paymentDueKeyOf(AsyncData(ended)));
    });
  });
}
