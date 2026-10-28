// Boots the real app (router, theme, l10n) signed out, on a small phone with large text.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/app.dart';
import 'package:phone_app/core/network/providers.dart';
import 'package:phone_app/core/push/local_notifications.dart';
import 'package:phone_app/core/realtime/realtime_hub.dart';
import 'package:phone_app/core/session/secure_store.dart';
import 'package:phone_app/features/config/client_config_provider.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';

class FixedConfig extends ClientConfigController {
  @override
  Future<ClientConfig> build() async => ClientConfig.fromJson(fixture('client_config.json'));
}

Future<void> boot(WidgetTester tester, {String? locale, String? themeMode, bool introSeen = true}) async {
  SharedPreferences.setMockInitialValues({'locale': ?locale, 'theme_mode': ?themeMode, 'intro_seen': introSeen});
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
      updateRequiredProvider.overrideWithValue(false),
    ],
    child: const AnbessaApp(),
  ));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('signed out, the app opens on Welcome', (tester) async {
    await boot(tester);
    expect(find.text("Let's Get Started!"), findsOneWidget);
    expect(find.text('Sign up'), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Amharic renders the same screen', (tester) async {
    await boot(tester, locale: 'am');
    expect(find.text('ይመዝገቡ'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the first launch shows the intro, and Skip leads to Welcome', (tester) async {
    await boot(tester, introSeen: false);
    expect(find.text('Skip'), findsOneWidget);
    expect(find.text('Sign up'), findsNothing);
    await tester.tap(find.text('Skip'));
    await tester.pumpAndSettle();
    expect(find.text('Sign up'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the intro ends on "Let\'s Get Started"', (tester) async {
    await boot(tester, introSeen: false);
    for (var i = 0; i < 2; i++) {
      await tester.tap(find.text('Continue'));
      await tester.pumpAndSettle();
    }
    expect(find.text('Skip'), findsNothing);
    await tester.tap(find.text("Let's Get Started"));
    await tester.pumpAndSettle();
    expect(find.text('Sign up'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('dark mode renders Welcome too', (tester) async {
    await boot(tester, themeMode: 'dark');
    expect(find.text('Sign up'), findsOneWidget);
    expect(Theme.of(tester.element(find.text('Sign up'))).brightness, Brightness.dark);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Sign up leads to the phone number with the terms; the button waits for them', (tester) async {
    await boot(tester);
    await tester.tap(find.text('Sign up'));
    await tester.pumpAndSettle();
    expect(find.text('Join Anbessa Today ✨'), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget);
    await tester.enterText(find.byType(TextField), '911223344');
    await tester.pump();
    PillButton main() => tester.widget<PillButton>(find.widgetWithText(PillButton, 'Sign up'));
    expect(main().onPressed, isNull);
    // below the fold on a small phone with large text
    await tester.ensureVisible(find.byType(Checkbox, skipOffstage: false));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(Checkbox));
    await tester.pump();
    expect(main().onPressed, isNotNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Sign in leads to "Welcome Back!" without the terms, and can switch to sign up', (tester) async {
    await boot(tester);
    await tester.tap(find.text('Sign in'));
    await tester.pumpAndSettle();
    expect(find.text('Welcome Back! 👋'), findsOneWidget);
    expect(find.byType(Checkbox, skipOffstage: false), findsNothing);
    await tester.ensureVisible(find.widgetWithText(TextButton, 'Sign up', skipOffstage: false));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'Sign up'));
    await tester.pumpAndSettle();
    expect(find.text('Join Anbessa Today ✨'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
