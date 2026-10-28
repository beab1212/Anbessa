// The GoRide-style account pages, sign-in pages and prompts: each renders on a 360 dp phone with
// 1.3× text, light and dark, English and Amharic; Saved Addresses deletes with a confirmation and
// undoes, adds through the "Add an Address" sheet; Payment Methods saves the choice; Account &
// Security follows its flag; the splash offers a retry offline; the location dialog answers.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:phone_app/core/l10n/l10n.dart';
import 'package:phone_app/core/network/providers.dart';
import 'package:phone_app/core/push/local_notifications.dart';
import 'package:phone_app/core/realtime/realtime_hub.dart';
import 'package:phone_app/core/session/secure_store.dart';
import 'package:phone_app/core/session/session_controller.dart';
import 'package:phone_app/features/auth/auth_screens.dart';
import 'package:phone_app/features/bootstrap/gates.dart';
import 'package:phone_app/features/bootstrap/location_prompt.dart';
import 'package:phone_app/features/config/client_config_provider.dart';
import 'package:phone_app/features/profile/account_screens.dart';
import 'package:phone_app/features/profile/preference_screens.dart';
import 'package:phone_app/features/profile/profile_screen.dart';
import 'package:phone_app/features/profile/saved_places_screen.dart';
import 'package:phone_app/features/profile/settings_controllers.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'account_hub_test.dart' show NoOrgs;
import 'booking_extras_test.dart' show FlagConfig;
import 'support/fakes.dart';

class OfflineSession extends SessionController {
  @override
  Future<Session?> build() async => throw const AppError(status: 0, code: 'network', message: 'offline');
}

/// No automatic retries: the error stays, as when the app's session check fails offline.
Duration? noRetry(int _, Object _) => null;

FakeBackend accountBackend() => FakeBackend()
  ..on('GET', '/api/trips/active', (_) => {'trip': null})
  ..on('GET', '/api/payments/methods', (_) => {
        'methods': ['CASH', 'MOBILE_MONEY'],
        'providers': [
          {'provider': 'telebirr', 'label': 'telebirr', 'methods': ['MOBILE_MONEY'], 'mode': 'live'},
          {'provider': 'cbebirr', 'label': 'CBE Birr', 'methods': ['MOBILE_MONEY'], 'mode': 'simulated'},
        ]
      })
  ..on('GET', '/api/payments/me/preferences', (_) => {'mobileMoneyProvider': 'telebirr'})
  ..on('PUT', '/api/payments/me/preferences', (_) => <String, dynamic>{})
  ..on('GET', '/api/notifications/me/marketing', (_) => {'push': true, 'sms': false})
  ..on('GET', '/api/trips/places', (_) => {
        'places': [
          {'id': 'h', 'label': 'HOME', 'name': 'Home', 'address': 'Bole Road, Addis Ababa', 'lat': 9.0, 'lng': 38.78},
          {'id': 'w', 'label': 'WORK', 'name': 'Work', 'address': 'Kazanchis, Addis Ababa', 'lat': 9.02, 'lng': 38.76},
          {'id': 'o1', 'label': 'OTHER', 'name': "Mom's House", 'address': 'CMC, Addis Ababa', 'lat': 9.03, 'lng': 38.85},
        ]
      })
  ..on('DELETE', '/api/trips/places/w', (_) => <String, dynamic>{})
  ..on('PUT', '/api/trips/places/work', (_) => {'id': 'w2', 'label': 'WORK', 'name': 'Work', 'address': 'Kazanchis, Addis Ababa', 'lat': 9.02, 'lng': 38.76})
  ..on('POST', '/api/trips/places', (_) => {'id': 'n', 'label': 'OTHER', 'name': 'Tomoca', 'lat': 9.03, 'lng': 38.75});

Future<ProviderContainer> pumpPage(
  WidgetTester tester,
  Widget home, {
  FakeBackend? backend,
  Brightness brightness = Brightness.light,
  Locale locale = const Locale('en'),
  Map<String, bool> flags = const {'support': true, 'accountDeletion': true},
  bool offline = false,
}) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  tester.view.physicalSize = const Size(360 * 3, 740 * 3);
  tester.view.devicePixelRatio = 3;
  tester.platformDispatcher.textScaleFactorTestValue = 1.3;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  final b = backend ?? accountBackend();
  final container = ProviderContainer(retry: noRetry, overrides: [
    prefsProvider.overrideWithValue(prefs),
    secureStoreProvider.overrideWithValue(MemorySecureStore()),
    localNotificationsProvider.overrideWithValue(NoLocalNotifications()),
    realtimeHubProvider.overrideWithValue(fakeHub()),
    clientConfigProvider.overrideWith(() => FlagConfig(flags)),
    sessionProvider.overrideWith(() => offline ? OfflineSession() : FixedSession(session())),
    modeProvider.overrideWith(() => FixedMode(AppMode.rider)),
    apisProvider.overrideWithValue(b.apis()),
    authApiProvider.overrideWithValue(AuthApi(b.apis().client)),
    organizationsProvider.overrideWith(NoOrgs.new),
  ]);
  addTearDown(container.dispose);
  await container.read(clientConfigProvider.future);
  if (!offline) await container.read(sessionProvider.future);
  final router = GoRouter(routes: [
    GoRoute(path: '/', builder: (_, _) => home),
    // the map picker: hands back a place at once
    GoRoute(path: '/account/places/pick', builder: (_, _) => const _PickedPlace()),
    GoRoute(path: '/account/sessions', builder: (_, _) => const Scaffold(body: Text('sessions page'))),
    GoRoute(path: '/account/delete', builder: (_, _) => const Scaffold(body: Text('delete page'))),
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
  return container;
}

class _PickedPlace extends StatefulWidget {
  const _PickedPlace();
  @override
  State<_PickedPlace> createState() => _PickedPlaceState();
}

class _PickedPlaceState extends State<_PickedPlace> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => context.pop(const Place(name: 'Tomoca Coffee', label: 'Wavel Street, Piassa', lat: 9.03, lng: 38.75)));
  }

  @override
  Widget build(BuildContext context) => const Scaffold();
}

