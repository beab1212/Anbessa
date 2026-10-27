// trip-service scheduled rides (workflow 12, `trips/scheduled.ts`): a booking for later is not a
// trip. At `matchAt` (pickup − lead time) the scheduler creates a normal trip and matching starts;
// the booking then carries its `tripId`. Status changes are pushed as `scheduled:status`.

import 'package:meta/meta.dart';
import '../api/app_error.dart';
import 'json.dart';
import 'trip.dart';

enum ScheduledStatus { scheduled, dispatching, dispatched, cancelled, failed, unknown }

ScheduledStatus scheduledStatusFromApi(String? v) => enumFrom(ScheduledStatus.values, v, ScheduledStatus.unknown, apiName: (s) => s.name.toUpperCase());

/// GET/POST /api/trips/scheduled (`scheduledView`)
@immutable
class ScheduledTrip {
  const ScheduledTrip({
    required this.id,
    required this.status,
    required this.cityId,
    required this.vehicleType,
    required this.paymentMethod,
    required this.billingType,
    this.billingOrgId,
    required this.riderUserId,
    required this.bookedByUserId,
    this.purpose,
    required this.pickup,
    required this.dropoff,
    required this.fareEstimateMinor,
    this.currency = 'ETB',
    required this.estDistanceMeters,
    required this.estDurationSeconds,
    this.polyline,
    required this.scheduledFor,
    required this.matchAt,
    this.tripId,
    this.tripStatus,
    this.cancelledAt,
    this.failReason,
    required this.editable,
  });

  final String id;
  final ScheduledStatus status;
  final String cityId;
  final String vehicleType;
  final PaymentMethod paymentMethod;
  /// PERSONAL | CORPORATE
  final String billingType;
  final String? billingOrgId;
  final String riderUserId;
  final String bookedByUserId;
  final String? purpose;
  final TripPlace pickup;
  final TripPlace dropoff;
  /// the price booked; the ride is re-priced near dispatch and the rider pays the lower of the two
  final int fareEstimateMinor;
  final String currency;
  final int estDistanceMeters;
  final int estDurationSeconds;
  final String? polyline;
  final DateTime scheduledFor;
  /// when matching starts
  final DateTime matchAt;
  /// set once dispatched
  final String? tripId;
  final TripStatus? tripStatus;
  final DateTime? cancelledAt;
  /// RIDER_HAS_ACTIVE_TRIP | DISPATCH_FAILED
  final String? failReason;
  /// time, route and purpose can still change (SCHEDULED and before `matchAt`)
  final bool editable;

  /// trip-service cancels only before dispatch starts (POST …/cancel answers invalid_state after)
  bool get cancellable => status == ScheduledStatus.scheduled;
  bool get upcoming => status == ScheduledStatus.scheduled || status == ScheduledStatus.dispatching;

  factory ScheduledTrip.fromJson(Json j) {
    final billing = asJson(j['billing']);
    final fare = asJson(j['fare']);
    final route = asJson(j['route']);
    return ScheduledTrip(
      id: str(j, 'id'),
      status: scheduledStatusFromApi(strOrNull(j, 'status')),
      cityId: str(j, 'cityId'),
      vehicleType: str(j, 'vehicleType'),
      paymentMethod: paymentMethodFromApi(strOrNull(j, 'paymentMethod')),
      billingType: str(billing, 'type', 'PERSONAL'),
      billingOrgId: strOrNull(billing, 'orgId'),
      riderUserId: str(j, 'riderUserId'),
      bookedByUserId: str(j, 'bookedByUserId'),
      purpose: strOrNull(j, 'purpose'),
      pickup: TripPlace.fromJson(asJson(j['pickup'])),
      dropoff: TripPlace.fromJson(asJson(j['dropoff'])),
      fareEstimateMinor: readInt(fare, 'estimateMinor'),
      currency: str(fare, 'currency', 'ETB'),
      estDistanceMeters: readInt(route, 'estDistanceMeters'),
      estDurationSeconds: readInt(route, 'estDurationSeconds'),
      polyline: strOrNull(route, 'polyline'),
      scheduledFor: readDate(j, 'scheduledFor'),
      matchAt: readDate(j, 'matchAt'),
      tripId: strOrNull(j, 'tripId'),
      tripStatus: j['tripStatus'] is String ? tripStatusFromApi(strOrNull(j, 'tripStatus')) : null,
      cancelledAt: dateOrNull(j, 'cancelledAt'),
      failReason: strOrNull(j, 'failReason'),
      editable: readBool(j, 'editable'),
    );
  }
}

/// How far ahead a ride can be booked. trip-service doesn't publish its window (client-config has
/// only the `scheduledRides` flag), so these mirror its `DEFAULT_SCHEDULE` (30 min to 7 days);
/// the server still decides and answers `too_soon` / `too_far_ahead`.
@immutable
class ScheduleWindow {
  const ScheduleWindow({this.minAhead = const Duration(minutes: 30), this.maxAhead = const Duration(days: 7)});
  final Duration minAhead;
  final Duration maxAhead;

  static const tripService = ScheduleWindow();

  DateTime earliest(DateTime now) => now.toUtc().add(minAhead);
  DateTime latest(DateTime now) => now.toUtc().add(maxAhead);

  /// null when [at] can be booked at [now], else the error code the server would answer.
  String? check(DateTime at, DateTime now) {
    if (at.isBefore(earliest(now))) return ErrorCodes.tooSoon;
    if (at.isAfter(latest(now))) return ErrorCodes.tooFarAhead;
    return null;
  }

  /// A first suggestion: the next quarter hour at least [minAhead] + 15 min away, so the time is
  /// still bookable after a minute or two on the quote screen.
  DateTime suggested(DateTime now) {
    const quarter = 15 * 60 * 1000;
    final ms = earliest(now).add(const Duration(minutes: 15)).millisecondsSinceEpoch;
    return DateTime.fromMillisecondsSinceEpoch(((ms + quarter - 1) ~/ quarter) * quarter, isUtc: true);
  }
}
