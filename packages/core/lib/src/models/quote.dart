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
    this.routePolyline6,
    this.etaToPickupSeconds,
    this.driversNearby = 0,
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
  /// the road line pickup → drop-off (encoded polyline, precision 6)
  final String? routePolyline6;
  /// how soon the nearest car of this type could reach the pickup (null: unknown or none)
  final int? etaToPickupSeconds;
  final int driversNearby;
  final FareBreakdown? breakdown;
  final DateTime expiresAt;

  factory Quote.fromJson(Json j) => Quote(
        id: str(j, 'id'), cityId: str(j, 'cityId'), vehicleType: str(j, 'vehicleType'),
        pickup: TripPlace.fromJson({...asJson(j['pickup']), 'address': j['pickupAddress']}),
        dropoff: TripPlace.fromJson({...asJson(j['dropoff']), 'address': j['dropoffAddress']}),
        fareMinor: readInt(j, 'fareMinor'), waitingPerMinMinor: readInt(j, 'waitingPerMinMinor'), currency: str(j, 'currency', 'ETB'),
        distanceMeters: readInt(j, 'distanceMeters'), durationSeconds: readInt(j, 'durationSeconds'), approximate: readBool(j, 'approximate'),
        routePolyline6: strOrNull(j, 'routePolyline6'),
        etaToPickupSeconds: intOrNull(j, 'etaToPickupSeconds'),
        driversNearby: readInt(j, 'driversNearby', 0),
        breakdown: j['breakdown'] is Map ? FareBreakdown.fromJson(asJson(j['breakdown'])) : null,
        expiresAt: readDate(j, 'expiresAt'),
      );

  bool isExpired(DateTime now) => !expiresAt.isAfter(now);
}

/// The road line the quotes of one estimate share.
@immutable
class QuoteRoute {
  const QuoteRoute({required this.polyline6, required this.distanceMeters, required this.durationSeconds, required this.approximate});
  final String polyline6;
  final int distanceMeters;
  final int durationSeconds;
  final bool approximate;
  factory QuoteRoute.fromJson(Json j) => QuoteRoute(
        polyline6: str(j, 'polyline6', ''), distanceMeters: readInt(j, 'distanceMeters'), durationSeconds: readInt(j, 'durationSeconds'), approximate: readBool(j, 'approximate'),
      );
}

/// POST /api/pricing/estimates
@immutable
class Estimates {
  const Estimates({required this.quotes, this.route});
  final List<Quote> quotes;
  final QuoteRoute? route;
  factory Estimates.fromJson(Json j) => Estimates(
        quotes: asJsonList(j['quotes']).map(Quote.fromJson).toList(growable: false),
        route: j['route'] is Map ? QuoteRoute.fromJson(asJson(j['route'])) : null,
      );
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
