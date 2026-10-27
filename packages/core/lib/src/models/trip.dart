// Mirrors libs/shared-types/src/trip.ts (trip-service's API shape: GET /api/trips/:id, socket
// trip:status). Change both in the same PR; packages/core/test/fixtures/trip.json is a real
// response and models_test.dart parses it.

import 'package:meta/meta.dart';
import 'json.dart';

enum TripStatus { requested, matched, enRoute, inProgress, completed, cancelled, unknown }

/// The API's snake_case name of a status.
String tripStatusToApi(TripStatus s) => snakeOf(s.name);

TripStatus tripStatusFromApi(String? value) => enumFrom(TripStatus.values, value, TripStatus.unknown, apiName: tripStatusToApi);

enum PaymentMethod { cash, mobileMoney, card, corporate, unknown }

String paymentMethodToApi(PaymentMethod m) => snakeOf(m.name).toUpperCase();

PaymentMethod paymentMethodFromApi(String? v) => enumFrom(PaymentMethod.values, v, PaymentMethod.unknown, apiName: paymentMethodToApi);

/// Why a trip may be cancelled (trip-service's CANCEL_REASONS). NO_SHOW is the driver's only.
enum CancelReason { changedPlans, driverTooFar, driverAskedToCancel, wrongPickup, noShow, safety, other }

String cancelReasonToApi(CancelReason r) => snakeOf(r.name).toUpperCase();

enum CancelledBy { rider, driver, system, staff, unknown }

@immutable
class TripPlace {
  const TripPlace({required this.lat, required this.lng, this.address});
  final double lat;
  final double lng;
  final String? address;

  factory TripPlace.fromJson(Json j) => TripPlace(lat: readDouble(j, 'lat'), lng: readDouble(j, 'lng'), address: strOrNull(j, 'address'));

  Json toJson() => {'lat': lat, 'lng': lng, 'address': ?address};

  @override
  bool operator ==(Object other) => other is TripPlace && other.lat == lat && other.lng == lng && other.address == address;
  @override
  int get hashCode => Object.hash(lat, lng, address);
}

@immutable
class TripDriver {
  const TripDriver({required this.userId, this.vehicleId});
  final String userId;
  final String? vehicleId;
  factory TripDriver.fromJson(Json j) => TripDriver(userId: str(j, 'userId'), vehicleId: strOrNull(j, 'vehicleId'));
}

@immutable
class TripFare {
  const TripFare({required this.estimateMinor, this.finalMinor, this.waitingFeeMinor, this.currency = 'ETB', this.promoDiscountMinor = 0, this.promoCode, int? payableMinor}) : _payableMinor = payableMinor; // ignore: prefer_initializing_formals
  /// minor units (santim)
  final int estimateMinor;
  final int? finalMinor;
  final int? waitingFeeMinor;
  final String currency;
  /// the promo discount booked with the quote (0 = none); the driver earns on the full fare
  final int promoDiscountMinor;
  final String? promoCode;
  final int? _payableMinor;
  factory TripFare.fromJson(Json j) => TripFare(
        estimateMinor: readInt(j, 'estimateMinor'), finalMinor: intOrNull(j, 'finalMinor'),
        waitingFeeMinor: intOrNull(j, 'waitingFeeMinor'), currency: str(j, 'currency', 'ETB'),
        promoDiscountMinor: readInt(j, 'promoDiscountMinor', 0), promoCode: strOrNull(j, 'promoCode'), payableMinor: intOrNull(j, 'payableMinor'),
      );
  /// The fare: the final one once known, else the estimate (what the driver's earning is based on).
  int get chargedMinor => finalMinor ?? estimateMinor;
  /// What the rider pays: the fare minus the promo discount (the server's `payableMinor`).
  int get payableMinor => _payableMinor ?? (chargedMinor - promoDiscountMinor).clamp(0, chargedMinor);
}

@immutable
class TripRoute {
  const TripRoute({required this.estDistanceMeters, required this.estDurationSeconds, this.distanceMeters, this.durationSeconds, this.polyline});
  final int estDistanceMeters;
  final int estDurationSeconds;
  final int? distanceMeters;
  final int? durationSeconds;
  /// the road line pickup → drop-off (encoded polyline, precision 6); null for older trips
  final String? polyline;
  factory TripRoute.fromJson(Json j) => TripRoute(
        estDistanceMeters: readInt(j, 'estDistanceMeters'), estDurationSeconds: readInt(j, 'estDurationSeconds'),
        distanceMeters: intOrNull(j, 'distanceMeters'), durationSeconds: intOrNull(j, 'durationSeconds'),
        polyline: strOrNull(j, 'polyline'),
      );
}

