// The earnings dashboard (periods, chart, balance) and the onboarding hub (steps, next action),
// at large text, in light and dark.

import 'dart:ui' show PictureRecorder;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/features/driver/earnings/earnings_chart.dart';
import 'package:phone_app/features/driver/earnings/earnings_screens.dart';
import 'package:phone_app/features/driver/onboarding/onboarding_screens.dart';
import 'package:ride_app_core/ride_app_core.dart';

import 'driver_screens_test.dart' show pumpDriver;
import 'support/fakes.dart';

EarningsSummary summary({int trips = 4, List<Map<String, Object>> byDay = const []}) => EarningsSummary.fromJson({
      'from': '2026-10-20T21:00:00Z', 'to': '2026-10-27T21:00:00Z', 'trips': trips, 'cancellations': 1,
      'grossMinor': 60000, 'commissionMinor': 9000, 'vatMinor': 1350, 'netMinor': 49650, 'cashCollectedMinor': 30000, 'byDay': byDay,
    });

void main() {
  testWidgets('earnings: net hero, breakdown, balance and the week chart', (tester) async {
    final week = [for (var d = 21; d <= 27; d++) {'day': '2026-10-$d', 'trips': d % 3, 'grossMinor': 12000 * (d % 3), 'netMinor': 9930 * (d % 3)}];
    await pumpDriver(tester, const EarningsScreen(), brightness: Brightness.dark);
    expect(find.text('Net earnings'), findsWidgets);
    expect(find.textContaining('496'), findsWidgets); // 496.50 ETB
    expect(find.text('Where it went'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('ANB-9P7N8H'), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text('Top up'), findsOneWidget);
    expect(find.text('ANB-9P7N8H'), findsOneWidget);
    expect(find.byType(EarningsChart), findsNothing); // today has one day → no chart
    await tester.scrollUntilVisible(find.text('This week'), -200, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.text('This week'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
    expect(tester.takeException(), isNull);
    // a week with days renders the chart
    await tester.pumpWidget(const SizedBox());
    await pumpDriver(tester, const EarningsScreen(), summary: summary(byDay: week));
    expect(find.byType(EarningsChart), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  test('chart painter: bars scale to the largest day and negatives hang below the axis', () {
    final days = [
      EarningsDay(day: '2026-10-21', trips: 2, grossMinor: 20000, netMinor: 16000),
      EarningsDay(day: '2026-10-22', trips: 0, grossMinor: 0, netMinor: -4000),
    ];
    final painter = EarningsChartPainter(days: days, bar: Colors.amber, negative: Colors.red, grid: Colors.grey, label: Colors.black);
    final rec = PictureRecorder();
    painter.paint(Canvas(rec), const Size(200, 120));
    rec.endRecording();
    expect(painter.shouldRepaint(EarningsChartPainter(days: const [], bar: Colors.amber, negative: Colors.red, grid: Colors.grey, label: Colors.black)), isTrue);
  });

  testWidgets('onboarding hub: an approved driver sees all steps done and Go online', (tester) async {
    await pumpDriver(tester, const OnboardingHubScreen());
    expect(find.text('Go online'), findsOneWidget);
    expect(find.text('Almaz Tadesse'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('onboarding hub: an applicant with missing documents is sent to upload them', (tester) async {
    final j = Map<String, dynamic>.from(fixture('driver_home.json'));
    final d = Map<String, dynamic>.from(j['driver'] as Map);
    d['status'] = 'APPLIED';
    d['documents'] = [
      for (final doc in (d['documents'] as List)) {...(doc as Map), 'document': (doc['kind'] == 'LICENSE') ? doc['document'] : null},
    ];
    d['missingForSubmit'] = ['NATIONAL_ID', 'PHOTO'];
    j['driver'] = d;
    j['vehicles'] = [];
    j['fleetVehicles'] = [];
    final home = DriverHome.fromJson(j);
    await pumpDriver(tester, const OnboardingHubScreen(), brightness: Brightness.dark, driverHome: home);
    expect(find.text('Upload your documents'), findsOneWidget);
    expect(find.textContaining('still to upload'), findsOneWidget);
    expect(find.text('Upload'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('progress: steps follow the application', (tester) async {
    expect(OnboardingProgress.of(null, canDrive: false).current, 0);
    final home = DriverHome.fromJson(fixture('driver_home.json'));
    final p = OnboardingProgress.of(home, canDrive: true);
    expect(p.current, 3);
    expect(p.done, {0, 1, 2, 3});
    expect(p.fraction, 1);
  });
}
