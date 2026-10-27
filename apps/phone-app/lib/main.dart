// Boot: preferences, then the app straight away. Local notifications and push are set up after
// the first frame so they never hold the splash (push registers the device itself once it is
// ready, see PushService.init). Everything else is built lazily by Riverpod from
// core/network/providers.dart; the stored session is checked while the splash shows.

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'app.dart';
import 'core/network/providers.dart';
import 'core/perf.dart';
import 'core/push/local_notifications.dart';
import 'core/push/push_service.dart';
import 'core/session/session_controller.dart';
import 'core/ux/haptics.dart';

Future<void> main() async {
  Perf.start();
  Perf.mark('main start');
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  final container = ProviderContainer(overrides: [prefsProvider.overrideWithValue(prefs)]);
  installHaptics(container);
  // profile photos over https come from the disk cache
  AvatarImage.networkBuilder = (url, size, fallback) =>
      CachedNetworkImage(imageUrl: url, width: size, height: size, fit: BoxFit.cover, fadeInDuration: const Duration(milliseconds: 150), errorWidget: (_, _, _) => fallback);
  // start checking the stored session now, in parallel with the first frame
  container.listen(sessionProvider, (_, next) {
    if (!next.isLoading) Perf.mark('session ready', once: true);
  }, fireImmediately: true);
  WidgetsBinding.instance.addPostFrameCallback((_) async {
    Perf.mark('first frame');
    await container.read(localNotificationsProvider).init();
    await container.read(pushServiceProvider).init();
  });
  runApp(UncontrolledProviderScope(container: container, child: const AnbessaApp()));
}
