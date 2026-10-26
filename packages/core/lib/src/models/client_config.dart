// platform-service GET /api/platform/client-config: what the app needs before anyone signs in
// (cities, vehicle types, feature flags, maintenance, minimum versions, announcements).

import 'package:meta/meta.dart';
import 'json.dart';

@immutable
class BBox {
  const BBox({required this.minLat, required this.minLng, required this.maxLat, required this.maxLng});
  final double minLat;
  final double minLng;
  final double maxLat;
  final double maxLng;
  factory BBox.fromJson(Json j) => BBox(minLat: readDouble(j, 'minLat'), minLng: readDouble(j, 'minLng'), maxLat: readDouble(j, 'maxLat'), maxLng: readDouble(j, 'maxLng'));
  bool contains(double lat, double lng) => lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
  double get centerLat => (minLat + maxLat) / 2;
  double get centerLng => (minLng + maxLng) / 2;
}

@immutable
class City {
  const City({required this.id, required this.name, required this.timezone, required this.bbox});
  final String id;
  final String name;
  final String timezone;
  final BBox bbox;
  factory City.fromJson(Json j) => City(id: str(j, 'id'), name: str(j, 'name'), timezone: str(j, 'timezone', 'Africa/Addis_Ababa'), bbox: BBox.fromJson(asJson(j['bbox'])));

  /// The built-in cities, used until client-config answers (libs/shared-location/src/cities.ts).
  static const builtIn = [
    City(id: 'addis-ababa', name: 'Addis Ababa', timezone: 'Africa/Addis_Ababa', bbox: BBox(minLat: 8.83, minLng: 38.63, maxLat: 9.1, maxLng: 38.92)),
    City(id: 'hawassa', name: 'Hawassa', timezone: 'Africa/Addis_Ababa', bbox: BBox(minLat: 6.98, minLng: 38.42, maxLat: 7.12, maxLng: 38.54)),
  ];
}

@immutable
class VehicleType {
  const VehicleType({required this.code, required this.name, required this.seatsMin, required this.seatsMax, required this.cities});
  final String code;
  final String name;
  final int seatsMin;
  final int seatsMax;
  /// empty = every city
  final List<String> cities;
  factory VehicleType.fromJson(Json j) => VehicleType(code: str(j, 'code'), name: str(j, 'name'), seatsMin: readInt(j, 'seatsMin'), seatsMax: readInt(j, 'seatsMax'), cities: strList(j, 'cities'));
  bool offeredIn(String cityId) => cities.isEmpty || cities.contains(cityId);

  static const builtIn = [
    VehicleType(code: 'economy', name: 'Economy', seatsMin: 1, seatsMax: 4, cities: []),
    VehicleType(code: 'comfort', name: 'Comfort', seatsMin: 1, seatsMax: 4, cities: []),
    VehicleType(code: 'minivan', name: 'Minivan', seatsMin: 1, seatsMax: 7, cities: []),
  ];
}

/// Every switch the app reads. Flags the backend doesn't send yet default to off, so a feature
/// module ships dark until platform-service exposes its flag.
enum Feature { phoneBooking, corporateBooking, tripPin, scheduledRides, sos, support, promos, accountDeletion }

@immutable
class Features {
  const Features(this._on);
  final Map<Feature, bool> _on;
  bool operator [](Feature f) => _on[f] ?? false;
  factory Features.fromJson(Json j) => Features({
        for (final f in Feature.values) f: readBool(j, f.name, f == Feature.phoneBooking || f == Feature.corporateBooking),
      });
  static const none = Features({});
}

@immutable
class Maintenance {
  const Maintenance({required this.newTripsPaused, required this.message});
  final bool newTripsPaused;
  final String message;
  factory Maintenance.fromJson(Json j) => Maintenance(newTripsPaused: readBool(j, 'newTripsPaused'), message: str(j, 'message'));
  static const off = Maintenance(newTripsPaused: false, message: '');
}

@immutable
class Announcement {
  const Announcement({required this.id, required this.title, required this.body, required this.severity, required this.audiences, required this.cities, this.startsAt, this.endsAt});
  final String id;
  final String title;
  final String body;
  /// info | warning
  final String severity;
  final List<String> audiences;
  final List<String> cities;
  final DateTime? startsAt;
  final DateTime? endsAt;
  factory Announcement.fromJson(Json j) => Announcement(
        id: str(j, 'id'), title: str(j, 'title'), body: str(j, 'body'), severity: str(j, 'severity', 'info'),
        audiences: strList(j, 'audiences'), cities: strList(j, 'cities'), startsAt: dateOrNull(j, 'startsAt'), endsAt: dateOrNull(j, 'endsAt'),
      );
}

@immutable
class ClientConfig {
  const ClientConfig({
    required this.version,
    required this.cities,
    required this.vehicleTypes,
    required this.features,
    required this.maintenance,
    required this.minAppVersions,
    required this.announcements,
  });

  final int version;
  final List<City> cities;
  final List<VehicleType> vehicleTypes;
  final Features features;
  final Maintenance maintenance;
  /// mode → platform → semver, e.g. minAppVersions['driver']['android']
  final Map<String, Map<String, String>> minAppVersions;
  final List<Announcement> announcements;

  factory ClientConfig.fromJson(Json j) => ClientConfig(
        version: readInt(j, 'version'),
        cities: asJsonList(j['cities']).map(City.fromJson).toList(growable: false),
        vehicleTypes: asJsonList(j['vehicleTypes']).map(VehicleType.fromJson).toList(growable: false),
        features: Features.fromJson(asJson(j['features'])),
        maintenance: Maintenance.fromJson(asJson(j['maintenance'])),
        minAppVersions: {
          for (final e in asJson(j['minAppVersions']).entries)
            e.key: {for (final p in asJson(e.value).entries) p.key: p.value is String ? p.value as String : '0.0.0'},
        },
        announcements: asJsonList(j['announcements']).map(Announcement.fromJson).toList(growable: false),
      );

  /// What the app runs on before the first successful fetch.
  static const fallback = ClientConfig(
    version: 0, cities: City.builtIn, vehicleTypes: VehicleType.builtIn, features: Features.none, maintenance: Maintenance.off, minAppVersions: {}, announcements: [],
  );

  City? city(String id) {
    for (final c in cities) {
      if (c.id == id) return c;
    }
    return null;
  }

  List<VehicleType> vehicleTypesIn(String cityId) => vehicleTypes.where((v) => v.offeredIn(cityId)).toList(growable: false);

  /// The served city containing a point, if any.
  City? cityAt(double lat, double lng) {
    for (final c in cities) {
      if (c.bbox.contains(lat, lng)) return c;
    }
    return null;
  }
}
