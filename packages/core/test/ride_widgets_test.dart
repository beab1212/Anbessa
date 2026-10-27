import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ride_app_core/ride_app_core.dart';

/// 360 dp wide, large text.
Widget host(Widget child, {Brightness brightness = Brightness.light, double textScale = 1.3, bool reduceMotion = false}) => MaterialApp(
      theme: anbessaTheme(brightness: brightness),
      home: Builder(
        builder: (context) => MediaQuery(
          data: MediaQuery.of(context).copyWith(size: const Size(360, 740), textScaler: TextScaler.linear(textScale), disableAnimations: reduceMotion),
          child: Scaffold(body: Center(child: SizedBox(width: 360, child: child))),
        ),
      ),
    );

Widget gallery() => SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              QuickActionCircle(icon: Icons.receipt_long_rounded, label: 'Trips', onTap: () {}),
              QuickActionCircle(icon: Icons.support_agent_rounded, label: 'Support', badge: '2', onTap: () {}),
              QuickActionCircle(icon: Icons.bookmark_rounded, label: 'Places', onTap: () {}),
              QuickActionCircle(icon: Icons.settings_rounded, label: 'Settings', tone: Tone.blue, onTap: () {}),
            ],
          ),
          const SizedBox(height: 8),
          Row(children: [
            ServiceTile(icon: Icons.local_taxi_rounded, label: 'Ride', selected: true, onTap: () {}),
            const SizedBox(width: 8),
            ServiceTile(icon: Icons.event_rounded, label: 'Book ahead', badge: 'New', onTap: () {}),
            const SizedBox(width: 8),
            const ServiceTile(art: VehicleArt('minivan', width: 72), label: 'Minivan'),
          ]),
          const SizedBox(height: 8),
          SearchBarButton(hint: 'Where to?', onTap: () {}, trailingLabel: 'Now', heroTag: 'search'),
          const SuggestionRow(title: 'Bole International Airport', subtitle: 'Bole, Addis Ababa', distance: '6.2 km', icon: Icons.flight_rounded),
          SizedBox(
            height: 200,
            child: ListView(scrollDirection: Axis.horizontal, children: [
              VehicleClassCard(code: 'economy', name: 'Economy', fareMinor: 26000, payableMinor: 21000, seats: 4, etaSeconds: 240, minuteLabel: (m) => '$m min', selected: true, badge: 'Promo'),
              const SizedBox(width: 8),
              VehicleClassCard(code: 'comfort', name: 'Comfort', fareMinor: 34000, seats: 4, etaSeconds: 420, minuteLabel: (m) => '$m min'),
              const SizedBox(width: 8),
              const VehicleClassCard(code: 'minivan', name: 'Minivan for families', fareMinor: 52000, seats: 7),
            ]),
          ),
          const Wrap(spacing: 8, runSpacing: 8, children: [PlateBadge('A12345', code: '3'), PlateBadge('B 67890', large: true)]),
          Row(children: [
            RoundIconButton(icon: Icons.arrow_back_rounded, onTap: () {}, tooltip: 'Back'),
            const SizedBox(width: 8),
            RoundIconButton(icon: Icons.sos_rounded, onTap: () {}, tooltip: 'SOS', danger: true),
            const SizedBox(width: 8),
            RecenterPill(label: 'Recenter', onTap: () {}),
          ]),
          const SharedAxisSwitcher(child: Text('step 1', key: ValueKey(1))),
        ],
      ),
    );

