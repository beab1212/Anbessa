// How a car on the map decides which way it faces and how it turns: the shortest arc round
// 0°/360°, a parked car holding its heading, GPS jitter ignored, movement of 8 m or more counted,
// the road's bearing as a fallback, and a short ease only when the heading changes.

import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/features/maps/heading_filter.dart';
import 'package:ride_app_core/ride_app_core.dart';

void main() {
  const a = (lat: 9.0107, lng: 38.7613);

  group('shortestTurn', () {
    test('wraps round north both ways', () {
      expect(shortestTurn(350, 10), closeTo(20, 1e-9));
      expect(shortestTurn(10, 350), closeTo(-20, 1e-9));
      expect(shortestTurn(0, 180), closeTo(180, 1e-9));
      expect(shortestTurn(-90, 90), closeTo(180, 1e-9));
      expect(shortestTurn(720, 5), closeTo(5, 1e-9));
      expect(normDeg(-10), closeTo(350, 1e-9));
      expect(normDeg(370), closeTo(10, 1e-9));
    });
  });

  group('HeadingFilter', () {
    test('a moving car takes the phone heading', () {
      final f = HeadingFilter();
      expect(f.update(a, gpsHeading: 90, speed: 10), 90);
      expect(f.update(geoOffset(a, 100, 20), gpsHeading: 100, speed: 10), 100);
    });

    test('the first sample of an unknown car (no speed) takes its heading', () {
      expect(HeadingFilter().update(a, gpsHeading: 270), 270);
    });

    test('standing still: a phone heading (0 = no bearing, or noise) is ignored, the last heading is held', () {
      final f = HeadingFilter()..update(a, gpsHeading: 45, speed: 8);
      for (final h in [0.0, 200.0, 0.0, 310.0]) {
        expect(f.update(a, gpsHeading: h, speed: 0), 45);
      }
    });

    test('GPS jitter of a few metres in every direction holds the heading', () {
      final f = HeadingFilter()..update(a, gpsHeading: 45, speed: 8);
      for (final b in [0.0, 90.0, 180.0, 270.0, 135.0]) {
        expect(f.update(geoOffset(a, b, 4), speed: 1), 45);
      }
    });

    test('without a phone heading, movement of 8 m or more between real samples sets it', () {
      final f = HeadingFilter()..update(a, gpsHeading: 45, speed: 8);
      // 3 m at a time: jitter, held; the anchor stays, so the real movement adds up
      expect(f.update(geoOffset(a, 180, 3)), 45);
      expect(f.update(geoOffset(a, 180, 6)), 45);
      expect(f.update(geoOffset(a, 180, 9))!, closeTo(180, 0.5));
    });

    test('the road bearing is used for movement on a road, and as a first guess', () {
      final f = HeadingFilter();
      expect(f.update(a, speed: 0, roadBearing: 120), 120);
      expect(f.update(geoOffset(a, 115, 20), speed: 5, roadBearing: 118), 118);
    });

    test('nothing known: null', () {
      expect(HeadingFilter().update(a, speed: 0), isNull);
    });
  });

  group('HeadingEaser', () {
    final t0 = DateTime.utc(2026, 10, 28, 9);
    DateTime at(int ms) => t0.add(Duration(milliseconds: ms));

    test('turns 350° → 10° through north over the ease, then stops', () {
      final e = HeadingEaser()..snap(350);
      e.turnTo(10, t0);
      expect(e.busyAt(at(100)), isTrue);
      for (var ms = 0; ms <= 450; ms += 25) {
        final h = e.valueAt(at(ms))!;
        expect(shortestTurn(350, h), inInclusiveRange(-0.001, 20.001), reason: 'at $ms ms: $h');
      }
      expect(e.valueAt(at(450)), closeTo(10, 1e-9));
      expect(e.busyAt(at(460)), isFalse);
      expect(e.valueAt(at(5000)), closeTo(10, 1e-9));
    });

    test('the same target again does not restart the turn', () {
      final e = HeadingEaser()..snap(0);
      e.turnTo(90, t0);
      final mid = e.valueAt(at(200))!;
      e.turnTo(90, at(200));
      expect(e.valueAt(at(200)), closeTo(mid, 1e-9));
      expect(e.valueAt(at(450)), closeTo(90, 1e-9));
    });

    test('a new target mid-turn turns on from where it is drawn (no jump)', () {
      final e = HeadingEaser()..snap(0);
      e.turnTo(90, t0);
      final mid = e.valueAt(at(150))!;
      e.turnTo(180, at(150));
      expect(e.valueAt(at(150)), closeTo(mid, 1e-9));
      expect(e.valueAt(at(600)), closeTo(180, 1e-9));
    });

    test('a tiny change is applied at once, without easing', () {
      final e = HeadingEaser()..snap(100);
      e.turnTo(100.5, t0);
      expect(e.busyAt(t0), isFalse);
      expect(e.valueAt(t0), closeTo(100.5, 1e-9));
    });
  });
}
