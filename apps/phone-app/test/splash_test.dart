// The splash, "Headlights in the dark": on ink, the icon's headlights flicker on, an amber disc
// floods the screen and shrinks into the app icon, then "Anbessa" rises under it; the glow
// breathes while the app still loads; no spinner. The router is held on the splash until the
// icon has settled. With reduced motion it is the final frame. Offline at a cold start, the
// offline line and "Try again" show under the name, and Try again checks the session again.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/core/session/session_controller.dart';
import 'package:phone_app/features/bootstrap/gates.dart';
import 'package:phone_app/features/bootstrap/splash_intro.dart';

import 'account_screens_test.dart' show pumpPage;

Duration _s(double seconds) => Duration(microseconds: (seconds * 1e6).round());

void main() {
  final word = find.byKey(const ValueKey('splash-wordmark'));
  double wordOpacity(WidgetTester tester) => tester.widget<FadeTransition>(find.ancestor(of: word, matching: find.byType(FadeTransition)).first).opacity.value;

  testWidgets('renders on ink: no spinner, the name for screen readers; it keeps breathing while loading', (tester) async {
    await pumpPage(tester, const SplashScreen());
    expect(find.byType(SplashIntro), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.bySemanticsLabel('Anbessa'), findsOneWidget);
    expect(find.text('Try again'), findsNothing);
    expect(tester.widget<Scaffold>(find.byType(Scaffold)).backgroundColor, splashInk);
    // the name is hidden at first and in place once the intro is over
    expect(wordOpacity(tester), 0);
    await tester.pump(_s(SplashTimeline.intro - 0.3));
    expect(wordOpacity(tester), 1);
    // the icon sits centred at 42% of the height, the name 32 px under it
    final screen = tester.getSize(find.byType(SplashIntro));
    expect(tester.getTopLeft(word).dy, closeTo(screen.height * 0.42 + 100 + 32, 0.5));
    expect(tester.getCenter(word).dx, closeTo(screen.width / 2, 0.5));
    // still ticking after the intro (the idle glow)
    await tester.pump(const Duration(seconds: 1));
    expect(tester.hasRunningAnimations, isTrue);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('holds the router until the icon has settled, then releases it', (tester) async {
    final container = await pumpPage(tester, const SplashScreen());
    expect(container.read(splashHoldProvider), isTrue);
    // pumpPage has already played 0.3 s
    await tester.pump(_s(SplashTimeline.settleTime - 0.3 - 0.05));
    expect(container.read(splashHoldProvider), isTrue);
    await tester.pump(const Duration(milliseconds: 60));
    expect(container.read(splashHoldProvider), isFalse);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('reduced motion: the final frame (icon and name), nothing animating, released at once', (tester) async {
    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    final container = await pumpPage(tester, const SplashScreen());
    expect(find.bySemanticsLabel('Anbessa'), findsOneWidget);
    expect(wordOpacity(tester), 1);
    await tester.pump(const Duration(milliseconds: 500));
    expect(tester.hasRunningAnimations, isFalse);
    final painter = tester.widget<CustomPaint>(find.descendant(of: find.byType(SplashIntro), matching: find.byType(CustomPaint))).painter! as SplashPainter;
    expect(painter.still, isTrue);
    expect(container.read(splashHoldProvider), isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets('offline at a cold start: the line and Try again under the name; the art stays put; Try again checks again', (tester) async {
    final container = await pumpPage(tester, const SplashScreen(), offline: true);
    final before = tester.getTopLeft(word);
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.bySemanticsLabel('Anbessa'), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
    expect(tester.getTopLeft(word), before);
    expect(tester.getTopLeft(find.text('Try again')).dy, greaterThan(tester.getBottomLeft(word).dy));
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
    SplashFrame at(double fraction) => SplashFrame.at(SplashTimeline.seconds(fraction), cover: 600);

    test('dark first, then the headlights flicker on and stay', () {
      expect(at(0).lights, 0);
      expect(at(0.10).lights, closeTo(0, 1e-9));
      expect(at(0.12).lights, closeTo(1, 1e-9));
      expect(at(0.14).lights, closeTo(0.15, 1e-9));
      expect(at(0.17).lights, closeTo(1, 1e-9));
      expect(at(0.19).lights, closeTo(0.4, 1e-9));
      expect(at(0.22).lights, 1);
      expect(at(0.6).lights, 1);
      expect(at(0.05).shape, 0);
    });

    test('the glow blooms and fades', () {
      expect(at(0.20).glow, closeTo(0, 1e-9));
      expect(at(0.30).glow, closeTo(0.55, 1e-9));
      expect(at(0.30).glowScale, closeTo(1.25, 1e-9));
      expect(at(0.44).glow, closeTo(0.35, 1e-9));
      expect(at(0.44).glowScale, closeTo(1.1, 1e-9));
      expect(at(0.52).glow, closeTo(0, 1e-9));
      expect(at(0.70).glow, 0);
    });

    test('the amber disc floods the screen, then becomes the icon with a small overshoot', () {
      expect(at(0.32).shape, 0);
      final growing = at(0.41);
      expect(growing.shape, inExclusiveRange(0, 1200));
      expect(growing.corner, closeTo(growing.shape / 2, 1e-9));
      expect(at(0.50).shape, 1200);
      expect(at(0.55).shape, 1200);
      expect(at(0.62).shape, inExclusiveRange(200, 1200));
      expect(at(0.70).shape, closeTo(200, 0.01));
      expect(at(0.74).shape, closeTo(212, 1e-3));
      expect(at(0.74).corner, closeTo(48, 1e-3));
      expect(at(0.78).shape, 200);
      expect(at(0.78).corner, 46);
      expect(at(0.95).shape, 200);
    });

    test('the windshield, nose and grille, then the name', () {
      expect(at(0.48).details, closeTo(0, 1e-3));
      expect(at(0.56).details, closeTo(1, 1e-3));
      expect(at(0.76).word, closeTo(0, 1e-3));
      expect(at(0.76).wordRise, closeTo(18, 1e-2));
      expect(at(0.81).word, inExclusiveRange(0.5, 1));
      expect(at(0.86).word, closeTo(1, 1e-3));
      expect(at(0.86).wordRise, closeTo(0, 1e-2));
      expect(SplashTimeline.settleTime, closeTo(2.496, 1e-9));
    });

    test('the end frame is the icon and the name; afterwards the glow breathes', () {
      final end = SplashFrame.end;
      expect((end.shape, end.corner, end.lights, end.details, end.word, end.glow), (200, 46, 1, 1, 1, 0));
      const t = SplashTimeline.intro;
      expect(SplashFrame.at(t + SplashTimeline.idlePeriod / 2).glow, closeTo(0.25, 1e-9));
      expect(SplashFrame.at(t + SplashTimeline.idlePeriod).glow, closeTo(0, 1e-9));
      expect(SplashFrame.at(t + SplashTimeline.idlePeriod / 4).glow, inExclusiveRange(0, 0.25));
    });
  });
}
