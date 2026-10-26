// Places: mapping-service search and reverse results, the common places list, and what the
// booking flow carries around.

import 'package:meta/meta.dart';
import 'json.dart';

@immutable
class Place {
  const Place({required this.name, this.label, required this.lat, required this.lng});
  /// short name shown first ("Bole International Airport")
  final String name;
  /// full address line
  final String? label;
  final double lat;
  final double lng;

  factory Place.fromJson(Json j) => Place(name: str(j, 'name'), label: strOrNull(j, 'label'), lat: readDouble(j, 'lat'), lng: readDouble(j, 'lng'));

  Json toJson() => {'name': name, 'label': ?label, 'lat': lat, 'lng': lng};

  Place copyWith({String? name, String? label}) => Place(name: name ?? this.name, label: label ?? this.label, lat: lat, lng: lng);

  @override
  bool operator ==(Object other) => other is Place && other.lat == lat && other.lng == lng && other.name == name;
  @override
  int get hashCode => Object.hash(lat, lng, name);
}

/// Well-known places per city, shown before the first keystroke and when search is down
/// (same list as apps/web/src/components/PlacePicker.tsx).
const Map<String, List<Place>> commonPlaces = {
  'addis-ababa': [
    Place(name: 'Bole International Airport', label: 'Departures, Bole', lat: 8.9779, lng: 38.7993),
    Place(name: 'Meskel Square', label: 'Kirkos', lat: 9.0107, lng: 38.7613),
    Place(name: 'Piassa', label: "St George's Cathedral, Arada", lat: 9.0362, lng: 38.7507),
    Place(name: 'Merkato', label: 'Addis Ketema', lat: 9.0309, lng: 38.738),
    Place(name: 'Arat Kilo', label: 'Arada', lat: 9.0333, lng: 38.7631),
    Place(name: 'Sidist Kilo', label: 'Addis Ababa University', lat: 9.0412, lng: 38.7614),
    Place(name: 'Edna Mall', label: 'Bole', lat: 8.9946, lng: 38.7891),
    Place(name: 'Mexico Square', label: 'Kirkos', lat: 9.0101, lng: 38.7451),
    Place(name: 'Megenagna', label: 'Yeka', lat: 9.0204, lng: 38.8015),
    Place(name: 'CMC', label: 'Yeka', lat: 9.0218, lng: 38.8436),
  ],
  'hawassa': [
    Place(name: 'Hawassa Lake Shore', label: 'Amora Gedel', lat: 7.0479, lng: 38.4626),
    Place(name: 'Hawassa University', label: 'Main campus', lat: 7.0548, lng: 38.4961),
    Place(name: 'Haile Resort', label: 'Lake side', lat: 7.0616, lng: 38.4537),
  ],
};
