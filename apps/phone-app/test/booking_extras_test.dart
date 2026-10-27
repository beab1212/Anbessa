// The choose-ride stage's extras (in the rider map shell) against a fake backend: a promo code (discount on the card and the
// button, the code sent, refusals explained, malformed codes never sent), booking for later
// (POST /api/trips/scheduled, then Activity), and a company ride's purpose and policy refusal.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:phone_app/core/l10n/generated/app_localizations.dart';
import 'package:phone_app/core/network/providers.dart';
import 'package:phone_app/core/push/local_notifications.dart';
import 'package:phone_app/core/realtime/realtime_hub.dart';
import 'package:phone_app/core/session/secure_store.dart';
import 'package:phone_app/core/session/session_controller.dart';
import 'package:phone_app/features/config/client_config_provider.dart';
import 'package:phone_app/features/rider/booking/booking_controller.dart';
import 'package:phone_app/core/router/routes.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';
import 'support/rider_shell.dart';

export 'support/rider_shell.dart' show FlagConfig, settle, tapText;

const meskel = Place(name: 'Meskel Square', lat: 9.0107, lng: 38.7613);
const bole = Place(name: 'Bole International Airport', lat: 8.9779, lng: 38.7993);

/// One estimate without any discount.
Json plainEstimate() {
  final j = fixture('estimates_promo.json');
  j['quotes'] = [for (final q in asJsonList(j['quotes'])) {...q, 'discountMinor': 0, 'payableMinor': q['fareMinor']}..remove('promo')];
  j.remove('promo');
  return j;
}

/// The usual screen-test setup (small phone, large text), over [backend], with a router so the
/// screen can leave: `/` is [home], `/rider/trip/:id` and `/rider/activity` are placeholders.
Future<ProviderContainer> pumpWithBackend(
  WidgetTester tester,
  FakeBackend backend,
  Widget home, {
  Map<String, bool> flags = const {},
  Brightness brightness = Brightness.light,
  Session? who,
  List<Override> overrides = const [],
  void Function(ProviderContainer c)? before,
}) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  tester.view.physicalSize = const Size(360 * 3, 740 * 3);
  tester.view.devicePixelRatio = 3;
  tester.platformDispatcher.textScaleFactorTestValue = 1.3;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  backend.on('GET', '/api/trips/active', (_) => {'trip': null});
  backend.on('GET', '/api/payments/methods', (_) => {'methods': ['CASH', 'MOBILE_MONEY'], 'providers': []});
  final container = ProviderContainer(overrides: [
    prefsProvider.overrideWithValue(prefs),
    secureStoreProvider.overrideWithValue(MemorySecureStore()),
    localNotificationsProvider.overrideWithValue(NoLocalNotifications()),
    realtimeHubProvider.overrideWithValue(fakeHub()),
    clientConfigProvider.overrideWith(() => FlagConfig(flags)),
    sessionProvider.overrideWith(() => FixedSession(who ?? session())),
    modeProvider.overrideWith(() => FixedMode(AppMode.rider)),
    apisProvider.overrideWithValue(backend.apis()),
    ...overrides,
  ]);
  addTearDown(container.dispose);
  await container.read(clientConfigProvider.future);
  await container.read(sessionProvider.future);
  before?.call(container);
  final router = GoRouter(routes: [
    GoRoute(path: '/', builder: (_, _) => home),
    GoRoute(path: '/rider/trip/:id', builder: (_, s) => Scaffold(body: Text('trip page ${s.pathParameters['id']}'))),
    GoRoute(path: '/rider/activity', builder: (_, _) => const Scaffold(body: Text('activity page'))),
  ]);
  await tester.pumpWidget(UncontrolledProviderScope(
    container: container,
    child: MaterialApp.router(
      theme: anbessaTheme(brightness: brightness),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      routerConfig: router,
    ),
  ));
  await settle(tester);
  return container;
}

void routeEstimates(FakeBackend backend, {Json? promo}) {
  backend.on('POST', '/api/pricing/estimates', (o) {
    final code = asJson(o.data)['promoCode'];
    if (code == null) return plainEstimate();
    if (promo != null) return {...plainEstimate(), 'promo': promo};
    return fixture('estimates_promo.json');
  });
}

/// The choose-ride stage in the map shell, with a pickup and a drop-off set by [before].
Future<ShellHarness> pumpQuote(WidgetTester tester, FakeBackend backend, {Map<String, bool> flags = const {}, Brightness brightness = Brightness.light, Session? who, void Function(ProviderContainer c)? before}) =>
    pumpRiderShell(tester, at: Routes.riderQuote, backend: backend, flags: flags, brightness: brightness, who: who, before: before);

void ready(ProviderContainer c) {
  c.read(bookingProvider.notifier).setPickup(meskel, quote: false);
  c.read(bookingProvider.notifier).setDropoff(bole, quote: false);
}

PrimaryButton mainButton(WidgetTester tester) => tester.widget<PrimaryButton>(find.byType(PrimaryButton).last);

