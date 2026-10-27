// Boot: preferences, local notifications and push (where supported), then the app. Everything
// else is built lazily by Riverpod from core/network/providers.dart.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'app.dart';
import 'core/network/providers.dart';
import 'core/push/local_notifications.dart';
import 'core/push/push_service.dart';
import 'core/ux/haptics.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  final container = ProviderContainer(overrides: [prefsProvider.overrideWithValue(prefs)]);
  installHaptics(container);
  await container.read(localNotificationsProvider).init();
  await container.read(pushServiceProvider).init();
  runApp(UncontrolledProviderScope(container: container, child: const AnbessaApp()));
}
