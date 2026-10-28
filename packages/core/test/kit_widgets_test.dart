import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ride_app_core/ride_app_core.dart';

/// 360 dp wide, large text.
Widget host(Widget child, {Brightness brightness = Brightness.light, double textScale = 1.3, bool reduceMotion = false}) => MaterialApp(
      theme: anbessaTheme(brightness: brightness),
      home: Builder(
        builder: (context) => MediaQuery(
          data: MediaQuery.of(context).copyWith(size: const Size(360, 800), textScaler: TextScaler.linear(textScale), disableAnimations: reduceMotion),
          child: Scaffold(body: SizedBox(width: 360, child: child)),
        ),
      ),
    );

Widget gallery() => Builder(
      builder: (context) => ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const AppTopBar(title: 'Where do you want to go?', leadingKind: TopBarLeading.close, centerTitle: false),
          AppTopBar(title: 'Choose Payment Method', actions: [IconButton(onPressed: () {}, icon: const Icon(Icons.add_rounded))]),
          const FilledField(label: 'Full Name', hint: 'Full Name'),
          const FilledField(label: 'Email', icon: Icons.mail_outline_rounded, initialValue: 'abebe.kebede@example.com'),
          FilledField.phone(label: 'Phone Number', dialCode: '+251', flag: const Text('ET'), onCountryTap: () {}, hint: 'Phone Number'),
          const FilledField(label: 'Gender', initialValue: 'Male', readOnly: true, suffix: Icon(Icons.keyboard_arrow_down_rounded)),
          SegmentedTabs<int>(items: const [(0, 'Recent'), (1, 'Suggested')], selected: 0, onChanged: (_) {}),
          SegmentedTabs<int>(items: const [(0, 'Today'), (1, 'Tomorrow'), (2, 'Select Date')], selected: 1, onChanged: (_) {}),
          ChipRow(children: [OutlineChip(label: 'Select from map', icon: Icons.map_outlined, onTap: () {}), OutlineChip(label: 'Home', onTap: () {}), OutlineChip(label: 'Office', selected: true, onTap: () {})]),
          PillButtonPair(first: PillButton(label: 'Skip', variant: PillVariant.tonal, onPressed: () {}), second: PillButton(label: 'Continue', onPressed: () {})),
          for (final v in PillVariant.values) PillButton(label: 'Variant ${v.name}', variant: v, icon: Icons.phone_rounded, onPressed: () {}),
          const PillButton(label: 'Disabled'),
          PillButton(label: 'Redeem', compact: true, onPressed: () {}),
          BottomActionBar(child: PillButton(label: 'Continue', onPressed: () {})),
          PillButton(label: 'Book Anbessa Car', trailing: '210 ETB', onPressed: () {}),
          RoutePointsCard(points: [RoutePointsCard.pickup('Bole Medhanialem Church, Addis Ababa'), RoutePointsCard.destination('Piassa, Addis Ababa')], onAdd: () {}),
          RideClassTile(code: 'economy', name: 'Anbessa Car Premium Plus', fareMinor: 26000, payableMinor: 21000, etaLabel: '3–5 mins', seatsLabel: '4 passengers', selected: true, onTap: () {}),
          RideClassTile(code: 'minivan', name: 'Minivan', fareMinor: 52000, etaLabel: '4–6 mins', seatsLabel: '6 passengers', onTap: () {}),
          ListRowTile(title: 'Addis Ababa University, Sidist Kilo campus', subtitle: 'Sidist Kilo, Addis Ababa, Ethiopia', icon: Icons.location_on_outlined, value: '12.4 km', trailing: const Icon(Icons.bookmark_border_rounded), divider: true, onTap: () {}),
          ListRowTile(title: 'Saved Addresses', icon: Icons.location_on_outlined, chevron: true, onTap: () {}),
          ListRowTile(title: 'Edna Mall', subtitle: 'Dec 20 · 08:49', value: '560 ETB', valueSub: 'Canceled & Refunded', valueSubColor: Colors.red, icon: Icons.directions_car_outlined),
          DriverRow(name: 'Tewodros Hailemariam', rating: '4.8', phone: '+251 911 555 640', onChat: () {}, onCall: () {}),
          KeyValueCard(
            rows: [KeyValueCard.row('Trip Fare', '260 ETB'), KeyValueCard.row('Discounts (20%)', '- 50 ETB'), KeyValueCard.row('Status', 'Done')],
            trailing: const {2: OutlineBadge('Completed')},
            total: KeyValueCard.row('Total Paid', '210 ETB'),
          ),
          StatTriple(items: [StatTriple.item(Icons.star_border_rounded, '4.8', 'Rating'), StatTriple.item(Icons.directions_car_outlined, '9,205', 'Ride orders'), StatTriple.item(Icons.schedule_rounded, '3', 'Years')]),
          SelectableCard(selected: true, onTap: () {}, child: const Text('Anbessa Wallet')),
          SelectableCard(selected: false, onTap: () {}, child: const Text('Cash')),
          const SuccessDialog(title: 'Top Up Successful!', message: 'You have added 250 ETB to your wallet.', okLabel: 'OK', secondaryLabel: 'Later'),
          const ResultSheet(title: 'Whoops!', message: 'The promo code is invalid or expired.', icon: Icons.close_rounded, danger: true),
          const ConfirmSheet(title: 'Delete Address', message: 'Sure you want to delete this address?', confirmLabel: 'Yes, Delete', cancelLabel: 'Cancel', destructive: true),
          const Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [MapAvatarPin(name: 'Abebe Kebede'), DestinationPin(), TopDownCar(heading: 30), LocatingDot()]),
          const Center(child: RadarRings(size: 160, child: CircleAvatar())),
          const Row(children: [Expanded(child: VehicleArt('economy')), Expanded(child: VehicleArt('comfort')), Expanded(child: VehicleArt('minivan'))]),
        ],
      ),
    );

