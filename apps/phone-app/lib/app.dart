// The app: theme, locale, router. Push taps and local-notification taps are routed here.

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'core/l10n/l10n.dart';
import 'core/perf.dart';
import 'core/push/local_notifications.dart';
import 'core/push/push_service.dart';
import 'core/router/app_router.dart';
import 'core/router/routes.dart';
import 'features/config/client_config_provider.dart';
import 'features/profile/account_screens.dart';
import 'features/profile/appearance_controller.dart';
import 'features/rider/trip/active_trip_controller.dart';

class AnbessaApp extends ConsumerStatefulWidget {
  const AnbessaApp({super.key});
  @override
  ConsumerState<AnbessaApp> createState() => _AnbessaAppState();
}

class _AnbessaAppState extends ConsumerState<AnbessaApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final push = ref.read(pushServiceProvider);
    push.taps.listen(_onPushTap);
    final local = ref.read(localNotificationsProvider);
    if (local is PlatformLocalNotifications) local.onTap = _onLocalTap;
    local.launchPayload().then((p) {
      if (p != null) _onLocalTap(p);
    });
    if (!kReleaseMode) _watchHomeShown();
  }

  /// Perf: the first time either home is on screen (debug and profile builds).
  void _watchHomeShown() {
    final delegate = ref.read(routerProvider).routerDelegate;
    void check() {
      final path = delegate.currentConfiguration.uri.path;
      if (path != Routes.riderHome && path != Routes.driverHome) return;
      delegate.removeListener(check);
      WidgetsBinding.instance.addPostFrameCallback((_) => Perf.mark('home shown', once: true));
    }

    delegate.addListener(check);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      ref.read(clientConfigProvider.notifier).refresh();
      ref.read(activeTripProvider.notifier).refresh();
    }
  }

  void _onPushTap(PushTap tap) {
    final router = ref.read(routerProvider);
    switch (tap.type) {
      case 'payment.action_required':
      case 'payment.failed':
      case 'trip.receipt':
        final tripId = tap.data['tripId'];
        if (tripId != null) router.go(Routes.riderPay(tripId));
      case 'driver.activated':
        router.go(Routes.driverHome);
      case 'balance.state_changed':
      case 'balance.topped_up':
      case 'balance.payment_due':
      case 'payout.sent':
      case 'payout.failed':
        router.go(Routes.driverEarnings);
      default:
        break;
    }
  }

  void _onLocalTap(String payload) {
    if (payload.startsWith('offer:')) ref.read(routerProvider).go(Routes.driverHome);
  }

  @override
  Widget build(BuildContext context) {
    final router = ref.watch(routerProvider);
    final locale = ref.watch(localeProvider);
    final themeMode = ref.watch(themeModeProvider);
    return MaterialApp.router(
      title: 'Anbessa',
      debugShowCheckedModeBanner: false,
      theme: anbessaTheme(),
      darkTheme: anbessaTheme(brightness: Brightness.dark),
      themeMode: themeMode,
      locale: locale,
      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: const [AppLocalizations.delegate, GlobalMaterialLocalizations.delegate, GlobalWidgetsLocalizations.delegate, GlobalCupertinoLocalizations.delegate],
      routerConfig: router,
    );
  }
}
