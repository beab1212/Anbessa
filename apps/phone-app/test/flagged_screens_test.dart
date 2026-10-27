// The modules waiting for their backend render cleanly (large text, light and dark) and say so.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/features/flagged/flagged_modules.dart';

import 'driver_screens_test.dart' show pumpDriver;

void main() {
  final screens = <String, Widget>{
    'scheduled rides': const ScheduledRidesScreen(),
    'support': const SupportScreen(),
    'promos': const PromosScreen(),
    'new ticket': const NewTicketScreen(),
    'SOS': const SosScreen(),
    'delete account': const DeleteAccountScreen(),
  };
  for (final e in screens.entries) {
    for (final b in Brightness.values) {
      testWidgets('${e.key} (${b.name})', (tester) async {
        await pumpDriver(tester, e.value, brightness: b);
        if (e.key != 'SOS' && e.key != 'delete account') expect(find.text('Coming soon'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }
  }
}
