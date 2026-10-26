// The route table and the guard chain (plan §"go_router table and guards"): bootstrap → forced
// update → signed out → mode → driver not approved → the active trip takes over. Deep links use
// the same paths; `/trip/:id` and `/pay/:id` resolve to the current mode.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../features/auth/auth_screens.dart';
import '../../features/bootstrap/gates.dart';
import '../../features/config/client_config_provider.dart';
import '../../features/driver/earnings/earnings_screens.dart';
import '../../features/driver/onboarding/onboarding_screens.dart';
import '../../features/driver/shift/driver_home_screen.dart';
import '../../features/driver/shift/shift_controller.dart';
import '../../features/driver/trip/driver_trip_screen.dart';
import '../../features/flagged/flagged_modules.dart';
import '../../features/maps/place_picker_screen.dart';
import '../../features/profile/account_screens.dart';
import '../../features/rider/booking/booking_controller.dart';
import '../../features/rider/booking/quote_screen.dart';
import '../../features/rider/history/history_screens.dart';
import '../../features/rider/home/rider_home_screen.dart';
import '../../features/rider/payments/pay_screen.dart';
import '../../features/rider/rating/rating_screen.dart';
import '../../features/rider/trip/active_trip_controller.dart';
import '../../features/rider/trip/rider_trip_screen.dart';
import '../../features/shell/shells.dart';
import '../session/session_controller.dart';
import 'routes.dart';

/// Re-runs the redirect when what it depends on changes.
class RouterNotifier extends ChangeNotifier {
  RouterNotifier(this.ref) {
    ref.listen(sessionProvider, (_, _) => notifyListeners());
    ref.listen(modeProvider, (_, _) => notifyListeners());
    ref.listen(activeTripProvider, (_, _) => notifyListeners());
    ref.listen(updateRequiredProvider, (_, _) => notifyListeners());
    ref.listen(driverHomeProvider, (_, _) => notifyListeners());
  }
  final Ref ref;
}

