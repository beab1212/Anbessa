// The rider cancelling a ride from the map shell: Cancel Ride opens the reasons sheet, a reason
// and "Cancel trip" send POST /api/trips/:id/cancel (reason + idempotency key), the stage turns
// into "Ride has been canceled!" and OK goes home. At each stage that offers it (finding a
// driver, the driver heading over, the driver waiting), and when the server refuses.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/core/l10n/generated/app_localizations.dart';
import 'package:phone_app/core/router/routes.dart';
import 'package:phone_app/features/rider/trip/cancel_sheet.dart';
import 'package:phone_app/features/rider/trip/active_trip_controller.dart';
import 'package:ride_app_core/ride_app_core.dart';

import 'rider_trip_screen_test.dart' show pumpTrip, tripAt, tripJson;
import 'support/fakes.dart';
import 'support/rider_shell.dart';

Map<String, dynamic> _cancelled(String reason) {
  final j = tripJson('cancelled');
  j['cancellation'] = {'by': 'rider', 'reason': reason, 'feeMinor': 0, 'at': '2026-10-27T09:12:00Z'};
  return j;
}

void main() {
  for (final status in ['requested', 'matched', 'en_route']) {
    testWidgets('Cancel Ride → reason → confirm → "Ride has been canceled!" → OK goes home ($status)', (tester) async {
      final t = tripAt(status, withDriver: status != 'requested');
      final backend = FakeBackend();
      backend.on('POST', '/api/trips/${t.id}/cancel', (_) => _cancelled('CHANGED_PLANS'));
      final h = await pumpTrip(tester, t, backend: backend);

      final button = find.byKey(const ValueKey('cancel-ride'));
      await tester.ensureVisible(button);
      await settle(tester);
      await tester.tap(button);
      await settle(tester);
      expect(find.text('Why are you cancelling?'), findsOneWidget);

      await tester.tap(find.text('My plans changed'));
      await settle(tester);
      final confirm = find.byKey(const ValueKey('cancel-confirm'));
      await tester.ensureVisible(confirm);
      await settle(tester);
      await tester.tap(confirm);
      await settle(tester);

      final sent = backend.requests.where((r) => r.method == 'POST' && r.uri.path == '/api/trips/${t.id}/cancel').toList();
      expect(sent, hasLength(1));
      expect(sent.single.data, {'reason': 'CHANGED_PLANS'});
      expect(sent.single.headers['Idempotency-Key'] ?? sent.single.headers['idempotency-key'], isNotNull);

      expect(find.text('Ride has been canceled!'), findsOneWidget);
      expect(h.container.read(activeTripProvider).value?.id, t.id);
      await tester.tap(find.byKey(const ValueKey('canceled-ok')));
      await settle(tester);
      expect(locationOf(h.router), Routes.riderHome);
      expect(tester.takeException(), isNull);
      await endShell(tester, h);
    });
  }

  testWidgets('Keep trip closes the sheet without cancelling', (tester) async {
    final t = tripAt('requested', withDriver: false);
    final backend = FakeBackend();
    final h = await pumpTrip(tester, t, backend: backend);
    // finding a driver: Cancel Ride is on screen at the sheet's resting size, nothing to scroll
    final button = find.byKey(const ValueKey('cancel-ride'));
    final r = tester.getRect(button);
    expect(r.bottom, lessThanOrEqualTo(740));
    await tester.tap(button);
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('cancel-keep')));
    await settle(tester);
    expect(find.text('Why are you cancelling?'), findsNothing);
    expect(backend.requests.where((r) => r.uri.path.endsWith('/cancel')), isEmpty);
    expect(find.text('Finding you a nearby driver...'), findsOneWidget);
    await endShell(tester, h);
  });

  testWidgets('a refused cancel says why and keeps the trip', (tester) async {
    final t = tripAt('matched');
    final backend = FakeBackend();
    backend.on('POST', '/api/trips/${t.id}/cancel', (_) => const FakeReply(409, {'error': 'invalid_state', 'message': 'The trip has already started'}));
    final h = await pumpTrip(tester, t, backend: backend);
    final button = find.byKey(const ValueKey('cancel-ride'));
    await tester.ensureVisible(button);
    await settle(tester);
    await tester.tap(button);
    await settle(tester);
    await tester.tap(find.text('My plans changed'));
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('cancel-confirm')));
    await settle(tester);
    expect(find.text('Ride has been canceled!'), findsNothing);
    expect(find.byKey(const ValueKey('cancel-ride')), findsOneWidget);
    expect(find.byType(Problem), findsWidgets);
    expect(tester.takeException(), isNull);
    await endShell(tester, h);
  });

  testWidgets('the driver reasons sheet fits a small phone with large text: reason, then Cancel trip', (tester) async {
    tester.view.physicalSize = const Size(320 * 3, 568 * 3);
    tester.view.devicePixelRatio = 3;
    tester.platformDispatcher.textScaleFactorTestValue = 1.3;
    addTearDown(tester.view.reset);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    CancelReason? picked;
    await tester.pumpWidget(MaterialApp(
      theme: anbessaTheme(),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Builder(builder: (context) => Scaffold(body: Center(child: TextButton(onPressed: () async => picked = await showCancelSheet(context, free: true, feeMinor: 0, driverSide: true), child: const Text('open'))))),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull); // no overflow
    final confirm = find.byKey(const ValueKey('cancel-confirm'));
    expect(tester.getRect(confirm).bottom, lessThanOrEqualTo(568));
    await tester.tap(find.byKey(const ValueKey('cancel-reason-noShow')));
    await tester.pumpAndSettle();
    await tester.tap(confirm);
    await tester.pumpAndSettle();
    expect(picked, CancelReason.noShow);
  });
}
