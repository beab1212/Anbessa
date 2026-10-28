import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/features/maps/heading_filter.dart';
import 'package:phone_app/features/maps/marker_animator.dart';
import 'package:phone_app/features/maps/scene/route_track.dart';
import 'package:ride_app_core/ride_app_core.dart';

void main() {
  var now = DateTime.utc(2026, 10, 27, 9);
  MarkerAnimator make() => MarkerAnimator(now: () => now);
  const a = (lat: 9.0107, lng: 38.7613);
  // ~111 m north
  const b = (lat: 9.0117, lng: 38.7613);

  setUp(() => now = DateTime.utc(2026, 10, 27, 9));

  group('without a route', () {
    test('the first sample shows at once', () {
      final m = make();
      m.push(a, heading: 90, at: now);
      expect(m.pose!.lat, a.lat);
      expect(m.pose!.heading, 90);
      expect(m.pose!.stale, isFalse);
      expect(m.value, m.pose);
    });

    test('glides to the next sample over the sample gap, heading the short way', () {
      final m = make();
      m.push(a, heading: 350, at: now);
      now = now.add(const Duration(seconds: 4));
      m.push(b, heading: 10, at: now);
      // the turn is a short ease, the short way round (through north, never through south)
      m.advance(now.add(const Duration(milliseconds: 150)));
      final mid = m.pose!.heading;
      expect(shortestTurn(350, mid), inExclusiveRange(0, 20));
      // half way through the 4 s gap: the position glides on, the turn is long done
      m.advance(now.add(const Duration(seconds: 2)));
      expect(m.pose!.lat, closeTo((a.lat + b.lat) / 2, 1e-6));
      expect(m.pose!.heading, closeTo(10, 1e-6));
      m.advance(now.add(const Duration(seconds: 4)));
      expect(m.pose!.lat, closeTo(b.lat, 1e-9));
    });

    test('stops at the last sample (no dead reckoning off a known road), then goes stale', () {
      final m = make();
      m.push(a, heading: 0, speed: 10, at: now);
      now = now.add(const Duration(seconds: 4));
      m.push(b, heading: 0, speed: 10, at: now);
      m.advance(now.add(const Duration(seconds: 4))); // glide done
      m.advance(now.add(const Duration(seconds: 6)));
      expect(m.pose!.lat, closeTo(b.lat, 1e-9));
      expect(m.isAnimating, isFalse);
      expect(m.pose!.speed, 0);
      now = now.add(const Duration(seconds: 40));
      m.advance(now);
      expect(m.pose!.stale, isTrue);
    });

    test('a big jump snaps instead of gliding', () {
      final m = make();
      m.push(a, at: now);
      now = now.add(const Duration(seconds: 4));
      m.push((lat: 9.1, lng: 38.9), at: now); // ~17 km away
      expect(m.pose!.lat, 9.1);
    });

    test('a parked car keeps its heading through GPS jitter', () {
      final m = make();
      m.push(a, heading: 90, speed: 12, at: now);
      // standing still: fixes wander a few metres in every direction, no heading from the phone
      final jitter = [(lat: a.lat + 0.00003, lng: a.lng), (lat: a.lat, lng: a.lng - 0.00003), (lat: a.lat - 0.00002, lng: a.lng + 0.00002), (lat: a.lat + 0.00001, lng: a.lng + 0.00003)];
      for (final j in jitter) {
        now = now.add(const Duration(seconds: 4));
        m.push(j, at: now); // speed is measured from the jitter: < 1.5 m/s
        m.advance(now.add(const Duration(seconds: 2)));
        expect(m.pose!.heading, closeTo(90, 1e-6));
        m.advance(now.add(const Duration(seconds: 4)));
        expect(m.pose!.heading, closeTo(90, 1e-6));
      }
    });

    test('a parked phone that reports heading 0 (no bearing) does not point the car north', () {
      final m = make();
      m.push(a, heading: 120, speed: 10, at: now);
      for (var i = 0; i < 5; i++) {
        now = now.add(const Duration(seconds: 2));
        m.push(a, heading: i.isEven ? 0 : 250, speed: 0, at: now); // Android: no bearing → 0, or noise
        m.advance(now.add(const Duration(milliseconds: 300)));
        expect(m.pose!.heading, closeTo(120, 1e-6));
      }
    });

    test('the heading does not change between samples on its own (no continuous spin)', () {
      final m = make();
      m.push(a, heading: 30, speed: 10, at: now);
      now = now.add(const Duration(seconds: 4));
      m.push(b, heading: 40, speed: 10, at: now);
      final seen = <double>{};
      for (var ms = 500; ms <= 4000; ms += 100) {
        m.advance(now.add(Duration(milliseconds: ms)));
        seen.add(m.pose!.heading);
      }
      expect(seen, {40});
    });

    test('a moving car without a phone heading turns the way it moves', () {
      final m = make();
      m.push(a, heading: 90, at: now);
      now = now.add(const Duration(seconds: 4));
      m.push(b, at: now); // 111 m north in 4 s
      m.advance(now.add(const Duration(seconds: 4)));
      expect(m.pose!.heading, closeTo(0, 0.5));
    });
  });

  group('along a route', () {
    // an L: 200 m north, then 200 m east
    final corner = (lat: 9.0107 + 200 / 111320, lng: 38.7613);
    final end = geoOffset(corner, 90, 200);
    final route = [a, corner, end];
    final track = RouteTrack(route);

    MarkerAnimator onRoute() {
      final m = make()..route = route;
      m.push(a, speed: 10, at: now);
      return m;
    }

    test('follows the road round a corner instead of cutting it', () {
      final m = onRoute();
      // 150 m up the first leg, then 150 m along the second
      now = now.add(const Duration(seconds: 4));
      m.push(track.pointAt(150), speed: 10, at: now);
      m.advance(now.add(const Duration(seconds: 4)));
      now = now.add(const Duration(seconds: 4));
      final after = track.pointAt(350);
      m.push(after, speed: 10, at: now);
      // half way through the glide: on the road, 250 m along (50 m past the corner), heading east
      // (frame by frame: the turn at the corner is a short ease)
      for (var ms = 0; ms <= 2000; ms += 50) {
        m.advance(now.add(Duration(milliseconds: ms)));
      }
      final p = m.pose!.point;
      expect(track.project(p).offMeters, lessThan(0.5));
      expect(m.progressMeters, closeTo(350, 1));
      expect(geoDistanceMeters(p, track.pointAt(250)), lessThan(1));
      expect(m.pose!.heading, closeTo(90, 2));
      // a straight line from 150 m to 350 m would pass ~25 m off the road
      final straight = geoLerp(track.pointAt(150), after, 0.5);
      expect(track.project(straight).offMeters, greaterThan(20));
    });

    test('progress is monotonic: a fix a little behind (GPS jitter) does not move the car back', () {
      final m = onRoute();
      now = now.add(const Duration(seconds: 4));
      m.push(track.pointAt(120), speed: 10, at: now);
      m.advance(now.add(const Duration(seconds: 4)));
      final before = m.pose!.point;
      now = now.add(const Duration(seconds: 4));
      // 10 m behind and 5 m to the side
      m.push(geoOffset(track.pointAt(110), 90, 5), speed: 1, at: now);
      expect(m.progressMeters, closeTo(120, 0.5));
      m.advance(now.add(const Duration(seconds: 2)));
      expect(geoDistanceMeters(m.pose!.point, before), lessThan(0.5));
      // and the heading stays the road's (north), not the bearing of the jitter
      expect(m.pose!.heading, closeTo(0, 2));
    });

    test('a fix near a crossing street stays on its own road', () {
      final m = onRoute();
      now = now.add(const Duration(seconds: 4));
      m.push(track.pointAt(180), speed: 10, at: now);
      m.advance(now.add(const Duration(seconds: 4)));
      now = now.add(const Duration(seconds: 2));
      // 15 m west of the first leg, still before the corner
      m.push(geoOffset(track.pointAt(195), 270, 15), speed: 10, at: now);
      expect(m.progressMeters, closeTo(195, 2));
    });

    test('rolls on along the road when the next fix is late, for at most 6 s', () {
      final m = onRoute();
      now = now.add(const Duration(seconds: 4));
      m.push(track.pointAt(160), speed: 10, at: now);
      m.advance(now.add(const Duration(seconds: 4))); // at 160 m
      m.advance(now.add(const Duration(seconds: 7))); // 3 s of rolling at 10 m/s → 190 m
      expect(geoDistanceMeters(m.pose!.point, track.pointAt(190)), lessThan(1));
      expect(m.isAnimating, isTrue);
      for (var ms = 7000; ms <= 9000; ms += 50) {
        m.advance(now.add(Duration(milliseconds: ms))); // 5 s → 210 m, round the corner
      }
      expect(track.project(m.pose!.point).offMeters, lessThan(0.5));
      expect(m.pose!.heading, closeTo(90, 2));
      m.advance(now.add(const Duration(seconds: 20))); // past the 6 s window: stopped at ≤ 220 m
      final stopped = m.pose!.point;
      expect(track.project(stopped).alongMeters, lessThanOrEqualTo(221));
      now = now.add(const Duration(seconds: 25));
      m.advance(now);
      expect(m.pose!.point, stopped);
      expect(m.isAnimating, isFalse);
    });

    test('a jump of more than 300 m snaps', () {
      final m = onRoute();
      now = now.add(const Duration(seconds: 4));
      m.push(end, speed: 10, at: now); // 400 m along the road, ~283 m straight: glides
      expect(m.pose!.point, a);
      final far = geoOffset(end, 90, 600);
      now = now.add(const Duration(seconds: 4));
      m.push(far, speed: 10, at: now); // off the route and far: snaps
      expect(geoDistanceMeters(m.pose!.point, far), lessThan(0.5));
    });

    test('a fix far off the road is drawn where it is', () {
      final m = onRoute();
      now = now.add(const Duration(seconds: 4));
      final off = geoOffset(track.pointAt(100), 270, 120);
      m.push(off, speed: 10, at: now);
      expect(m.progressMeters, isNull);
      m.advance(now.add(const Duration(seconds: 4)));
      expect(geoDistanceMeters(m.pose!.point, off), lessThan(0.5));
    });
  });
}