void main() {
  for (final b in Brightness.values) {
    testWidgets('the GoRide components render at 360 dp with text scale 1.3 ($b)', (tester) async {
      await tester.pumpWidget(host(gallery(), brightness: b));
      await tester.pump(const Duration(milliseconds: 600));
      // scroll through so every row is laid out
      for (var i = 0; i < 20; i++) {
        await tester.drag(find.byType(ListView), const Offset(0, -500));
        await tester.pump(const Duration(milliseconds: 100));
        expect(tester.takeException(), isNull);
      }
    });
  }

  testWidgets('PillButton taps, ignores taps while busy or disabled, and scales on press', (tester) async {
    var taps = 0;
    await tester.pumpWidget(host(Column(children: [
      PillButton(label: 'Go', onPressed: () => taps++),
      PillButton(label: 'Busy', busy: true, onPressed: () => taps++),
      const PillButton(label: 'Off'),
    ])));
    await tester.tap(find.text('Go'));
    await tester.tap(find.text('Busy'), warnIfMissed: false);
    await tester.tap(find.text('Off'), warnIfMissed: false);
    expect(taps, 1);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    final g = await tester.startGesture(tester.getCenter(find.text('Go')));
    await tester.pump(const Duration(milliseconds: 200));
    final scale = tester.widget<AnimatedScale>(find.descendant(of: find.widgetWithText(PillButton, 'Go'), matching: find.byType(AnimatedScale)));
    expect(scale.scale, lessThan(1));
    await g.up();
    await tester.pump(const Duration(milliseconds: 400)); // the busy spinner never settles
    final after = tester.widget<AnimatedScale>(find.descendant(of: find.widgetWithText(PillButton, 'Go'), matching: find.byType(AnimatedScale)));
    expect(after.scale, 1);
  });

  testWidgets('PrimaryButton is a primary (or danger) pill', (tester) async {
    await tester.pumpWidget(host(Column(children: [PrimaryButton(label: 'Go', onPressed: () {}), PrimaryButton(label: 'Stop', danger: true, onPressed: () {})])));
    expect(tester.widget<PillButton>(find.widgetWithText(PillButton, 'Go')).variant, PillVariant.primary);
    expect(tester.widget<PillButton>(find.widgetWithText(PillButton, 'Stop')).variant, PillVariant.danger);
  });

  testWidgets('SegmentedTabs reports a new selection only', (tester) async {
    final got = <int>[];
    await tester.pumpWidget(host(SegmentedTabs<int>(items: const [(0, 'Recent'), (1, 'Suggested')], selected: 0, onChanged: got.add)));
    await tester.tap(find.text('Recent'));
    await tester.tap(find.text('Suggested'));
    expect(got, [1]);
  });

  testWidgets('SelectableCard shows the check only when selected', (tester) async {
    await tester.pumpWidget(host(Column(children: [
      SelectableCard(selected: true, onTap: () {}, child: const Text('A')),
      SelectableCard(selected: false, onTap: () {}, child: const Text('B')),
    ])));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.check_rounded), findsOneWidget);
  });

  testWidgets('RideClassTile strikes the fare through only when discounted', (tester) async {
    await tester.pumpWidget(host(Column(children: [
      const RideClassTile(code: 'economy', name: 'Economy', fareMinor: 26000, payableMinor: 21000),
      const RideClassTile(code: 'comfort', name: 'Comfort', fareMinor: 34000, payableMinor: 34000),
    ])));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.verified_rounded), findsOneWidget);
    final struck = tester.widgetList<Text>(find.byType(Text)).where((t) => t.style?.decoration == TextDecoration.lineThrough);
    expect(struck.map((t) => t.data), [birr(26000)]);
  });

  testWidgets('showConfirmSheet resolves true on confirm and false on cancel', (tester) async {
    bool? result;
    await tester.pumpWidget(host(Builder(
      builder: (context) => TextButton(
        onPressed: () async => result = await showConfirmSheet(context, title: 'Delete Address', message: 'Sure?', confirmLabel: 'Yes, Delete', cancelLabel: 'Cancel', destructive: true),
        child: const Text('open'),
      ),
    )));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Yes, Delete'));
    await tester.pumpAndSettle();
    expect(result, isTrue);
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(result, isFalse);
  });

  testWidgets('showSuccessDialog closes with OK', (tester) async {
    bool? result;
    await tester.pumpWidget(host(Builder(
      builder: (context) => TextButton(onPressed: () async => result = await showSuccessDialog(context, title: 'Done!', okLabel: 'OK'), child: const Text('open')),
    )));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('Done!'), findsOneWidget);
    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();
    expect(result, isTrue);
  });

  testWidgets('RadarRings settles when motion is reduced', (tester) async {
    await tester.pumpWidget(host(const Center(child: RadarRings()), reduceMotion: true));
    await tester.pumpAndSettle();
    expect(tester.hasRunningAnimations, isFalse);
  });

  testWidgets('markers rasterise to PNG for the map', (tester) async {
    late Uint8List car, pin, dest;
    await tester.runAsync(() async {
      car = await markerPngBytes(topDownCarSize(24), (canvas, size) => paintTopDownCar(canvas, size), pixelRatio: 2);
      pin = await markerPngBytes(avatarPinSize(52), (canvas, size) => paintAvatarPin(canvas, size, ring: const Color(0xFFFFB300), initials: 'AK'), pixelRatio: 2);
      dest = await markerPngBytes(destinationPinSize(40), (canvas, size) => paintDestinationPin(canvas, size), pixelRatio: 2);
    });
    for (final bytes in [car, pin, dest]) {
      expect(bytes.sublist(1, 4), 'PNG'.codeUnits);
    }
  });
}
