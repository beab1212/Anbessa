// The route table and the guard chain (plan §"go_router table and guards"): bootstrap → forced
// update → signed out → mode → driver not approved → the active trip takes over. Deep links use
// the same paths; `/trip/:id` and `/pay/:id` resolve to the current mode.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../features/auth/auth_screens.dart';
import '../../features/bootstrap/gates.dart';
import '../../features/config/client_config_provider.dart';
import '../../features/driver/earnings/earnings_screens.dart';
import '../../features/driver/onboarding/onboarding_screens.dart';
import '../../features/driver/shift/driver_home_screen.dart';
import '../../features/driver/shift/shift_controller.dart';
import '../../features/driver/trip/driver_trip_screen.dart';
import '../../features/flagged/flagged_modules.dart';
import '../../features/intro/intro_screen.dart';
import '../../features/driver/vehicles/vehicles_screen.dart';
import '../../features/profile/account_hub_screen.dart';
import '../../features/profile/account_screens.dart';
import '../../features/profile/preference_screens.dart';
import '../../features/profile/profile_screen.dart';
import '../../features/profile/saved_places_screen.dart';
import '../../features/rider/booking/route_editor_screen.dart';
import '../../features/rider/history/history_screens.dart';
import '../../features/rider/rating/rating_screen.dart';
import '../../features/rider/scheduled/scheduled_rides_screen.dart';
import '../../features/rider/shell/rider_map_shell.dart';
import '../../features/rider/trip/active_trip_controller.dart';
import '../../features/shell/shells.dart';
import '../../features/support/lost_item_screens.dart';
import '../../features/support/sos_screen.dart';
import '../../features/support/support_screens.dart';
import '../session/session_controller.dart';
import 'routes.dart';
import 'transitions.dart';

/// Re-runs the redirect when what it depends on changes. The driver's profile
/// (`driverHomeProvider`, GET /api/fleet/drivers/me) is only listened to in driver mode, so a
/// rider's start never asks for it; the subscription follows the mode.
class RouterNotifier extends ChangeNotifier {
  RouterNotifier(this.ref) {
    ref.listen(sessionProvider, (_, _) => notifyListeners());
    ref.listen(modeProvider, (_, _) => notifyListeners());
    ref.listen(activeTripProvider, (_, _) => notifyListeners());
    ref.listen(updateRequiredProvider, (_, _) => notifyListeners());
    ref.listen(introSeenProvider, (_, _) => notifyListeners());
    ref.listen<AppMode?>(effectiveModeProvider, (_, mode) => _followDriverHome(mode), fireImmediately: true);
  }
  final Ref ref;
  ProviderSubscription<AsyncValue<DriverHome>>? _driverHome;

  void _followDriverHome(AppMode? mode) {
    if (mode == AppMode.driver) {
      _driverHome ??= ref.listen(driverHomeProvider, (_, _) => notifyListeners());
    } else {
      _driverHome?.close();
      _driverHome = null;
    }
  }

  /// Whether the driver's profile is being followed (for tests).
  @visibleForTesting
  bool get followsDriverHome => _driverHome != null;

  @override
  void dispose() {
    _driverHome?.close();
    super.dispose();
  }
}

/// The root navigator: full-screen pages over the tab shells (pay and rate over the rider's map).
final rootNavigatorKey = GlobalKey<NavigatorState>(debugLabel: 'root');

