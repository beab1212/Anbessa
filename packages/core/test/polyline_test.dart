import 'package:flutter_test/flutter_test.dart';
import 'package:ride_app_core/ride_app_core.dart';

void main() {
  // OSRM polyline6 for three points around Meskel Square (encoded by encodePolyline6 and
  // checked against the Google algorithm by hand for the first delta).
  const meskel = (lat: 9.0107, lng: 38.7613);
  const bole = (lat: 8.9965, lng: 38.7872);
  const piassa = (lat: 9.0333, lng: 38.75);

  test('encode then decode round-trips at 6 decimals', () {
    final enc = encodePolyline6([meskel, bole, piassa]);
    final dec = decodePolyline6(enc);
    expect(dec, hasLength(3));
    for (final (i, p) in [meskel, bole, piassa].indexed) {
      expect(dec[i].lat, closeTo(p.lat, 1e-6));
      expect(dec[i].lng, closeTo(p.lng, 1e-6));
    }
  });

  test('decodes a known Google polyline (precision 5)', () {
    // the example from Google's encoding reference
    final dec = decodePolyline5('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(dec[0].lat, closeTo(38.5, 1e-5));
    expect(dec[0].lng, closeTo(-120.2, 1e-5));
    expect(dec[2].lat, closeTo(43.252, 1e-5));
    expect(dec[2].lng, closeTo(-126.453, 1e-5));
  });

  test('distances and bearings are sane for Addis', () {
    expect(geoDistanceMeters(meskel, bole), closeTo(3250, 150));
    expect(geoBearing(meskel, (lat: 9.1, lng: 38.7613)), closeTo(0, 0.5));
    expect(geoBearing(meskel, (lat: 9.0107, lng: 38.9)), closeTo(90, 0.5));
    final off = geoOffset(meskel, 90, 1000);
    expect(geoDistanceMeters(meskel, off), closeTo(1000, 1));
  });

  test('lerpAngleDeg takes the short way round', () {
    expect(lerpAngleDeg(350, 10, 0.5), closeTo(0, 1e-9));
    expect(lerpAngleDeg(10, 350, 0.5), closeTo(0, 1e-9));
    expect(lerpAngleDeg(0, 180, 0.25), closeTo(45, 1e-9));
    expect(lerpAngleDeg(90, 90, 0.7), 90);
  });

  test('projection finds the segment, the offset and the distance along', () {
    final route = [meskel, (lat: 9.0107, lng: 38.78), (lat: 9.0, lng: 38.78)];
    final cum = cumulativeMeters(route);
    expect(cum.first, 0);
    expect(cum.last, closeTo(totalMeters(route), 1e-9));
    // a point just north of the middle of the first (east-west) segment
    final p = (lat: 9.0112, lng: 38.7706);
    final pr = projectOntoPolyline(route, p, cumulative: cum);
    expect(pr.segment, 0);
    expect(pr.t, closeTo(0.5, 0.02));
    expect(pr.offMeters, closeTo(55, 10));
    expect(pr.alongMeters, closeTo(cum[1] / 2, 30));
    // the remainder starts at the projected point and keeps the vertices after it
    final rest = sliceFrom(route, pr);
    expect(rest.length, 3);
    expect(rest.first.lng, closeTo(38.7706, 1e-4));
    expect(sliceTo(route, pr).length, 2);
  });

  test('pointAlong walks the route by metres', () {
    final route = [meskel, (lat: 9.0107, lng: 38.78)];
    final total = totalMeters(route);
    final mid = pointAlong(route, total / 2);
    expect(mid.lat, closeTo(9.0107, 1e-6));
    expect(mid.lng, closeTo((38.7613 + 38.78) / 2, 1e-4));
    expect(pointAlong(route, -5), route.first);
    expect(pointAlong(route, total * 2), route.last);
  });
}
