import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/core/router/app_router.dart';
import 'package:phone_app/core/router/routes.dart';
import 'package:phone_app/core/session/session_controller.dart';
import 'package:phone_app/features/config/client_config_provider.dart';
import 'package:phone_app/features/driver/shift/shift_controller.dart';
import 'package:phone_app/features/intro/intro_screen.dart';
import 'package:phone_app/features/rider/trip/active_trip_controller.dart';
import 'package:ride_app_core/ride_app_core.dart';

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

  test('an active trip takes over, except SOS and account screens', () async {
    final trip = Trip.fromJson(fixture('trip.json'));
    expect(trip.isActive, isTrue);
    expect(await redirect(Routes.riderHome, signedIn: session(), trip: trip), Routes.riderTrip(trip.id));
    expect(await redirect(Routes.riderTrip(trip.id), signedIn: session(), trip: trip), isNull);
    expect(await redirect('${Routes.riderTrip(trip.id)}/pay', signedIn: session(), trip: trip), isNull);
    expect(await redirect(Routes.sos, signedIn: session(), trip: trip), isNull);
    expect(await redirect(Routes.language, signedIn: session(), trip: trip), isNull);
  });
}