final routerProvider = Provider<GoRouter>((ref) {
  final notifier = RouterNotifier(ref);
  ref.onDispose(notifier.dispose);
  return GoRouter(
    navigatorKey: rootNavigatorKey,
    initialLocation: Routes.splash,
    refreshListenable: notifier,
    debugLogDiagnostics: false,
    redirect: (context, state) => _redirect(ref, state),
    routes: [
      GoRoute(path: Routes.splash, builder: (_, _) => const SplashScreen()),
      GoRoute(path: Routes.intro, pageBuilder: (_, s) => fadeThroughPage(s, const IntroScreen())),
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
        builder: (_, state, shell) => RiderShell(shell: shell, location: state.uri),
        branches: [
          // home, search, choose ride and the trip share one map (rider_map_shell.dart)
          StatefulShellBranch(routes: [riderMapShellRoute(rootNavigatorKey)]),
          StatefulShellBranch(routes: [
            GoRoute(path: Routes.riderActivity, builder: (_, _) => HistoryScreen(as: 'rider', receiptRoute: Routes.riderReceipt), routes: [
              GoRoute(path: ':id', builder: (_, s) => ReceiptScreen(tripId: s.pathParameters['id']!, asDriver: false)),
            ]),
          ]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.riderAccount, builder: (_, _) => const AccountScreen(mode: AppMode.rider))]),
        ],
      ),
      GoRoute(path: Routes.riderPickup, redirect: (_, _) => '${Routes.riderRoute}?focus=pickup'),
      GoRoute(path: Routes.riderDropoff, redirect: (_, _) => '${Routes.riderRoute}?focus=dropoff'),

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
      GoRoute(path: Routes.savedPlaces, builder: (_, _) => const SavedPlacesScreen(), routes: [
        GoRoute(path: 'pick', pageBuilder: (_, s) => slideUpPage(s, RouteEditorScreen(mode: RouteEditorMode.savedPlace, savedLabel: s.uri.queryParameters['label']))),
      ]),
      GoRoute(path: Routes.appearance, builder: (_, _) => const AppearanceScreen()),
      GoRoute(path: Routes.notifications, builder: (_, _) => const NotificationsScreen()),
      GoRoute(path: Routes.safety, builder: (_, _) => const SafetyScreen()),
      GoRoute(path: Routes.organizations, builder: (_, _) => const OrganizationsScreen()),
      GoRoute(path: Routes.navigationPrefs, builder: (_, _) => const NavigationPrefsScreen()),
      GoRoute(path: Routes.driverVehicles, builder: (_, _) => const VehiclesScreen()),
      GoRoute(path: Routes.deleteAccount, builder: (_, _) => const DeleteAccountScreen()),
      GoRoute(path: Routes.scheduled, builder: (_, _) => const ScheduledRidesScreen()),
      GoRoute(path: Routes.sos, builder: (_, s) => SosScreen(tripId: s.uri.queryParameters['trip'])),
      GoRoute(path: Routes.support, builder: (_, _) => const SupportScreen(), routes: [
        GoRoute(path: 'new', builder: (_, s) => NewTicketScreen(tripId: s.uri.queryParameters['trip'])),
        GoRoute(path: 'tickets/:id', builder: (_, s) => TicketScreen(ticketId: s.pathParameters['id']!)),
        GoRoute(path: 'lost-items', builder: (_, _) => const DriverLostItemsScreen(), routes: [
          // before ':id' so "report" is never read as an id
          GoRoute(path: 'report', builder: (_, s) => ReportLostItemScreen(tripId: s.uri.queryParameters['trip'] ?? '')),
          GoRoute(path: ':id', builder: (_, s) => LostItemScreen(lostItemId: s.pathParameters['id']!)),
        ]),
      ]),
    ],
  );
});

const _authPaths = {Routes.welcome, Routes.signIn, Routes.verify};
const _anywherePrefixes = ['/account', '/sos', '/support', '/scheduled'];
/// `/rider/book/route?mode=savedPlace` (older links) picks a place to save, whatever the mode; the
/// route sends it on to the account's place picker.
const _riderBookingPrefix = '/rider/book';

String? _redirect(Ref ref, GoRouterState state) {
  final path = state.uri.path;
  final sessionAsync = ref.read(sessionProvider);
  // 1. bootstrap: the session is still being read
  if (sessionAsync.isLoading && !sessionAsync.hasValue) return path == Routes.splash ? null : Routes.splash;
  // the stored session couldn't be checked (offline at start): not signed out; the splash offers a retry
  if (sessionAsync.hasError && !sessionAsync.hasValue) return path == Routes.splash ? null : Routes.splash;
  // 2. forced update
  if (ref.read(updateRequiredProvider)) return path == Routes.updateRequired ? null : Routes.updateRequired;
  if (path == Routes.updateRequired) return Routes.splash;
  final session = sessionAsync.value;
  // 3. signed out (the intro once, first)
  if (session == null) {
    if (!ref.read(introSeenProvider)) return path == Routes.intro ? null : Routes.intro;
    return _authPaths.contains(path) ? null : Routes.welcome;
  }
  if (path == Routes.intro) return Routes.splash;
  // 4. mode
  final mode = ref.read(effectiveModeProvider);
  if (mode == null) return path == Routes.mode ? null : Routes.mode;
  if (path == Routes.splash || path == Routes.mode || _authPaths.contains(path)) return mode == AppMode.rider ? Routes.riderHome : Routes.driverHome;
  if (_anywherePrefixes.any((p) => path.startsWith(p))) return null;
  if (path.startsWith(_riderBookingPrefix) && mode == AppMode.driver) return null;
  final inRider = path.startsWith('/rider');
  final inDriver = path.startsWith('/driver');
  if (mode == AppMode.rider && inDriver) return Routes.riderHome;
  if (mode == AppMode.driver && inRider) return Routes.driverHome;
  // 5. driver mode without an approved profile: onboarding (account stays reachable)
  if (mode == AppMode.driver) {
    final home = ref.read(driverHomeProvider).value;
    final approved = session.canDrive && (home?.driver?.isActive ?? true);
    if (home != null && !approved && !path.startsWith(Routes.driverOnboarding) && path != Routes.driverAccount && path != Routes.driverVehicles && !path.startsWith(Routes.driverEarnings)) return Routes.driverOnboarding;
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
