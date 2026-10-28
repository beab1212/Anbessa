// Activity (the kit's Ongoing / Scheduled / Completed / Cancelled chips) and ride details, at
// 360 dp with 1.3x text, in light and dark.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/features/rider/history/history_screens.dart';
import 'package:ride_app_core/ride_app_core.dart';

import 'booking_extras_test.dart' show pumpWithBackend, settle, tapText;
import 'support/fakes.dart';

Json _trip(String id, String status, String dropoff, String at, {String method = 'CASH', int fare = 22000, int fee = 0}) {
  final j = Map<String, dynamic>.from(fixture('trip.json'));
  j['id'] = id;
  j['status'] = status;
  j['paymentMethod'] = method;
  j['dropoff'] = {'lat': 9.03, 'lng': 38.74, 'address': dropoff};
  j['fare'] = {...asJson(j['fare']), 'estimateMinor': fare, 'payableMinor': fare, 'finalMinor': fare};
  j['times'] = {...asJson(j['times']), 'requestedAt': at, if (status == 'completed') 'completedAt': at, if (status == 'cancelled') 'cancelledAt': at};
  if (status == 'cancelled') j['cancellation'] = {'by': 'RIDER', 'reason': 'CHANGED_PLANS', 'feeMinor': fee, 'driverCompensationMinor': 0};
  return j;
}

const _ongoing = 'a0000000-0000-4000-8000-000000000001';

List<Json> _trips() {
  final now = DateTime.now().toUtc();
  String ago(int days) => now.subtract(Duration(days: days)).toIso8601String();
  return [
    _trip(_ongoing, 'en_route', 'Piassa, Cathedral', ago(0), method: 'MOBILE_MONEY'),
    _trip('a0000000-0000-4000-8000-000000000002', 'completed', 'Edna Mall', ago(1), fare: 17750),
    _trip('a0000000-0000-4000-8000-000000000003', 'completed', 'Bole International Airport', ago(20), fare: 65000),
    _trip('a0000000-0000-4000-8000-000000000004', 'cancelled', 'Sheraton Addis', ago(2), fee: 5000),
    _trip('a0000000-0000-4000-8000-000000000005', 'cancelled', 'Unity Park', ago(3)),
  ];
}

void main() {
  for (final b in Brightness.values) {
    testWidgets('chips: ongoing card with Track route, completed rows, cancelled in red (${b.name})', (tester) async {
      final backend = FakeBackend()..on('GET', '/api/trips', (_) => {'trips': _trips(), 'next': null});
      await pumpWithBackend(tester, backend, HistoryScreen(as: 'rider', receiptRoute: (id) => '/rider/trip/$id'), brightness: b);
      // a trip is in progress, so Ongoing opens first: the row, the route and Track route
      expect(tester.widget<OutlineChip>(find.widgetWithText(OutlineChip, 'Ongoing')).selected, isTrue);
      expect(find.text('Piassa, Cathedral'), findsWidgets);
      expect(find.byType(RoutePointsCard), findsOneWidget);
      expect(find.text('Track route'), findsOneWidget);
      // no Scheduled chip without the flag
      expect(find.widgetWithText(OutlineChip, 'Scheduled'), findsNothing);
      expect(tester.takeException(), isNull);

      await tapText(tester, 'Completed');
      expect(find.text('Edna Mall'), findsOneWidget);
      expect(find.text(birr(17750)), findsOneWidget);
      expect(find.text('Cash'), findsWidgets);
      expect(find.text('Sheraton Addis'), findsNothing);

      await tapText(tester, 'Cancelled');
      expect(find.text('Sheraton Addis'), findsOneWidget);
      final fee = tester.widget<Text>(find.text('Cancellation fee'));
      expect(fee.style?.color, anbessaTheme(brightness: b).extension<AnbessaColors>()!.danger);
      expect(find.text('Cancelled, no charge'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('Track route opens the live trip; the period menu filters', (tester) async {
    final backend = FakeBackend()..on('GET', '/api/trips', (_) => {'trips': _trips(), 'next': null});
    await pumpWithBackend(tester, backend, HistoryScreen(as: 'rider', receiptRoute: (id) => '/rider/trip/$id'));
    await tapText(tester, 'Completed');
    expect(find.text('Bole International Airport'), findsOneWidget);
    await tester.tap(find.byTooltip('More options'));
    await settle(tester);
    await tapText(tester, 'This week');
    expect(find.text('Bole International Airport'), findsNothing);
    expect(find.text('Edna Mall'), findsOneWidget);

    await tapText(tester, 'Ongoing');
    await tapText(tester, 'Track route');
    expect(find.text('trip page $_ongoing'), findsOneWidget);
  });

  testWidgets('nothing yet: each chip says so', (tester) async {
    final backend = FakeBackend()..on('GET', '/api/trips', (_) => {'trips': [], 'next': null});
    await pumpWithBackend(tester, backend, HistoryScreen(as: 'rider', receiptRoute: (id) => '/rider/trip/$id'), brightness: Brightness.dark);
    expect(find.text('No trips yet'), findsOneWidget);
    await tapText(tester, 'Ongoing');
    expect(find.text('No trip in progress'), findsOneWidget);
    await tapText(tester, 'Cancelled');
    expect(find.text('No cancelled trips'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('ride details: headline, status badge, class and price, route, fare with total', (tester) async {
    final t = _trip('a0000000-0000-4000-8000-000000000002', 'completed', 'Edna Mall', DateTime.now().toUtc().toIso8601String(), fare: 17750);
    final backend = FakeBackend()
      ..on('GET', '/api/trips/a0000000-0000-4000-8000-000000000002', (_) => t)
      ..on('GET', '/api/trips/a0000000-0000-4000-8000-000000000002/parties', (_) => {'driver': {'name': 'Dawit Bekele'}, 'rider': {'name': 'Abebe'}});
    await pumpWithBackend(tester, backend, const ReceiptScreen(tripId: 'a0000000-0000-4000-8000-000000000002', asDriver: false));
    expect(find.text('Ride details'), findsOneWidget);
    expect(find.widgetWithText(OutlineBadge, 'Completed'), findsOneWidget);
    expect(find.byType(VehicleArt), findsOneWidget);
    expect(find.byType(RoutePointsCard), findsOneWidget);
    await tester.scrollUntilVisible(find.text('Total'), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text('Total'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
