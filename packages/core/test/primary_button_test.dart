import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ride_app_core/widgets/primary_button.dart';

void main() {
  testWidgets('PrimaryButton shows its label and fires onPressed', (tester) async {
    var pressed = false;
    await tester.pumpWidget(MaterialApp(
      home: PrimaryButton(label: 'Request ride', onPressed: () => pressed = true),
    ));

    await tester.tap(find.text('Request ride'));
    expect(pressed, isTrue);
  });
}
