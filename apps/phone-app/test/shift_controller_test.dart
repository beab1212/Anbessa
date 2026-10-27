// The real ShiftController (screen tests use a fixed one): built after the driver home has already
// loaded with an open session, it starts online. It used to read its own state inside build()
// ("Tried to read the state of an uninitialized provider") and crash the driver home.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/core/location/location_source.dart';
import 'package:phone_app/core/network/providers.dart';
import 'package:phone_app/core/realtime/realtime_hub.dart';
import 'package:phone_app/features/driver/shift/shift_controller.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';

void main() {
  test('built after the home loaded with an open session: online, streaming, no crash', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final home = DriverHome.fromJson(fixture('driver_home.json'));
    expect(home.session?.isOpen, isTrue);
    final c = ProviderContainer(overrides: [
      prefsProvider.overrideWithValue(prefs),
      realtimeHubProvider.overrideWithValue(fakeHub()),
      driverHomeProvider.overrideWith(() => FixedDriverHome(home)),
      locationSourceProvider.overrideWithValue(FakeLocationSource(lat: 9.0107, lng: 38.7613)),
    ]);
    addTearDown(c.dispose);
    await c.read(driverHomeProvider.future); // loaded before anyone watches the shift
    final sub = c.listen(shiftProvider, (_, _) {});
    addTearDown(sub.close);
    final s = c.read(shiftProvider);
    expect(s.online, isTrue);
    expect(s.session?.id, home.session!.id);
    expect(s.vehicle?.id, home.session!.vehicleId);
    await Future<void>.delayed(Duration.zero); // streaming starts just after build
    expect(c.read(shiftProvider).online, isTrue);
  });

  test('built with no open session: offline', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final j = Map<String, dynamic>.from(fixture('driver_home.json'))..['session'] = null;
    final c = ProviderContainer(overrides: [
      prefsProvider.overrideWithValue(prefs),
      realtimeHubProvider.overrideWithValue(fakeHub()),
      driverHomeProvider.overrideWith(() => FixedDriverHome(DriverHome.fromJson(j))),
      locationSourceProvider.overrideWithValue(FakeLocationSource(lat: 9.0107, lng: 38.7613)),
    ]);
    addTearDown(c.dispose);
    await c.read(driverHomeProvider.future);
    expect(c.read(shiftProvider).online, isFalse);
  });
}
