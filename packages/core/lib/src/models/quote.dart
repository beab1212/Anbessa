// pricing-service: POST /api/pricing/estimates → quotes, GET /api/pricing/fares → fare cards.

import 'package:meta/meta.dart';
import 'json.dart';
import 'trip.dart';

@immutable
class FareBreakdown {
  const FareBreakdown({required this.baseMinor, required this.distanceMinor, required this.timeMinor, required this.minimumApplied});
  final int baseMinor;
  final int distanceMinor;
  final int timeMinor;
  final bool minimumApplied;
  factory FareBreakdown.fromJson(Json j) => FareBreakdown(
        baseMinor: readInt(j, 'baseMinor'), distanceMinor: readInt(j, 'distanceMinor'), timeMinor: readInt(j, 'timeMinor'), minimumApplied: readBool(j, 'minimumApplied'),
      );
}

@immutable
class Quote {
  const Quote({
    required this.id,
    required this.cityId,
    required this.vehicleType,
    required this.pickup,
    required this.dropoff,
    required this.fareMinor,
    required this.waitingPerMinMinor,
    this.currency = 'ETB',
    required this.distanceMeters,
    required this.durationSeconds,
    required this.approximate,
    this.breakdown,
    required this.expiresAt,
  });

  final String id;
  final String cityId;
  final String vehicleType;
  final TripPlace pickup;
  final TripPlace dropoff;
  final int fareMinor;
  final int waitingPerMinMinor;
  final String currency;
  final int distanceMeters;
  final int durationSeconds;
  /// routing was down: straight-line distance and time
  final bool approximate;
  final FareBreakdown? breakdown;
  final DateTime expiresAt;

  factory Quote.fromJson(Json j) => Quote(
        id: str(j, 'id'), cityId: str(j, 'cityId'), vehicleType: str(j, 'vehicleType'),
        pickup: TripPlace.fromJson({...asJson(j['pickup']), 'address': j['pickupAddress']}),
        dropoff: TripPlace.fromJson({...asJson(j['dropoff']), 'address': j['dropoffAddress']}),
        fareMinor: readInt(j, 'fareMinor'), waitingPerMinMinor: readInt(j, 'waitingPerMinMinor'), currency: str(j, 'currency', 'ETB'),
        distanceMeters: readInt(j, 'distanceMeters'), durationSeconds: readInt(j, 'durationSeconds'), approximate: readBool(j, 'approximate'),
        breakdown: j['breakdown'] is Map ? FareBreakdown.fromJson(asJson(j['breakdown'])) : null,
        expiresAt: readDate(j, 'expiresAt'),
      );

  bool isExpired(DateTime now) => !expiresAt.isAfter(now);
}

@immutable
class FareCard {
  const FareCard({required this.vehicleType, required this.baseMinor, required this.perKmMinor, required this.perMinMinor, required this.minFareMinor, required this.waitingPerMinMinor});
  final String vehicleType;
  final int baseMinor;
  final int perKmMinor;
  final int perMinMinor;
  final int minFareMinor;
  final int waitingPerMinMinor;
  factory FareCard.fromJson(Json j) => FareCard(
        vehicleType: str(j, 'vehicleType'), baseMinor: readInt(j, 'baseMinor'), perKmMinor: readInt(j, 'perKmMinor'),
        perMinMinor: readInt(j, 'perMinMinor'), minFareMinor: readInt(j, 'minFareMinor'), waitingPerMinMinor: readInt(j, 'waitingPerMinMinor'),
      );
}
