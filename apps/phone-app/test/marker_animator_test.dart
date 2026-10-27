import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/features/maps/marker_animator.dart';
import 'package:ride_app_core/ride_app_core.dart';

void main() {
  var now = DateTime.utc(2026, 10, 27, 9);
  MarkerAnimator make() => MarkerAnimator(now: () => now);
  const a = (lat: 9.0107, lng: 38.7613);
  // ~111 m north
  const b = (lat: 9.0117, lng: 38.7613);

  setUp(() => now = DateTime.utc(2026, 10, 27, 9));

  test('the first sample shows at once', () {
    final m = make();
    m.push(a, heading: 90, at: now);
    expect(m.pose!.lat, a.lat);
    expect(m.pose!.heading, 90);
    expect(m.pose!.stale, isFalse);
  });

  test('glides to the next sample over the sample gap, heading the short way', () {
    final m = make();
    m.push(a, heading: 350, at: now);
    now = now.add(const Duration(seconds: 4));
    m.push(b, heading: 10, at: now);
    // half way through the 4 s gap
    m.advance(now.add(const Duration(seconds: 2)));
    expect(m.pose!.lat, closeTo((a.lat + b.lat) / 2, 1e-6));
    expect(m.pose!.heading, closeTo(0, 1e-6));
    m.advance(now.add(const Duration(seconds: 4)));
    expect(m.pose!.lat, closeTo(b.lat, 1e-9));
  });

  test('keeps rolling at the last speed when the next sample is late, then freezes', () {
    final m = make();
    m.push(a, heading: 0, speed: 10, at: now);
    now = now.add(const Duration(seconds: 4));
    m.push(b, heading: 0, speed: 10, at: now);
    m.advance(now.add(const Duration(seconds: 4))); // glide done
    final atEnd = m.pose!.lat;
    m.advance(now.add(const Duration(seconds: 6))); // 2 s of dead reckoning at 10 m/s ≈ 20 m north
    expect(geoDistanceMeters((lat: atEnd, lng: b.lng), m.pose!.point), closeTo(20, 1));
    m.advance(now.add(const Duration(seconds: 30))); // past the dead-reckoning window: frozen
    final frozen = m.pose!.point;
    m.advance(now.add(const Duration(seconds: 40)));
    expect(m.pose!.point, frozen);
    now = now.add(const Duration(seconds: 40));
    expect(m.pose!.stale, isTrue);
  });

  test('a big jump snaps instead of gliding', () {
    final m = make();
    m.push(a, at: now);
    now = now.add(const Duration(seconds: 4));
    m.push((lat: 9.1, lng: 38.9), at: now); // ~17 km away
    expect(m.pose!.lat, 9.1);
  });
}
