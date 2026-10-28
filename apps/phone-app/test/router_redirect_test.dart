import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/core/network/providers.dart';
import 'package:phone_app/core/router/app_router.dart';
import 'package:phone_app/core/router/routes.dart';
import 'package:phone_app/core/session/session_controller.dart';
import 'package:phone_app/features/bootstrap/gates.dart';
import 'package:phone_app/features/config/client_config_provider.dart';
import 'package:phone_app/features/driver/shift/shift_controller.dart';
import 'package:phone_app/features/intro/intro_screen.dart';
import 'package:phone_app/features/rider/trip/active_trip_controller.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';

const driverRoles = [{'r': 'RIDER'}, {'r': 'DRIVER'}];

DriverHome home(String status) => DriverHome.fromJson({...fixture('driver_home.json'), 'driver': {...asJson(fixture('driver_home.json')['driver']), 'status': status}});

Future<String?> redirect(
  String path, {
  Session? signedIn,
  AppMode? mode,
  Trip? trip,
  DriverHome? driverHome,
  bool updateRequired = false,
  bool introSeen = true,
  bool offlineAtStart = false,
  bool splashHeld = false,
}) async {
  final c = ProviderContainer(retry: (_, _) => null, overrides: [
    introSeenProvider.overrideWith(() => FixedIntroSeen(introSeen)),
    sessionProvider.overrideWith(() => offlineAtStart ? OfflineSession() : FixedSession(signedIn)),
    modeProvider.overrideWith(() => FixedMode(mode)),
    activeTripProvider.overrideWith(() => FixedActiveTrip(trip)),
    if (driverHome != null) driverHomeProvider.overrideWith(() => FixedDriverHome(driverHome)),
    updateRequiredProvider.overrideWithValue(updateRequired),
  ]);
  addTearDown(c.dispose);
  if (!splashHeld) c.read(splashHoldProvider.notifier).release();
  await c.read(sessionProvider.future).catchError((_) => null);
  await c.read(activeTripProvider.future);
  if (driverHome != null) await c.read(driverHomeProvider.future);
  final probe = Provider((ref) => redirectFor(ref, Uri.parse(path)));
  return c.read(probe);
}

/// The stored session couldn't be checked: no network at start.
class OfflineSession extends SessionController {
  @override
  Future<Session?> build() async => throw const AppError(status: 0, code: ErrorCodes.network, message: 'offline', retryable: true);
}

/// Counts how often the driver's profile is fetched.
class CountingDriverHome extends DriverHomeController {
  static var builds = 0;
  @override
  Future<DriverHome> build() async {
    builds++;
    return home('ACTIVE');
  }
}

class FixedIntroSeen extends IntroSeen {
  FixedIntroSeen(this.value);
  final bool value;
  @override
  bool build() => value;
}

