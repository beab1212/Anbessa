import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/session/session.dart';
import 'core/theme/app_theme.dart';
import 'features/auth/presentation/login_screen.dart';
import 'features/driver/presentation/driver_home_screen.dart';
import 'features/rider/presentation/rider_home_screen.dart';

void main() {
  runApp(const ProviderScope(child: RideApp()));
}

/// One app for both riders and drivers — the signed-in user's role decides
/// which home screen (and theme) they get.
class RideApp extends ConsumerWidget {
  const RideApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final role = ref.watch(sessionRoleProvider);
    return MaterialApp(
      title: 'Ride',
      theme: role == AppRole.driver ? driverTheme : riderTheme,
      home: switch (role) {
        null => const LoginScreen(),
        AppRole.rider => const RiderHomeScreen(),
        AppRole.driver => const DriverHomeScreen(),
      },
    );
  }
}