void main() {
  for (final b in Brightness.values) {
    testWidgets('new widgets render at 360 dp with text scale 1.3 ($b)', (tester) async {
      await tester.pumpWidget(host(gallery(), brightness: b));
      await tester.pump(const Duration(milliseconds: 600));
      expect(tester.takeException(), isNull);
      expect(find.text('Where to?'), findsOneWidget);
      expect(find.text('Now'), findsOneWidget);
      expect(find.byIcon(Icons.search_rounded), findsOneWidget);
    });
  }

  testWidgets('VehicleClassCard strikes the fare through only when discounted', (tester) async {
    await tester.pumpWidget(host(Row(children: [
      VehicleClassCard(code: 'economy', name: 'Economy', fareMinor: 26000, payableMinor: 21000, seats: 4, etaSeconds: 240, minuteLabel: (m) => '$m min'),
      const VehicleClassCard(code: 'comfort', name: 'Comfort', fareMinor: 34000, payableMinor: 34000),
    ])));
    await tester.pump(const Duration(seconds: 1));
    final struck = find.byWidgetPredicate((w) => w is Text && w.style?.decoration == TextDecoration.lineThrough);
    expect(struck, findsOneWidget);
    expect((tester.widget(struck) as Text).data, birr(26000));
    expect(find.text(birr(21000)), findsOneWidget);
    expect(find.text(birr(34000)), findsOneWidget);
    expect(find.text('4 min'), findsOneWidget);
  });

  testWidgets('VehicleClassCard lifts when selected and taps through', (tester) async {
    var taps = 0;
    Widget card(bool selected) => host(VehicleClassCard(code: 'economy', name: 'Economy', fareMinor: 26000, selected: selected, onTap: () => taps++));
    await tester.pumpWidget(card(false));
    expect(tester.widget<AnimatedScale>(find.byType(AnimatedScale)).scale, 1);
    await tester.pumpWidget(card(true));
    await tester.pump(const Duration(milliseconds: 400));
    expect(tester.widget<AnimatedScale>(find.byType(AnimatedScale)).scale, greaterThan(1));
    await tester.tap(find.text('Economy'));
    expect(taps, 1);
  });

  testWidgets('RecenterPill hides', (tester) async {
    Widget pill(bool visible) => host(RecenterPill(label: 'Recenter', onTap: () {}, visible: visible));
    await tester.pumpWidget(pill(true));
    await tester.pumpAndSettle();
    expect(find.text('Recenter'), findsOneWidget);
    await tester.pumpWidget(pill(false));
    await tester.pumpAndSettle();
    expect(find.text('Recenter'), findsNothing);
    await tester.pumpWidget(pill(true));
    await tester.pumpAndSettle();
    expect(find.text('Recenter'), findsOneWidget);
  });

  testWidgets('SuggestionRow shows the distance and taps', (tester) async {
    var tapped = false;
    await tester.pumpWidget(host(SuggestionRow(title: 'Edna Mall', subtitle: 'Bole', distance: '2.4 km', onTap: () => tapped = true)));
    expect(find.text('2.4 km'), findsOneWidget);
    expect(find.byIcon(Icons.place_rounded), findsOneWidget);
    await tester.tap(find.text('Edna Mall'));
    expect(tapped, isTrue);
  });

  testWidgets('SearchBarButton trailing chip has its own tap', (tester) async {
    var bar = 0, chip = 0;
    await tester.pumpWidget(host(SearchBarButton(hint: 'Where to?', onTap: () => bar++, trailingLabel: 'Now', onTrailingTap: () => chip++)));
    await tester.tap(find.text('Now'));
    await tester.tap(find.text('Where to?'));
    expect((bar, chip), (1, 1));
  });

  testWidgets('SharedAxisSwitcher swaps keyed children and settles on the new one', (tester) async {
    Widget step(int i, {bool reduce = false}) => host(SharedAxisSwitcher(child: Text('step $i', key: ValueKey(i))), reduceMotion: reduce);
    await tester.pumpWidget(step(1));
    await tester.pumpWidget(step(2));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('step 1'), findsOneWidget); // still leaving
    expect(find.text('step 2'), findsOneWidget);
    await tester.pumpAndSettle();
    expect(find.text('step 1'), findsNothing);
    // reduced motion: an instant swap
    await tester.pumpWidget(step(3, reduce: true));
    expect(find.text('step 2'), findsNothing);
    expect(find.text('step 3'), findsOneWidget);
  });

  testWidgets('restored icons draw', (tester) async {
    await tester.pumpWidget(host(SingleChildScrollView(child: Column(children: [
      const StatusPill('Online', tone: Tone.green, icon: Icons.bolt_rounded),
      PrimaryButton(label: 'Request', icon: Icons.local_taxi_rounded, onPressed: () {}),
      const Notice('Heads up', tone: NoticeTone.warning),
      const SizedBox(height: 200, child: EmptyState(title: 'Nothing yet', icon: Icons.history_rounded)),
      const IconTile(icon: Icons.home_rounded, label: 'Home', sublabel: 'Bole'),
      const SectionGroup(children: [SettingsTile(icon: Icons.language_rounded, title: 'Language')]),
      ChoiceRow(title: 'Dark', selected: true, onTap: () {}, leading: const Icon(Icons.dark_mode_rounded)),
      const MapChip(label: '3 cars nearby', icon: Icons.local_taxi_outlined),
      const FloatingBanner(text: 'Offline', tone: NoticeTone.error),
      EtaBadge(seconds: 120, minuteLabel: (m) => '$m min', icon: Icons.schedule_rounded),
      const StatTile(label: 'Trips', value: Text('7'), icon: Icons.route_rounded),
    ])), textScale: 1));
    await tester.pump(const Duration(milliseconds: 400));
    expect(tester.takeException(), isNull);
    for (final i in [
      Icons.bolt_rounded,
      Icons.local_taxi_rounded,
      Icons.warning_rounded,
      Icons.history_rounded,
      Icons.home_rounded,
      Icons.language_rounded,
      Icons.dark_mode_rounded,
      Icons.local_taxi_outlined,
      Icons.error_rounded,
      Icons.schedule_rounded,
      Icons.route_rounded,
    ]) {
      expect(find.byIcon(i), findsOneWidget, reason: '$i');
    }
  });

  test('vehicle art: class codes map to files, all files exist and parse', () async {
    expect(vehicleArtName('Economy'), 'economy');
    expect(vehicleArtName('premium'), 'comfort');
    expect(vehicleArtName('van'), 'minivan');
    expect(vehicleArtName('bajaj'), 'generic');
    TestWidgetsFlutterBinding.ensureInitialized();
    for (final f in ['economy', 'comfort', 'minivan', 'generic']) {
      final svg = await rootBundle.loadString('packages/ride_app_core/assets/vehicles/$f.svg');
      expect(svg, contains('viewBox="0 0 160 64"'));
      await vg.loadPicture(SvgStringLoader(svg), null);
    }
  });

  testWidgets('VehicleArt and IllustratedEmpty load their package assets', (tester) async {
    await tester.pumpWidget(host(const Column(children: [VehicleArt('comfort'), IllustratedEmpty(illustration: AnbessaIllustration.noTrips, title: 'No trips', compact: true)]), brightness: Brightness.dark));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 300)));
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(find.byType(SvgPicture), findsNWidgets(2));
    // the error fallback (an icon) isn't shown
    expect(find.byIcon(vehicleIcon('comfort')), findsNothing);
  });
}
