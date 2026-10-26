// The socket `trip:offer` payload (services/trip-service/src/matching/matcher.ts). A driver has
// until `expiresAt` to accept it.

import 'package:meta/meta.dart';
import 'json.dart';
import 'trip.dart';

@immutable
class TripOffer {
  const TripOffer({
    required this.tripId,
    required this.offerId,
    required this.expiresAt,
    this.etaToPickupSeconds,
    required this.pickup,
    required this.dropoff,
    required this.vehicleType,
    required this.fareEstimateMinor,
    this.currency = 'ETB',
    required this.paymentMethod,
  });

  final String tripId;
  final String offerId;
  final DateTime expiresAt;
  final int? etaToPickupSeconds;
  final TripPlace pickup;
  final TripPlace dropoff;
  final String vehicleType;
  final int fareEstimateMinor;
  final String currency;
  final PaymentMethod paymentMethod;

  factory TripOffer.fromJson(Json j) {
    final fare = asJson(j['fare']);
    return TripOffer(
      tripId: str(j, 'tripId'), offerId: str(j, 'offerId'), expiresAt: readDate(j, 'expiresAt'),
      etaToPickupSeconds: intOrNull(j, 'etaToPickupSeconds'),
      pickup: TripPlace.fromJson(asJson(j['pickup'])), dropoff: TripPlace.fromJson(asJson(j['dropoff'])),
      vehicleType: str(j, 'vehicleType'), fareEstimateMinor: readInt(fare, 'estimateMinor'), currency: str(fare, 'currency', 'ETB'),
      paymentMethod: paymentMethodFromApi(strOrNull(j, 'paymentMethod')),
    );
  }

  Duration remaining(DateTime now) {
    final d = expiresAt.difference(now);
    return d.isNegative ? Duration.zero : d;
  }

  @override
  bool operator ==(Object other) => other is TripOffer && other.offerId == offerId;
  @override
  int get hashCode => offerId.hashCode;
}

/// GET /api/trips/:id/parties: who the other side is, as much as each side may see.
@immutable
class TripParties {
  const TripParties({this.driverName, this.riderName, this.vehicle, this.driverRating});
  final String? driverName;
  final String? riderName;
  final PartyVehicle? vehicle;
  final double? driverRating;

  factory TripParties.fromJson(Json j) {
    final driver = asJson(j['driver']);
    final rider = asJson(j['rider']);
    return TripParties(
      driverName: strOrNull(driver, 'name'), driverRating: doubleOrNull(driver, 'rating'),
      riderName: strOrNull(rider, 'name'),
      vehicle: j['vehicle'] is Map ? PartyVehicle.fromJson(asJson(j['vehicle'])) : null,
    );
  }
}

@immutable
class PartyVehicle {
  const PartyVehicle({required this.plateNumber, required this.make, required this.model, required this.color, required this.vehicleType});
  final String plateNumber;
  final String make;
  final String model;
  final String color;
  final String vehicleType;
  factory PartyVehicle.fromJson(Json j) => PartyVehicle(
        plateNumber: str(j, 'plateNumber'), make: str(j, 'make'), model: str(j, 'model'), color: str(j, 'color'), vehicleType: str(j, 'vehicleType'),
      );
  String get label => [color, make, model].where((s) => s.isNotEmpty).join(' ');
}
