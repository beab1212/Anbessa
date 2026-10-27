// The module still waiting for its backend (account deletion) renders cleanly (large text, light
// and dark). SOS and support have their backend now (support_screens_test.dart); so do scheduled
// rides and promo codes (scheduled_realtime_test.dart, booking_extras_test.dart).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/features/flagged/flagged_modules.dart';

import 'driver_screens_test.dart' show pumpDriver;

void main() {
  for (final b in Brightness.values) {
    testWidgets('delete account (${b.name})', (tester) async {
      await pumpDriver(tester, const DeleteAccountScreen(), brightness: b);
      expect(find.text('Delete my account'), findsWidgets);
      expect(tester.takeException(), isNull);
    });
  }
}
