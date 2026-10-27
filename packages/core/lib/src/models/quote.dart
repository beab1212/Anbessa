// pricing-service: POST /api/pricing/estimates → quotes (with a promo code's discount and its
// outcome), GET /api/pricing/fares → fare cards.

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
    this.discountMinor = 0,
    int? payableMinor,
    this.promo,
  }) : payableMinor = payableMinor ?? fareMinor - discountMinor;

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
  /// the promo discount on this quote (0 = none); the driver still earns on [fareMinor]
  final int discountMinor;
  /// what the rider pays: [fareMinor] − [discountMinor] (waiting time comes on top)
  final int payableMinor;
  final QuotePromo? promo;

  bool get discounted => discountMinor > 0;

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
        discountMinor: readInt(j, 'discountMinor', 0),
        payableMinor: intOrNull(j, 'payableMinor'),
        promo: j['promo'] is Map ? QuotePromo.fromJson(asJson(j['promo'])) : null,
      );

  bool isExpired(DateTime now) => !expiresAt.isAfter(now);
}

/// The promo applied to one quote.
@immutable
class QuotePromo {
  const QuotePromo({required this.promoId, required this.code, required this.discountMinor, required this.fundedBy});
  final String promoId;
  final String code;
  final int discountMinor;
  final String fundedBy;
  factory QuotePromo.fromJson(Json j) => QuotePromo(promoId: str(j, 'promoId'), code: str(j, 'code'), discountMinor: readInt(j, 'discountMinor'), fundedBy: str(j, 'fundedBy'));
}

/// Why pricing-service didn't apply a code (`promos/discount.ts` PromoRejection), plus
/// [invalidFormat], which the app decides before sending (the API would refuse the whole estimate).
abstract final class PromoRejection {
  static const unknownCode = 'unknown_code';
  static const notActive = 'not_active';
  static const notStarted = 'not_started';
  static const expired = 'expired';
  static const exhausted = 'exhausted';
  static const notInCity = 'not_in_city';
  static const vehicleTypeNotEligible = 'vehicle_type_not_eligible';
  static const limitReached = 'limit_reached';
  static const invalidFormat = 'invalid_format';
}

/// A promo code as pricing-service accepts it (`admin-routes.ts` promoCode): 3–32 letters,
/// digits, `_` or `-`, surrounding spaces trimmed.
bool isValidPromoCode(String code) => RegExp(r'^[A-Za-z0-9_-]{3,32}$').hasMatch(code.trim());

/// What happened to the promo code sent with an estimate. A code that can't be used never fails
/// the estimate: it comes back here with a [reason].
@immutable
class PromoOutcome {
  const PromoOutcome({required this.code, required this.applied, this.discountedQuotes = 0, this.reason, this.message});
  final String code;
  final bool applied;
  final int discountedQuotes;
  /// a [PromoRejection] value when not applied
  final String? reason;
  /// the server's English sentence for [reason]
  final String? message;
  factory PromoOutcome.fromJson(Json j) => PromoOutcome(
        code: str(j, 'code'), applied: readBool(j, 'applied'), discountedQuotes: readInt(j, 'discountedQuotes', 0), reason: strOrNull(j, 'reason'), message: strOrNull(j, 'message'),
      );
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
  const Estimates({required this.quotes, this.route, this.promo});
  final List<Quote> quotes;
  final QuoteRoute? route;
  /// present when the request carried a `promoCode`
  final PromoOutcome? promo;
  factory Estimates.fromJson(Json j) => Estimates(
        quotes: asJsonList(j['quotes']).map(Quote.fromJson).toList(growable: false),
        route: j['route'] is Map ? QuoteRoute.fromJson(asJson(j['route'])) : null,
        promo: j['promo'] is Map ? PromoOutcome.fromJson(asJson(j['promo'])) : null,
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
