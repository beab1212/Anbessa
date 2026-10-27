// The rider map shell in a widget test: the real tab shell (RiderShell) around the real stage
// routes (riderMapShellRoute), over a FakeBackend, on a small phone (360 dp) with large text
// (1.3×). Activity, Account and the account pages are placeholders.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:phone_app/core/l10n/generated/app_localizations.dart';
import 'package:phone_app/core/location/location_source.dart';
import 'package:phone_app/core/network/providers.dart';
import 'package:phone_app/core/push/local_notifications.dart';
import 'package:phone_app/core/realtime/realtime_hub.dart';
import 'package:phone_app/core/router/routes.dart';
import 'package:phone_app/core/session/secure_store.dart';
import 'package:phone_app/core/session/session_controller.dart';
import 'package:phone_app/features/config/client_config_provider.dart';
import 'package:phone_app/features/rider/shell/rider_map_shell.dart';
import 'package:phone_app/features/shell/shells.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

/// client-config from the fixture with chosen flags on.
class FlagConfig extends ClientConfigController {
  FlagConfig(this.flags);
  final Map<String, bool> flags;
  @override
  Future<ClientConfig> build() async {
    final j = Map<String, dynamic>.from(fixture('client_config.json'));
    j['features'] = {...asJson(j['features']), ...flags};
    return ClientConfig.fromJson(j);
  }
}

/// A pumped shell: its providers and router.
typedef ShellHarness = ({ProviderContainer container, GoRouter router});

/// Meskel Square: inside the fixture's Addis Ababa.
FakeLocationSource fakeRider() => FakeLocationSource(lat: 9.0107, lng: 38.7613);

Future<ShellHarness> pumpRiderShell(
  WidgetTester tester, {
  required String at,
  FakeBackend? backend,
  Map<String, bool> flags = const {},
  Brightness brightness = Brightness.light,
  Locale locale = const Locale('en'),
  double textScale = 1.3,
  Session? who,
  List<Override> overrides = const [],
  void Function(ProviderContainer c)? before,
  Map<String, Object> prefs = const {},
}) async {
  SharedPreferences.setMockInitialValues(prefs);
  final sp = await SharedPreferences.getInstance();
  tester.view.physicalSize = const Size(360 * 3, 740 * 3);
  tester.view.devicePixelRatio = 3;
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  final api = backend ?? FakeBackend();
  api.on('GET', '/api/trips/active', (_) => {'trip': null});
  api.on('GET', '/api/payments/methods', (_) => {'methods': ['CASH', 'MOBILE_MONEY'], 'providers': []});
  api.on('GET', '/api/trips/places', (_) => {'places': []});
  final location = fakeRider();
  addTearDown(location.dispose);
  final container = ProviderContainer(overrides: [
    prefsProvider.overrideWithValue(sp),
    secureStoreProvider.overrideWithValue(MemorySecureStore()),
    localNotificationsProvider.overrideWithValue(NoLocalNotifications()),
    realtimeHubProvider.overrideWithValue(fakeHub()),
    clientConfigProvider.overrideWith(() => FlagConfig(flags)),
    sessionProvider.overrideWith(() => FixedSession(who ?? session())),
    modeProvider.overrideWith(() => FixedMode(AppMode.rider)),
    apisProvider.overrideWithValue(api.apis()),
    locationSourceProvider.overrideWithValue(location),
    ...overrides,
  ]);
  addTearDown(container.dispose);
  await container.read(clientConfigProvider.future);
  await container.read(sessionProvider.future);
  container.read(lastPositionProvider.notifier).set(location.position);
  before?.call(container);
  final root = GlobalKey<NavigatorState>(debugLabel: 'test-root');
  Widget page(String text) => Scaffold(body: Center(child: Text(text)));
  final router = GoRouter(
    navigatorKey: root,
    initialLocation: at,
    routes: [
      StatefulShellRoute.indexedStack(
        builder: (_, state, shell) => RiderShell(shell: shell, location: state.uri),
        branches: [
          StatefulShellBranch(routes: [riderMapShellRoute(root)]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.riderActivity, builder: (_, _) => page('activity page'))]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.riderAccount, builder: (_, _) => page('account page'))]),
        ],
      ),
      GoRoute(path: Routes.savedPlaces, builder: (_, _) => page('saved places page'), routes: [
        GoRoute(path: 'pick', builder: (_, s) => page('pick ${s.uri.queryParameters['label']}')),
      ]),
      GoRoute(path: Routes.sos, builder: (_, _) => page('sos page')),
    ],
  );
  addTearDown(router.dispose);
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
  await settle(tester);
  return (container: container, router: router);
}

/// Fixed frames: the map, pulses and price counters never quite settle.
Future<void> settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 600));
  await tester.pump();
  await tester.pump(const Duration(seconds: 1));
}

Future<void> tapText(WidgetTester tester, String text) async {
  final f = find.text(text).last;
  await tester.ensureVisible(f);
  await tester.pump();
  await tester.tap(f);
  await settle(tester);
}

/// Where the router is (the top-most page, pushed ones included).
String locationOf(GoRouter r) => r.state.uri.toString();

/// Unmount and dispose now: providers with their own timers (the driver's live position polls
/// every 5 s) would otherwise outlive the widget tree and fail the test.
Future<void> endShell(WidgetTester tester, ShellHarness h) async {
  // entrance animations start on a zero-length timer: let the last ones start while mounted
  await tester.pump(const Duration(milliseconds: 1));
  await tester.pump(const Duration(milliseconds: 1));
  await tester.pumpWidget(const SizedBox.shrink());
  h.container.dispose();
  await tester.pump();
}
