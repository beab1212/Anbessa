// Mirrors libs/shared-types/src/trip.ts (the trip-service API shape). Keep the two in sync
// in the same PR, or generate this from an OpenAPI/JSON schema once the project justifies codegen.

enum TripStatus { requested, matched, enRoute, inProgress, completed, cancelled }

TripStatus tripStatusFromApi(String value) => switch (value) {
      'requested' => TripStatus.requested,
      'matched' => TripStatus.matched,
      'en_route' => TripStatus.enRoute,
      'in_progress' => TripStatus.inProgress,
      'completed' => TripStatus.completed,
      'cancelled' => TripStatus.cancelled,
      _ => throw FormatException('unknown trip status: $value'),
    };

class TripPlace {
  const TripPlace({required this.lat, required this.lng, this.address});
  final double lat;
  final double lng;
  final String? address;

  factory TripPlace.fromJson(Map<String, dynamic> json) => TripPlace(
        lat: (json['lat'] as num).toDouble(),
        lng: (json['lng'] as num).toDouble(),
        address: json['address'] as String?,
      );
}

class Trip {
  const Trip({
    required this.id,
    required this.status,
    required this.pickup,
    required this.dropoff,
    required this.vehicleType,
    required this.paymentMethod,
    required this.fareEstimateMinor,
    this.fareFinalMinor,
    this.driverUserId,
    this.pin,
  });

  final String id;
  final TripStatus status;
  final TripPlace pickup;
  final TripPlace dropoff;
  final String vehicleType;
  final String paymentMethod;

  /// minor units (santim): 100 = 1 ETB
  final int fareEstimateMinor;
  final int? fareFinalMinor;
  final String? driverUserId;

  /// only sent to the rider; the driver asks for it at pickup
  final String? pin;

  factory Trip.fromJson(Map<String, dynamic> json) {
    final fare = json['fare'] as Map<String, dynamic>;
    final driver = json['driver'] as Map<String, dynamic>?;
    return Trip(
      id: json['id'] as String,
      status: tripStatusFromApi(json['status'] as String),
      pickup: TripPlace.fromJson(json['pickup'] as Map<String, dynamic>),
      dropoff: TripPlace.fromJson(json['dropoff'] as Map<String, dynamic>),
      vehicleType: json['vehicleType'] as String,
      paymentMethod: json['paymentMethod'] as String,
      fareEstimateMinor: (fare['estimateMinor'] as num).toInt(),
      fareFinalMinor: (fare['finalMinor'] as num?)?.toInt(),
      driverUserId: driver?['userId'] as String?,
      pin: json['pin'] as String?,
    );
  }
}
