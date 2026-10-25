import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ride_app_rider/core/session/session.dart';
import 'package:ride_app_rider/main.dart';

class _DriverSession extends SessionRole {
  @override
  AppRole? build() => AppRole.driver;
}

void main() {
  testWidgets('boots to the login screen', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: RideApp()));
    expect(find.text('Login'), findsOneWidget);
  });

  testWidgets('rider and driver modes are reachable and sign out returns to login', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: RideApp()));

    await tester.tap(find.text('Continue as rider'));
    await tester.pumpAndSettle();
    expect(find.text('Rider home'), findsOneWidget);

    await tester.tap(find.byTooltip('Sign out'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Continue as driver'));
    await tester.pumpAndSettle();
    expect(find.text('Driver home'), findsOneWidget);
  });

  testWidgets('overriding the session role starts straight in driver mode', (tester) async {
    await tester.pumpWidget(ProviderScope(
      overrides: [sessionRoleProvider.overrideWith(() => _DriverSession())],
      child: const RideApp(),
    ));
    expect(find.text('Driver home'), findsOneWidget);
  });
}
