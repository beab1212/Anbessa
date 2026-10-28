// The splash: our car drives in along the road and stops in the middle while "Anbessa" rises
// under it, then cruises on the spot while the app loads; no spinner and no logo square. With
// reduced motion it is the still end state. Offline at a cold start, the offline line and "Try
// again" show under the name, and Try again checks the session again.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/core/session/session_controller.dart';
import 'package:phone_app/features/bootstrap/gates.dart';
import 'package:phone_app/features/bootstrap/splash_intro.dart';

import 'account_screens_test.dart' show pumpPage;

void main() {
  testWidgets('renders the drive-in: no spinner, no logo, the name for screen readers; it keeps moving while loading', (tester) async {
    await pumpPage(tester, const SplashScreen());
    expect(find.byType(SplashIntro), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.byType(AnbessaLogo), findsNothing);
    expect(find.bySemanticsLabel('Anbessa'), findsOneWidget);
    expect(find.text('Try again'), findsNothing);
    // one painter, repainting from its clock; still ticking after the intro (the cruise)
    await tester.pump(const Duration(seconds: 3));
    expect(tester.hasRunningAnimations, isTrue);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('reduced motion: the still car and the name, nothing animating', (tester) async {
    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    await pumpPage(tester, const SplashScreen());
    expect(find.byType(SplashIntro), findsOneWidget);
    expect(find.bySemanticsLabel('Anbessa'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 500));
    expect(tester.hasRunningAnimations, isFalse);
    final painter = tester.widget<CustomPaint>(find.descendant(of: find.byType(SplashIntro), matching: find.byType(CustomPaint))).painter! as SplashPainter;
    expect(painter.still, isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('offline at a cold start: the line and Try again under the name; Try again checks again', (tester) async {
    final container = await pumpPage(tester, const SplashScreen(), offline: true);
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.bySemanticsLabel('Anbessa'), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
    expect(tester.getTopLeft(find.text('Try again')).dy, greaterThan(tester.getBottomLeft(find.byType(SplashIntro)).dy));
    var builds = 0;
    container.listen(sessionProvider, (_, _) => builds++);
    await tester.tap(find.text('Try again'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(builds, greaterThan(0));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  group('the timeline', () {
    test('drives in from off-screen left and stops in the middle at the end of the drive', () {
      expect(SplashFrame.at(0).carX, -1);
      expect(SplashFrame.at(0).speed, 1);
      final mid = SplashFrame.at(SplashTimeline.driveEnd / 2);
      expect(mid.carX, inExclusiveRange(-1, 0));
      expect(SplashFrame.at(SplashTimeline.driveEnd).carX, closeTo(0, 1e-9));
      expect(SplashFrame.at(SplashTimeline.driveEnd + 0.4).carX, 0);
      // the car only moves forward
      var last = -2.0;
      for (var t = 0.0; t <= SplashTimeline.driveEnd; t += 0.02) {
        final x = SplashFrame.at(t).carX;
        expect(x, greaterThanOrEqualTo(last));
        last = x;
      }
    });

    test('the nose dips when it brakes, then settles', () {
      final peak = [for (var t = SplashTimeline.driveEnd; t < SplashTimeline.driveEnd + 0.5; t += 0.01) SplashFrame.at(t).pitch].reduce((a, b) => a > b ? a : b);
      expect(peak, greaterThan(1));
      expect(SplashFrame.at(SplashTimeline.driveEnd + 1.2).pitch.abs(), lessThan(0.05));
    });

    test('the letters rise one after another and are all in place when the intro ends', () {
      final f = SplashFrame.at(SplashTimeline.lettersStart + SplashTimeline.letterGap * 2);
      expect(f.letters.first, greaterThan(f.letters[1]));
      expect(f.letters.last, 0);
      expect(SplashFrame.at(SplashTimeline.introEnd).letters, everyElement(1.0));
    });

    test('the wheels turn with the distance; the road slides by while it cruises', () {
      expect(SplashFrame.at(0.5).wheel, greaterThan(SplashFrame.at(0.2).wheel));
      expect(SplashFrame.at(SplashTimeline.idleStart).roadShift, 0);
      final a = SplashFrame.at(SplashTimeline.idleStart + 2), b = SplashFrame.at(SplashTimeline.idleStart + 3);
      expect(b.roadShift - a.roadShift, closeTo(70, 1));
      expect(b.wheel, greaterThan(a.wheel));
    });
  });
}
