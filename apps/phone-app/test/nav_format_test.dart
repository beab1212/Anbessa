// Guidance distances ("Now", "50 m", "850 m", "1.2 km"), roundabout exits and short
// instructions, in English and Amharic.

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/core/l10n/generated/app_localizations.dart';
import 'package:phone_app/features/maps/nav/nav_format.dart';
import 'package:ride_app_core/ride_app_core.dart';

void main() {
  final en = lookupAppLocalizations(const Locale('en'));
  final am = lookupAppLocalizations(const Locale('am'));

  test('navDistance rounds the way a driver reads it', () {
    expect(navDistance(en, 0), 'Now');
    expect(navDistance(en, 14), 'Now');
    expect(navDistance(en, 15), '20 m');
    expect(navDistance(en, 47), '50 m');
    expect(navDistance(en, 94), '90 m');
    expect(navDistance(en, 99), '100 m');
    expect(navDistance(en, 100), '100 m');
    expect(navDistance(en, 212), '200 m');
    expect(navDistance(en, 830), '850 m');
    expect(navDistance(en, 990), '1.0 km');
    expect(navDistance(en, 1240), '1.2 km');
    expect(navDistance(en, 12400), '12 km');
  });

  test('navDistance in Amharic', () {
    expect(navDistance(am, 5), 'አሁን');
    expect(navDistance(am, 212), '200 ሜ');
    expect(navDistance(am, 1240), '1.2 ኪ.ሜ');
  });

  test('spoken distances', () {
    expect(navSpokenDistance(en, 205), '200 metres');
    expect(navSpokenDistance(en, 1500), '1.5 kilometres');
    expect(navSpokenDistance(en, 5), isNull);
    expect(navSpokenDistance(am, 500), '500 ሜትር');
  });

  test('ordinals', () {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map((n) => navOrdinal(en, n)), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
    expect(navOrdinal(am, 2), '2');
  });

  test('roundabouts say which exit', () {
    const named = RouteStep(type: 'roundabout', modifier: 'right', exit: 2, lat: 9, lng: 38, bearingAfter: 0, name: 'Bole Road', distanceMeters: 300, durationSeconds: 30);
    const unnamed = RouteStep(type: 'rotary', modifier: 'left', exit: 3, lat: 9, lng: 38, bearingAfter: 0, name: '', distanceMeters: 300, durationSeconds: 30);
    expect(navInstruction(en, named), 'Take the 2nd exit onto Bole Road');
    expect(navInstruction(en, unnamed), 'Take the 3rd exit');
    expect(navShortInstruction(en, named), 'Take the 2nd exit');
    expect(navInstruction(am, named), contains('2ኛውን'));
  });

  test('instructions use the street, or a short form without one', () {
    const left = RouteStep(type: 'turn', modifier: 'left', lat: 9, lng: 38, bearingAfter: 0, name: 'Bole Road', distanceMeters: 300, durationSeconds: 30);
    const leftNoName = RouteStep(type: 'turn', modifier: 'left', lat: 9, lng: 38, bearingAfter: 0, name: '', distanceMeters: 300, durationSeconds: 30);
    expect(navInstruction(en, left), 'Turn left onto Bole Road');
    expect(navInstruction(en, leftNoName), 'Turn left');
    expect(navShortInstruction(am, left), 'ወደ ግራ ይታጠፉ');
  });
}