void main() {
  final screens = <String, Widget>{
    'Personal Info': const ProfileScreen(),
    'Saved Addresses': const SavedPlacesScreen(),
    'Notifications': const NotificationsScreen(),
    'Account & Security': const AccountSecurityScreen(),
    'Payment Methods': const PaymentPreferencesScreen(),
    'App Appearance': const AppearanceScreen(),
    'Language': const LanguageScreen(),
    'Emergency contact': const SafetyScreen(),
    'Navigation': const NavigationPrefsScreen(),
    'Organizations': const OrganizationsScreen(),
    'Ride or drive': const ModeSwitcherScreen(),
    'Sign up': const PhoneScreen(signUp: true),
    'OTP': const OtpScreen(phone: '+251911223344'),
  };
  for (final locale in const [Locale('en'), Locale('am')]) {
    for (final b in Brightness.values) {
      testWidgets('account and sign-in pages render at 360 dp, 1.3× text (${locale.languageCode}, ${b.name})', (tester) async {
        for (final MapEntry(key: name, value: screen) in screens.entries) {
          await pumpPage(tester, screen, brightness: b, locale: locale);
          await tester.pump(const Duration(milliseconds: 300));
          expect(tester.takeException(), isNull, reason: name);
          // a new tree for the next page (the OTP page's timer stops with it)
          await tester.pumpWidget(const SizedBox());
        }
      });
    }
  }

  testWidgets('Saved Addresses: delete asks first, then Undo puts it back', (tester) async {
    final backend = accountBackend();
    await pumpPage(tester, const SavedPlacesScreen(), backend: backend);
    await tester.pumpAndSettle();
    expect(find.text('Kazanchis, Addis Ababa'), findsOneWidget);
    await tester.tap(find.byIcon(Icons.more_vert_rounded).at(1));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();
    expect(find.text('Delete Address'), findsOneWidget);
    expect(find.text('Sure you want to delete this address?'), findsOneWidget);
    await tester.tap(find.text('Yes, Delete'));
    await tester.pumpAndSettle();
    expect(backend.requests.where((r) => r.method == 'DELETE' && r.uri.path == '/api/trips/places/w'), hasLength(1));
    expect(find.text('Address deleted!'), findsOneWidget);
    expect(find.text('Not set. Tap to add.'), findsOneWidget);
    await tester.tap(find.text('Undo'));
    await tester.pumpAndSettle();
    expect(backend.bodies('PUT', '/api/trips/places/work').single['address'], 'Kazanchis, Addis Ababa');
  });

  testWidgets('Saved Addresses: Add Address picks on the map, then names it in the sheet', (tester) async {
    final backend = accountBackend();
    await pumpPage(tester, const SavedPlacesScreen(), backend: backend);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add Address'));
    await tester.pumpAndSettle();
    expect(find.text('Add an Address'), findsOneWidget);
    expect(find.text('Tomoca Coffee'), findsWidgets);
    await tester.enterText(find.widgetWithText(TextField, 'Tomoca Coffee'), 'Tomoca');
    await tester.enterText(find.widgetWithText(TextField, 'e.g. Floor, unit number'), '2nd floor');
    await tester.tap(find.text('Save Address'));
    await tester.pumpAndSettle();
    final body = backend.bodies('POST', '/api/trips/places').single;
    expect(body['name'], 'Tomoca');
    expect(body['address'], 'Wavel Street, Piassa, 2nd floor');
  });

  testWidgets('Payment Methods saves the chosen provider', (tester) async {
    final backend = accountBackend();
    await pumpPage(tester, const PaymentPreferencesScreen(), backend: backend);
    await tester.pumpAndSettle();
    expect(find.text('Preferred'), findsOneWidget);
    await tester.tap(find.text('CBE Birr'));
    await tester.pumpAndSettle();
    expect(backend.bodies('PUT', '/api/payments/me/preferences').single['mobileMoneyProvider'], 'cbebirr');
  });

  testWidgets('Account & Security: Delete Account only with its flag; Device Management opens', (tester) async {
    await pumpPage(tester, const AccountSecurityScreen(), flags: const {});
    expect(find.text('Device Management'), findsOneWidget);
    expect(find.text('Delete my account'), findsNothing);
    await tester.tap(find.text('Device Management'));
    await tester.pumpAndSettle();
    expect(find.text('sessions page'), findsOneWidget);
  });

  testWidgets('the splash offers a retry when the session could not be checked', (tester) async {
    await pumpPage(tester, const SplashScreen(), offline: true);
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('Anbessa'), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
  });

  testWidgets('the Enable Location dialog answers true for Grant and false for Maybe Later', (tester) async {
    bool? answer;
    await pumpPage(tester, Builder(builder: (context) => Scaffold(body: Center(child: TextButton(onPressed: () async => answer = await showEnableLocationDialog(context), child: const Text('ask'))))));
    await tester.tap(find.text('ask'));
    await tester.pumpAndSettle();
    expect(find.text('Enable Location'), findsOneWidget);
    await tester.tap(find.text('Maybe Later'));
    await tester.pumpAndSettle();
    expect(answer, isFalse);
    await tester.tap(find.text('ask'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Grant Permission'));
    await tester.pumpAndSettle();
    expect(answer, isTrue);
  });
}