final routerProvider = Provider<GoRouter>((ref) {
  final notifier = RouterNotifier(ref);
  ref.onDispose(notifier.dispose);
  return GoRouter(
    initialLocation: Routes.splash,
    refreshListenable: notifier,
    debugLogDiagnostics: false,
    redirect: (context, state) => _redirect(ref, state),
    routes: [
      GoRoute(path: Routes.splash, builder: (_, _) => const SplashScreen()),
      GoRoute(path: Routes.updateRequired, builder: (_, _) => const UpdateRequiredScreen()),
      GoRoute(path: Routes.welcome, builder: (_, _) => const WelcomeScreen()),
      GoRoute(path: Routes.signIn, builder: (_, s) => PhoneScreen(driver: s.uri.queryParameters['driver'] == '1')),
      GoRoute(path: Routes.verify, builder: (_, s) => OtpScreen(phone: s.uri.queryParameters['phone'] ?? '', driver: s.uri.queryParameters['driver'] == '1')),
      GoRoute(path: Routes.mode, builder: (_, _) => const ModeSwitcherScreen()),

      // deep links shared by both modes
      GoRoute(path: '/trip/:id', redirect: (_, s) => (ref.read(effectiveModeProvider) == AppMode.driver ? Routes.driverTrip : Routes.riderTrip)(s.pathParameters['id']!)),
      GoRoute(path: '/pay/:id', redirect: (_, s) => Routes.riderPay(s.pathParameters['id']!)),
      GoRoute(path: '/top-up/:id', redirect: (_, _) => Routes.driverEarnings),

      StatefulShellRoute.indexedStack(
        builder: (_, _, shell) => RiderShell(shell: shell),
        branches: [
          StatefulShellBranch(routes: [
            GoRoute(path: Routes.riderHome, builder: (_, _) => const RiderHomeScreen(), routes: [
              GoRoute(path: 'book/pickup', redirect: (_, _) => Routes.riderPickup),
            ]),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(path: Routes.riderActivity, builder: (_, _) => HistoryScreen(as: 'rider', receiptRoute: Routes.riderReceipt), routes: [
              GoRoute(path: ':id', builder: (_, s) => ReceiptScreen(tripId: s.pathParameters['id']!, asDriver: false)),
            ]),
          ]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.riderAccount, builder: (_, _) => const AccountScreen(mode: AppMode.rider))]),
        ],
      ),
      GoRoute(path: Routes.riderPickup, builder: (_, _) => Consumer(builder: (ctx, r, _) => PlacePickerScreen(what: PickWhat.pickup, initial: r.read(bookingProvider).pickup, onPicked: (p) {
            r.read(bookingProvider.notifier).setPickup(p);
            if (r.read(bookingProvider).ready) {
              ctx.go(Routes.riderQuote);
            } else {
              ctx.pushReplacement(Routes.riderDropoff);
            }
          }))),
      GoRoute(path: Routes.riderDropoff, builder: (_, _) => Consumer(builder: (ctx, r, _) => PlacePickerScreen(what: PickWhat.dropoff, initial: r.read(bookingProvider).dropoff, onPicked: (p) {
            r.read(bookingProvider.notifier).setDropoff(p);
            if (r.read(bookingProvider).ready) {
              ctx.go(Routes.riderQuote);
            } else {
              ctx.pushReplacement(Routes.riderPickup);
            }
          }))),
      GoRoute(path: Routes.riderQuote, builder: (_, _) => const QuoteScreen()),
      GoRoute(path: '/rider/trip/:id', builder: (_, s) => RiderTripScreen(tripId: s.pathParameters['id']!), routes: [
        GoRoute(path: 'pay', builder: (_, s) => PayScreen(tripId: s.pathParameters['id']!)),
        GoRoute(path: 'rate', builder: (_, s) => RatingScreen(tripId: s.pathParameters['id']!, asDriver: false, doneRoute: Routes.riderHome)),
      ]),

      StatefulShellRoute.indexedStack(
        builder: (_, _, shell) => DriverShell(shell: shell),
        branches: [
          StatefulShellBranch(routes: [GoRoute(path: Routes.driverHome, builder: (_, _) => const DriverHomeScreen())]),
          StatefulShellBranch(routes: [
            GoRoute(path: Routes.driverEarnings, builder: (_, _) => const EarningsScreen(), routes: [
              GoRoute(path: 'top-up', builder: (_, _) => const TopUpScreen()),
              GoRoute(path: 'payout-method', builder: (_, _) => const PayoutMethodScreen()),
              GoRoute(path: 'statement', builder: (_, _) => const StatementScreen()),
              GoRoute(path: 'top-ups', builder: (_, _) => const TopUpsScreen()),
            ]),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(path: Routes.driverActivity, builder: (_, _) => HistoryScreen(as: 'driver', receiptRoute: Routes.driverReceipt), routes: [
              GoRoute(path: ':id', builder: (_, s) => ReceiptScreen(tripId: s.pathParameters['id']!, asDriver: true)),
            ]),
          ]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.driverAccount, builder: (_, _) => const AccountScreen(mode: AppMode.driver))]),
        ],
      ),
      GoRoute(path: Routes.driverOnboarding, builder: (_, _) => const OnboardingHubScreen(), routes: [
        GoRoute(path: 'apply', builder: (_, _) => const ApplyScreen()),
        GoRoute(path: 'documents/:subjectType/:subjectId', builder: (_, s) => DocumentsScreen(subjectType: s.pathParameters['subjectType']!, subjectId: s.pathParameters['subjectId']!)),
        GoRoute(path: 'vehicle/new', builder: (_, _) => const VehicleFormScreen()),
        GoRoute(path: 'vehicle/:id', builder: (_, s) => VehicleScreen(vehicleId: s.pathParameters['id']!)),
      ]),
      GoRoute(path: '/driver/trip/:id', builder: (_, s) => DriverTripScreen(tripId: s.pathParameters['id']!), routes: [
        GoRoute(path: 'rate', builder: (_, s) => RatingScreen(tripId: s.pathParameters['id']!, asDriver: true, doneRoute: Routes.driverHome)),
      ]),

      GoRoute(path: Routes.profile, builder: (_, _) => const ProfileScreen()),
      GoRoute(path: Routes.language, builder: (_, _) => const LanguageScreen()),
      GoRoute(path: Routes.sessions, builder: (_, _) => const SessionsScreen()),
      GoRoute(path: Routes.paymentPrefs, builder: (_, _) => const PaymentPreferencesScreen()),
      GoRoute(path: Routes.deleteAccount, builder: (_, _) => const DeleteAccountScreen()),
      GoRoute(path: Routes.scheduled, builder: (_, _) => const ScheduledRidesScreen(), routes: [GoRoute(path: 'new', builder: (_, _) => const ScheduleRideScreen())]),
      GoRoute(path: Routes.sos, builder: (_, s) => SosScreen(tripId: s.uri.queryParameters['trip'])),
      GoRoute(path: Routes.support, builder: (_, _) => const SupportScreen(), routes: [GoRoute(path: 'new', builder: (_, _) => const NewTicketScreen())]),
      GoRoute(path: Routes.promos, builder: (_, _) => const PromosScreen(), routes: [GoRoute(path: 'redeem', builder: (_, _) => const RedeemCodeScreen())]),
    ],
  );
});