void main() {
  test('first launch: the intro comes before welcome, once', () async {
    expect(await redirect(Routes.welcome, introSeen: false), Routes.intro);
    expect(await redirect(Routes.intro, introSeen: false), isNull);
    expect(await redirect(Routes.intro), Routes.welcome);
    expect(await redirect(Routes.intro, signedIn: session()), Routes.splash);
  });

  test('the splash holds until its icon has settled, then moves on; other paths are never held', () async {
    expect(await redirect(Routes.splash, signedIn: session(), mode: AppMode.rider, splashHeld: true), isNull);
    expect(await redirect(Routes.splash, splashHeld: true), isNull);
    expect(await redirect(Routes.splash, signedIn: session(), mode: AppMode.rider), Routes.riderHome);
    expect(await redirect(Routes.splash), Routes.welcome);
    expect(await redirect(Routes.welcome, splashHeld: true), isNull);
    expect(await redirect(Routes.riderHome, signedIn: session(), mode: AppMode.rider, splashHeld: true), isNull);
  });

  test('offline at start with a stored session: the splash (with retry), never welcome', () async {
    expect(await redirect(Routes.riderHome, offlineAtStart: true), Routes.splash);
    expect(await redirect(Routes.splash, offlineAtStart: true), isNull);
  });

  test('signed out: everything leads to welcome, sign-in screens stay', () async {
    expect(await redirect(Routes.riderHome), Routes.welcome);
    expect(await redirect(Routes.signIn), isNull);
  });

  test('a forced update wins over everything', () async {
    expect(await redirect(Routes.riderHome, signedIn: session(), updateRequired: true), Routes.updateRequired);
  });

  test('a rider-only account lands on rider home', () async {
    expect(await redirect(Routes.splash, signedIn: session()), Routes.riderHome);
    expect(await redirect(Routes.driverHome, signedIn: session(), mode: AppMode.rider), Routes.riderHome);
  });

  test('both roles and no choice yet: the mode screen', () async {
    expect(await redirect(Routes.riderHome, signedIn: session(roles: driverRoles)), Routes.mode);
  });

  test('driver mode without an approved profile goes to onboarding', () async {
    final s = session(roles: driverRoles);
    expect(await redirect(Routes.driverHome, signedIn: s, mode: AppMode.driver, driverHome: home('PENDING_REVIEW')), Routes.driverOnboarding);
    expect(await redirect(Routes.driverHome, signedIn: s, mode: AppMode.driver, driverHome: home('ACTIVE')), isNull);
    // the account and earnings stay reachable while onboarding
    expect(await redirect(Routes.driverAccount, signedIn: s, mode: AppMode.driver, driverHome: home('APPLIED')), isNull);
  });

  test('an active trip takes over, except SOS, help and account screens', () async {
    final trip = Trip.fromJson(fixture('trip.json'));
    expect(trip.isActive, isTrue);
    expect(await redirect(Routes.riderHome, signedIn: session(), trip: trip), Routes.riderTrip(trip.id));
    expect(await redirect(Routes.riderTrip(trip.id), signedIn: session(), trip: trip), isNull);
    expect(await redirect('${Routes.riderTrip(trip.id)}/pay', signedIn: session(), trip: trip), isNull);
    expect(await redirect(Routes.sos, signedIn: session(), trip: trip), isNull);
    expect(await redirect(Routes.language, signedIn: session(), trip: trip), isNull);
    // help stays reachable mid-trip: a request, a ticket, a lost-item report
    expect(await redirect(Routes.supportNewAbout(trip.id), signedIn: session(), trip: trip), isNull);
    expect(await redirect(Routes.supportTicket('t1'), signedIn: session(), trip: trip), isNull);
    expect(await redirect(Routes.lostItem('l1'), signedIn: session(), trip: trip), isNull);
  });

  test('the rider map shell: its stages are rider routes; saving a place works in either mode', () async {
    expect(await redirect(Routes.riderQuote, signedIn: session(), mode: AppMode.rider), isNull);
    expect(await redirect('${Routes.riderRoute}?focus=pickup', signedIn: session(), mode: AppMode.rider), isNull);
    // a driver saving Home from the account
    final s = session(roles: driverRoles);
    expect(await redirect(Routes.pickSavedPlace('home'), signedIn: s, mode: AppMode.driver, driverHome: home('ACTIVE')), isNull);
    expect(await redirect('${Routes.riderRoute}?mode=savedPlace&label=home', signedIn: s, mode: AppMode.driver, driverHome: home('ACTIVE')), isNull);
    // an active trip still takes over the booking stages
    final trip = Trip.fromJson(fixture('trip.json'));
    expect(await redirect(Routes.riderQuote, signedIn: session(), trip: trip), Routes.riderTrip(trip.id));
  });

  test('a rider start never fetches the driver profile; switching to driver mode does', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    CountingDriverHome.builds = 0;
    final c = ProviderContainer(retry: (_, _) => null, overrides: [
      prefsProvider.overrideWithValue(prefs),
      introSeenProvider.overrideWith(() => FixedIntroSeen(true)),
      sessionProvider.overrideWith(() => FixedSession(session(roles: driverRoles))),
      activeTripProvider.overrideWith(() => FixedActiveTrip(null)),
      driverHomeProvider.overrideWith(CountingDriverHome.new),
      updateRequiredProvider.overrideWithValue(false),
    ]);
    addTearDown(c.dispose);
    await c.read(modeProvider.notifier).set(AppMode.rider);
    // listened, like the router the app watches (an unlistened provider's listeners are paused)
    final notifier = c.listen(Provider((ref) {
      final n = RouterNotifier(ref);
      ref.onDispose(n.dispose);
      return n;
    }), (_, _) {}).read();
    await c.read(sessionProvider.future);
    await Future<void>.delayed(Duration.zero);
    expect(notifier.followsDriverHome, isFalse);
    expect(c.exists(driverHomeProvider), isFalse);
    expect(CountingDriverHome.builds, 0);

    var notified = 0;
    notifier.addListener(() => notified++);
    await c.read(modeProvider.notifier).set(AppMode.driver);
    await Future<void>.delayed(Duration.zero);
    expect(notifier.followsDriverHome, isTrue);
    await c.read(driverHomeProvider.future);
    await Future<void>.delayed(Duration.zero);
    expect(CountingDriverHome.builds, 1);
    expect(notified, greaterThan(1)); // the mode change, then the profile arriving

    await c.read(modeProvider.notifier).set(AppMode.rider);
    await Future<void>.delayed(Duration.zero);
    expect(notifier.followsDriverHome, isFalse);
  });
}
