// Comparing point lists (fits are redone only when what they show changes).

import 'package:latlong2/latlong.dart';

bool sameLatLngs(List<LatLng> a, List<LatLng> b, {double eps = 1e-4}) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if ((a[i].latitude - b[i].latitude).abs() > eps || (a[i].longitude - b[i].longitude).abs() > eps) return false;
  }
  return true;
}