@immutable
class TripTimes {
  const TripTimes({required this.requestedAt, this.matchedAt, this.arrivedAt, this.startedAt, this.completedAt, this.cancelledAt});
  final DateTime requestedAt;
  final DateTime? matchedAt;
  final DateTime? arrivedAt;
  final DateTime? startedAt;
  final DateTime? completedAt;
  final DateTime? cancelledAt;
  factory TripTimes.fromJson(Json j) => TripTimes(
        requestedAt: readDate(j, 'requestedAt'), matchedAt: dateOrNull(j, 'matchedAt'), arrivedAt: dateOrNull(j, 'arrivedAt'),
        startedAt: dateOrNull(j, 'startedAt'), completedAt: dateOrNull(j, 'completedAt'), cancelledAt: dateOrNull(j, 'cancelledAt'),
      );
}

@immutable
class TripCancellation {
  const TripCancellation({required this.by, required this.reason, required this.feeMinor, required this.driverCompensationMinor});
  final CancelledBy by;
  final String reason;
  final int feeMinor;
  final int driverCompensationMinor;
  factory TripCancellation.fromJson(Json j) => TripCancellation(
        by: enumFrom(CancelledBy.values, str(j, 'by').toLowerCase(), CancelledBy.unknown),
        reason: str(j, 'reason'), feeMinor: readInt(j, 'feeMinor'), driverCompensationMinor: readInt(j, 'driverCompensationMinor'),
      );
}

@immutable
class Trip {
  const Trip({
    required this.id,
    required this.status,
    required this.cityId,
    required this.channel,
    required this.vehicleType,
    required this.paymentMethod,
    required this.billingType,
    this.billingOrgId,
    required this.riderUserId,
    required this.pickup,
    required this.dropoff,
    this.driver,
    required this.fare,
    required this.route,
    required this.times,
    this.cancellation,
    this.pin,
    this.purpose,
  });

  final String id;
  final TripStatus status;
  final String cityId;
  final String channel;
  final String vehicleType;
  final PaymentMethod paymentMethod;
  /// PERSONAL | CORPORATE
  final String billingType;
  final String? billingOrgId;
  final String riderUserId;
  final TripPlace pickup;
  final TripPlace dropoff;
  final TripDriver? driver;
  final TripFare fare;
  final TripRoute route;
  final TripTimes times;
  final TripCancellation? cancellation;
  /// only sent to the rider: the driver asks for it at pickup
  final String? pin;
  /// the trip purpose or cost centre of a company ride (never sent to the driver)
  final String? purpose;

  factory Trip.fromJson(Json j) {
    final billing = asJson(j['billing']);
    return Trip(
      id: str(j, 'id'),
      status: tripStatusFromApi(strOrNull(j, 'status')),
      cityId: str(j, 'cityId'),
      channel: str(j, 'channel', 'APP'),
      vehicleType: str(j, 'vehicleType'),
      paymentMethod: paymentMethodFromApi(strOrNull(j, 'paymentMethod')),
      billingType: str(billing, 'type', 'PERSONAL'),
      billingOrgId: strOrNull(billing, 'orgId'),
      riderUserId: str(j, 'riderUserId'),
      pickup: TripPlace.fromJson(asJson(j['pickup'])),
      dropoff: TripPlace.fromJson(asJson(j['dropoff'])),
      driver: j['driver'] is Map ? TripDriver.fromJson(asJson(j['driver'])) : null,
      fare: TripFare.fromJson(asJson(j['fare'])),
      route: TripRoute.fromJson(asJson(j['route'])),
      times: TripTimes.fromJson(asJson(j['times'])),
      cancellation: j['cancellation'] is Map ? TripCancellation.fromJson(asJson(j['cancellation'])) : null,
      pin: strOrNull(j, 'pin'),
      purpose: strOrNull(j, 'purpose'),
    );
  }

  bool get isActive => switch (status) {
        TripStatus.requested || TripStatus.matched || TripStatus.enRoute || TripStatus.inProgress => true,
        _ => false,
      };
  bool get isDigital => paymentMethod == PaymentMethod.mobileMoney || paymentMethod == PaymentMethod.card;
  bool get hasArrived => times.arrivedAt != null;

  @override
  bool operator ==(Object other) =>
      other is Trip && other.id == id && other.status == status && other.times.arrivedAt == times.arrivedAt && other.driver?.userId == driver?.userId && other.fare.finalMinor == fare.finalMinor;
  @override
  int get hashCode => Object.hash(id, status, times.arrivedAt, driver?.userId, fare.finalMinor);
}

/// POST /api/trips/:id/share — a link anyone can open to follow the trip.
@immutable
class TripShare {
  const TripShare({required this.token, required this.url, required this.expiresAt});
  final String token;
  final String url;
  final DateTime expiresAt;
  factory TripShare.fromJson(Json j) => TripShare(token: str(j, 'token'), url: str(j, 'url'), expiresAt: readDate(j, 'expiresAt'));
}