const _authPaths = {Routes.welcome, Routes.signIn, Routes.verify};
const _anywherePrefixes = ['/account', '/sos', '/support', '/scheduled', '/promos'];

String? _redirect(Ref ref, GoRouterState state) {
  final path = state.uri.path;
  final sessionAsync = ref.read(sessionProvider);
  // 1. bootstrap: the session is still being read
  if (sessionAsync.isLoading && !sessionAsync.hasValue) return path == Routes.splash ? null : Routes.splash;
  // 2. forced update
  if (ref.read(updateRequiredProvider)) return path == Routes.updateRequired ? null : Routes.updateRequired;
  if (path == Routes.updateRequired) return Routes.splash;
  final session = sessionAsync.value;
  // 3. signed out
  if (session == null) return _authPaths.contains(path) ? null : Routes.welcome;
  // 4. mode
  final mode = ref.read(effectiveModeProvider);
  if (mode == null) return path == Routes.mode ? null : Routes.mode;
  if (path == Routes.splash || path == Routes.mode || _authPaths.contains(path)) return mode == AppMode.rider ? Routes.riderHome : Routes.driverHome;
  if (_anywherePrefixes.any((p) => path.startsWith(p))) return null;
  final inRider = path.startsWith('/rider');
  final inDriver = path.startsWith('/driver');
  if (mode == AppMode.rider && inDriver) return Routes.riderHome;
  if (mode == AppMode.driver && inRider) return Routes.driverHome;
  // 5. driver mode without an approved profile: onboarding (account stays reachable)
  if (mode == AppMode.driver) {
    final home = ref.read(driverHomeProvider).value;
    final approved = session.canDrive && (home?.driver?.isActive ?? true);
    if (home != null && !approved && !path.startsWith(Routes.driverOnboarding) && path != Routes.driverAccount && !path.startsWith(Routes.driverEarnings)) return Routes.driverOnboarding;
  }
  // 6. the active trip takes over
  final trip = ref.read(activeTripProvider).value;
  if (trip != null && trip.isActive) {
    final want = mode == AppMode.rider ? Routes.riderTrip(trip.id) : Routes.driverTrip(trip.id);
    if (!path.startsWith(want)) return want;
  }
  return null;
}

/// For tests: the same decision without a GoRouter.
String? redirectFor(Ref ref, Uri uri) => _redirect(ref, _FakeState(uri));

class _FakeState implements GoRouterState {
  _FakeState(this.uri);
  @override
  final Uri uri;
  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError('${invocation.memberName}');
}
