// The map's credits: no strip of attribution text over the map, a small round "i" above the
// sheet instead, which opens a sheet listing the sources with links to their terms.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/features/driver/shift/driver_home_screen.dart';
import 'package:phone_app/features/maps/anbessa_map.dart';
import 'package:phone_app/features/maps/map_styles.dart';

import 'driver_screens_test.dart' show pumpDriver;

void main() {
  group('attribution sources', () {
    test("OpenFreeMap's line is three sources, each linked to its terms", () {
      final a = mapAttributionsOf(openFreeMapAttribution);
      expect(a.map((s) => s.label), ['© OpenFreeMap', '© OpenMapTiles', '© OpenStreetMap contributors']);
      expect(a.map((s) => s.link?.host), ['openfreemap.org', 'www.openmaptiles.org', 'www.openstreetmap.org']);
      expect(a.last.link.toString(), 'https://www.openstreetmap.org/copyright');
    });

    test('a line without © is one source; unknown sources have no link', () {
      final esri = mapAttributionsOf('Esri, Maxar, Earthstar Geographics').single;
      expect(esri.label, 'Esri, Maxar, Earthstar Geographics');
      expect(esri.link?.host, 'www.arcgis.com');
      expect(mapAttributionsOf('© Our Tiles').single.link, isNull);
    });
  });

  for (final b in Brightness.values) {
    testWidgets('no attribution text on the map; the "i" opens the credits (${b.name})', (tester) async {
      await pumpDriver(tester, const DriverHomeScreen(), brightness: b);
      expect(find.textContaining('OpenStreetMap'), findsNothing);
      expect(find.textContaining('OpenFreeMap'), findsNothing);
      final info = find.byType(MapInfoButton);
      expect(info, findsOneWidget);
      // small and round, bottom left, above the sheet
      final circle = find.descendant(of: info, matching: find.byWidgetPredicate((w) => w is Container && w.decoration is BoxDecoration && (w.decoration! as BoxDecoration).shape == BoxShape.circle));
      expect(tester.getSize(circle), const Size(28, 28));
      final r = tester.getRect(info);
      expect(r.left, lessThan(24));
      expect(r.bottom, lessThan(740 * 0.6));
      expect(find.bySemanticsLabel('Map information'), findsOneWidget);

      await tester.tap(info);
      await tester.pumpAndSettle();
      expect(find.text('Map data'), findsOneWidget);
      expect(find.text('© OpenStreetMap contributors'), findsOneWidget);
      expect(find.byIcon(Icons.open_in_new_rounded), findsOneWidget);
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      expect(find.text('Map data'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  }
}
