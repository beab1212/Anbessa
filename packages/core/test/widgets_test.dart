import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ride_app_core/ride_app_core.dart';

Widget host(Widget child, {Brightness brightness = Brightness.light, bool reduceMotion = false}) => MaterialApp(
      theme: anbessaTheme(brightness: brightness),
      home: MediaQuery(
        data: MediaQueryData(size: const Size(360, 740), disableAnimations: reduceMotion),
        child: Scaffold(body: child),
      ),
    );

void main() {
  testWidgets('AppSheet snaps between its sizes and reports its height', (tester) async {
    final ctrl = AppSheetController();
    final heights = <double>[];
    await tester.pumpWidget(host(Stack(children: [
      AppSheet(
        snaps: const [0.3, 0.8],
        controller: ctrl,
        onHeightChanged: heights.add,
        builder: (_, _) => const SizedBox(height: 1200, child: Text('body')),
      ),
    ])));
    await tester.pumpAndSettle();
    final h = tester.view.physicalSize.height / tester.view.devicePixelRatio;
    expect(ctrl.size, closeTo(0.3, 0.01));
    // the animations only advance as the tester pumps, so don't await them
    unawaited(ctrl.expand());
    await tester.pumpAndSettle();
    expect(ctrl.size, closeTo(0.8, 0.01));
    expect(heights.last, closeTo(0.8 * h, h * 0.02));
    unawaited(ctrl.collapse());
    await tester.pumpAndSettle();
    expect(ctrl.size, closeTo(0.3, 0.01));
  });

  testWidgets('SwipeToConfirm fires past the threshold and springs back below it', (tester) async {
    var fired = 0;
    await tester.pumpWidget(host(Padding(
      padding: const EdgeInsets.all(16),
      child: SwipeToConfirm(label: 'Go online', onConfirmed: () async => fired++),
    )));
    final finder = find.byType(SwipeToConfirm);
    final w = tester.getSize(finder).width;
    // a short drag: nothing happens
    await tester.drag(finder, Offset(w * 0.3, 0));
    await tester.pumpAndSettle();
    expect(fired, 0);
    // all the way: confirmed once
    await tester.drag(finder, Offset(w, 0));
    await tester.pumpAndSettle();
    expect(fired, 1);
    // long-press works too (accessibility)
    await tester.longPress(finder);
    await tester.pumpAndSettle();
    expect(fired, 2);
  });

  testWidgets('PinBoxes completes with the digits', (tester) async {
    String? got;
    await tester.pumpWidget(host(PinBoxes(length: 4, onCompleted: (v) => got = v)));
    await tester.enterText(find.byType(EditableText), '1234');
    // the caret blinks forever, so settle by hand
    await tester.pump(const Duration(milliseconds: 100));
    expect(got, '1234');
    await tester.pumpWidget(host(const PinDisplay('5678')));
    expect(find.text('5'), findsOneWidget);
    expect(find.text('8'), findsOneWidget);
  });

  testWidgets('AnimatedCounter lands on its value', (tester) async {
    await tester.pumpWidget(host(AnimatedCounter(value: 42, format: (v) => v.round().toString())));
    await tester.pumpAndSettle();
    expect(find.text('42'), findsOneWidget);
    await tester.pumpWidget(host(const AnimatedMoney(25000)));
    await tester.pumpAndSettle();
    expect(find.textContaining('250'), findsOneWidget);
  });

  testWidgets('Skeleton has no shimmer when motion is reduced', (tester) async {
    await tester.pumpWidget(host(const Skeleton.line(width: 100), reduceMotion: true));
    expect(find.byType(Skeleton), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(host(const SkeletonList(rows: 2)));
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.takeException(), isNull);
  });

  testWidgets('the rest render in dark mode without errors', (tester) async {
    await tester.pumpWidget(host(
      ListView(children: [
        const StatusPill('Online', tone: Tone.green, pulse: true),
        const SectionGroup(title: 'Ride', children: [SettingsTile(icon: Icons.home, title: 'Saved places', subtitle: 'Home, Work')]),
        SettingsSwitchTile(icon: Icons.vibration, title: 'Vibrate', value: true, onChanged: (_) {}),
        const AvatarImage(name: 'Sara Getachew', size: 48, ring: true),
        EtaBadge(seconds: 240, minuteLabel: (m) => '$m min', approximate: true),
        PillTabs<int>(items: const [(0, 'Today'), (1, 'Week')], selected: 0, onChanged: (_) {}),
        const RatingSummary(average: 4.9, count: 128),
        RatingStars(value: 4, onChanged: (_) {}),
        const StepperHeader(steps: ['Apply', 'Documents', 'Vehicle', 'Review'], current: 1),
        const StatRow(children: [StatTile(label: 'Earnings', value: Text('1,200 ETB')), StatTile(label: 'Trips', value: Text('7'))]),
        const VehicleGlyph('minivan', selected: true),
        const IconTile(icon: Icons.home, label: 'Home', sublabel: 'Bole'),
        const FloatingBanner(text: 'Reconnecting…', tone: NoticeTone.warning, pulse: true),
        const RadarPulse(color: Colors.amber),
        const FadeSlideIn(child: Text('hello')),
        const IllustratedEmpty(illustration: AnbessaIllustration.noTrips, title: 'No trips yet'),
        const PriceTag(fareMinor: 26000, payableMinor: 21000),
        const ProgressMeter(value: 0.75),
      ]),
      brightness: Brightness.dark,
    ));
    await tester.pump(const Duration(milliseconds: 400));
    expect(tester.takeException(), isNull);
    expect(AvatarImage.initialsOf('Sara Getachew'), 'SG');
    expect(AvatarImage.initialsOf('+251900000501'), '');
  });

  testWidgets('PriceTag strikes the fare through only when discounted', (tester) async {
    await tester.pumpWidget(host(const Column(children: [PriceTag(fareMinor: 26000, payableMinor: 21000), PriceTag(fareMinor: 34000, payableMinor: 34000)])));
    await tester.pump(const Duration(seconds: 1));
    final struck = find.byWidgetPredicate((w) => w is Text && w.style?.decoration == TextDecoration.lineThrough);
    expect(struck, findsOneWidget);
    expect((tester.widget(struck) as Text).data, birr(26000));
    expect(find.text(birr(21000)), findsOneWidget);
    expect(find.text(birr(34000)), findsOneWidget);
  });

  testWidgets('showToast appears and leaves', (tester) async {
    late BuildContext ctx;
    await tester.pumpWidget(host(Builder(builder: (c) {
      ctx = c;
      return const SizedBox();
    })));
    showToast(ctx, 'Saved', tone: NoticeTone.ok, duration: const Duration(milliseconds: 300));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Saved'), findsOneWidget);
    await tester.pumpAndSettle();
    expect(find.text('Saved'), findsNothing);
  });
}
