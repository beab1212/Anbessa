// Places: the category icon for a search result and how a distance is written.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ride_app_core/ride_app_core.dart';

void main() {
  test('placeIcon maps Nominatim classes to icons', () {
    expect(placeIcon('aeroway', 'aerodrome'), Icons.local_airport_rounded);
    expect(placeIcon('aeroway', 'gate'), Icons.local_airport_rounded);
    expect(placeIcon('amenity', 'place_of_worship'), Icons.church_rounded);
    expect(placeIcon('tourism', 'hotel'), Icons.hotel_rounded);
    expect(placeIcon('highway', 'bus_stop'), Icons.directions_bus_rounded);
    expect(placeIcon('amenity', 'hospital'), Icons.local_hospital_rounded);
    expect(placeIcon('amenity', 'clinic'), Icons.local_hospital_rounded);
    expect(placeIcon('amenity', 'school'), Icons.school_rounded);
    expect(placeIcon('amenity', 'university'), Icons.school_rounded);
    expect(placeIcon('shop', 'supermarket'), Icons.shopping_bag_rounded);
    expect(placeIcon('shop', 'mall'), Icons.shopping_bag_rounded);
    expect(placeIcon('amenity', 'restaurant'), Icons.restaurant_rounded);
    expect(placeIcon('amenity', 'cafe'), Icons.restaurant_rounded);
  });

  test('placeIcon falls back to a pin', () {
    expect(placeIcon(null, null), Icons.place_rounded);
    expect(placeIcon('', ''), Icons.place_rounded);
    expect(placeIcon('place', 'suburb'), Icons.place_rounded);
    expect(placeIcon('amenity', 'bench'), Icons.place_rounded);
    expect(placeIcon('AMENITY', 'Hospital'), Icons.local_hospital_rounded); // case does not matter
  });

  test('formatDistance: metres under a kilometre, one decimal up to 10 km', () {
    expect(formatDistance(12), '< 50 m');
    expect(formatDistance(853), '850 m');
    expect(formatDistance(994), '990 m');
    expect(formatDistance(995), '1.0 km');
    expect(formatDistance(2440), '2.4 km');
    expect(formatDistance(9949), '9.9 km');
    expect(formatDistance(14200), '14 km');
    expect(formatDistance(-1), '—');
  });

  test('Place keeps the search class; blanks become null; old JSON still reads', () {
    final p = Place.fromJson({'name': 'Bole International Airport', 'label': 'Bole, Addis Ababa', 'lat': 8.97, 'lng': 38.79, 'category': 'aeroway', 'type': 'aerodrome'});
    expect(p.category, 'aeroway');
    expect(p.type, 'aerodrome');
    expect(p.toJson()['category'], 'aeroway');
    expect(p.copyWith(name: 'BIA').type, 'aerodrome');
    final blank = Place.fromJson({'name': 'x', 'lat': 1, 'lng': 2, 'category': '', 'type': ' '});
    expect(blank.category, isNull);
    expect(blank.type, isNull);
    expect(Place.fromJson({'name': 'x', 'lat': 1, 'lng': 2}).toJson().containsKey('category'), isFalse);
  });
}