void main() {
  for (final b in Brightness.values) {
    testWidgets('a promo code discounts the ride: struck-through fare, payable on the button, code sent (${b.name})', (tester) async {
      final backend = FakeBackend();
      routeEstimates(backend);
      backend.on('POST', '/api/trips', (_) => fixture('trip.json'));
      final h = await pumpQuote(tester, backend, flags: {'promos': true}, brightness: b, before: ready);
      expect(mainButton(tester).trailing, birr(26000));

      await tapText(tester, 'Promo code');
      await tester.enterText(find.byKey(const ValueKey('promo-code')), ' welcome50 ');
      await tapText(tester, 'Apply');

      expect(backend.bodies('POST', '/api/pricing/estimates').last['promoCode'], 'WELCOME50');
      expect(find.textContaining('WELCOME50 applied'), findsOneWidget);
      expect(find.byWidgetPredicate((w) => w is Text && w.data == birr(26000) && w.style?.decoration == TextDecoration.lineThrough), findsOneWidget);
      expect(mainButton(tester).trailing, birr(21000));
      expect(tester.takeException(), isNull);

      await tapText(tester, 'Request Economy');
      expect(backend.bodies('POST', '/api/trips').single['quoteId'], 'q_0b7c4a10-0000-4000-8000-000000000001');
      expect(locationOf(h.router), Routes.riderTrip(Trip.fromJson(fixture('trip.json')).id));
      await endShell(tester, h);
    });
  }

  testWidgets('a refused code says why; a malformed one is never sent', (tester) async {
    final backend = FakeBackend();
    routeEstimates(backend, promo: {'code': 'OLD10', 'applied': false, 'reason': 'expired', 'message': 'This code has expired.'});
    await pumpQuote(tester, backend, flags: {'promos': true}, before: ready);

    await tapText(tester, 'Promo code');
    await tester.enterText(find.byKey(const ValueKey('promo-code')), 'old10');
    await tapText(tester, 'Apply');
    expect(find.text('This code has expired.'), findsOneWidget);
    expect(mainButton(tester).trailing, birr(26000));

    final sent = backend.bodies('POST', '/api/pricing/estimates').length;
    await tapText(tester, 'Promo code');
    await tester.enterText(find.byKey(const ValueKey('promo-code')), 'x!');
    await tapText(tester, 'Apply');
    expect(find.text('Codes are 3 to 32 letters, digits, _ or -.'), findsOneWidget);
    expect(backend.bodies('POST', '/api/pricing/estimates').length, sent);
    expect(tester.takeException(), isNull);
  });

  testWidgets('without the promos flag there is no promo row', (tester) async {
    final backend = FakeBackend();
    routeEstimates(backend);
    await pumpQuote(tester, backend, before: ready);
    expect(find.text('Promo code'), findsNothing);
    expect(find.text('Pickup time'), findsNothing);
  });

  testWidgets('booking for later posts the pickup time and opens Activity (dark)', (tester) async {
    final backend = FakeBackend();
    routeEstimates(backend);
    backend.on('GET', '/api/trips/scheduled', (_) => {'scheduled': []});
    backend.on('POST', '/api/trips/scheduled', (o) => {...fixture('scheduled_trip.json'), 'scheduledFor': asJson(o.data)['scheduledFor']});
    final at = ScheduleWindow.tripService.suggested(DateTime.now());
    await pumpQuote(tester, backend, flags: {'scheduledRides': true}, brightness: Brightness.dark, before: (c) {
      ready(c);
      c.read(bookingProvider.notifier).scheduleAt(at);
    });
    expect(find.text('Pickup time'), findsOneWidget);
    expect(find.text(dayAndTime(at)), findsOneWidget);
    expect(find.text('We check the price again shortly before pickup. You pay the lower one.'), findsOneWidget);
    expect(find.byType(EtaBadge), findsNothing); // the ETA is about now
    expect(tester.takeException(), isNull);

    await tapText(tester, 'Schedule Economy');
    final body = backend.bodies('POST', '/api/trips/scheduled').single;
    expect(body['scheduledFor'], at.toIso8601String());
    expect(body['paymentMethod'], 'CASH');
    expect(backend.bodies('POST', '/api/trips'), isEmpty);
    expect(find.text('activity page'), findsOneWidget);
  });

  testWidgets('a company ride: the policy asks for a purpose, a refusal offers personal payment', (tester) async {
    final backend = FakeBackend();
    routeEstimates(backend);
    backend.on('GET', '/api/trips/corporate/org-1/policy', (_) => {'orgId': 'org-1', 'requirePurpose': true, 'configured': true});
    backend.on('POST', '/api/trips', (_) => const FakeReply(422, {'error': 'policy_violation', 'message': 'Your company allows comfort rides only', 'rule': 'vehicle_type'}));
    final rider = session(roles: [{'r': 'RIDER'}, {'r': 'CORPORATE_RIDER', 'org': 'org-1'}]);
    await pumpQuote(tester, backend, who: rider, before: (c) {
      ready(c);
      c.read(bookingProvider.notifier).pay(PaymentMethod.corporate, billingOrgId: 'org-1');
    });
    expect(find.text('Your company asks for this'), findsOneWidget);
    expect(mainButton(tester).onPressed, isNull);

    await tester.enterText(find.widgetWithText(TextField, 'Trip purpose or cost centre'), 'Client visit');
    await settle(tester);
    expect(mainButton(tester).onPressed, isNotNull);

    await tapText(tester, 'Request Economy');
    final sent = backend.bodies('POST', '/api/trips').single;
    expect(sent['purpose'], 'Client visit');
    expect(sent['billingOrgId'], 'org-1');
    expect(sent['paymentMethod'], 'CORPORATE');
    expect(find.text('Your company allows comfort rides only'), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tapText(tester, 'Pay personally instead');
    expect(find.text('Cash'), findsOneWidget);
    expect(find.text('Trip purpose or cost centre'), findsNothing);
  });
}
