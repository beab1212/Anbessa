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

Future<void> boot(WidgetTester tester, {String? locale}) async {
  SharedPreferences.setMockInitialValues({'locale': ?locale});
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
    expect(find.text('Continue with your phone number'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Amharic renders the same screen', (tester) async {
    await boot(tester, locale: 'am');
    expect(find.text('በስልክ ቁጥርዎ ይቀጥሉ'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Continue leads to the phone number screen', (tester) async {
    await boot(tester);
    await tester.tap(find.text('Continue with your phone number'));
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
