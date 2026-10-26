// Socket.io events from realtime-gateway, parsed into one sealed type so features switch on
// classes, not strings. Producers: trip-service (trip:*), payment-service (payment:*, balance:*),
// the gateway itself (driver:location).

import 'package:meta/meta.dart';
import '../models/balance.dart';
import '../models/json.dart';
import '../models/payment.dart';
import '../models/trip.dart';
import '../models/trip_offer.dart';

/// Every event name the hub registers with the socket.
const realtimeEventNames = [
  'trip:status',
  'trip:offer',
  'trip:offer_expired',
  'trip:offer_cancelled',
  'driver:location',
  'payment:action_required',
  'payment:captured',
  'payment:failed',
  'balance:topped_up',
];

@immutable
sealed class RealtimeEvent {
  const RealtimeEvent();

  /// Parse a socket event; null when the name is unknown or the payload is malformed.
  static RealtimeEvent? fromSocket(String name, Object? payload) {
    final j = asJson(payload);
    try {
      return switch (name) {
        'trip:status' => TripStatusEvent(tripId: str(j, 'tripId'), status: tripStatusFromApi(strOrNull(j, 'status')), trip: Trip.fromJson(asJson(j['trip']))),
        'trip:offer' => OfferEvent(TripOffer.fromJson(j)),
        'trip:offer_expired' => OfferExpiredEvent(tripId: str(j, 'tripId'), offerId: str(j, 'offerId')),
        'trip:offer_cancelled' => OfferCancelledEvent(tripId: str(j, 'tripId')),
        'driver:location' => DriverLocationEvent(
            tripId: str(j, 'tripId'), driverId: str(j, 'driverId'), lat: readDouble(j, 'lat'), lng: readDouble(j, 'lng'), heading: doubleOrNull(j, 'heading'),
            at: j['at'] is num ? DateTime.fromMillisecondsSinceEpoch(readInt(j, 'at'), isUtc: true) : DateTime.now().toUtc(),
          ),
        'payment:action_required' => PaymentActionRequiredEvent(payment: Payment.fromJson(asJson(j['payment'])), instructions: strOrNull(j, 'instructions')),
        'payment:captured' => PaymentCapturedEvent(Payment.fromJson(asJson(j['payment']))),
        'payment:failed' => PaymentFailedEvent(Payment.fromJson(asJson(j['payment']))),
        'balance:topped_up' => BalanceToppedUpEvent(TopUp.fromJson(asJson(j['topUp']))),
        _ => null,
      };
    } on FormatException {
      return null;
    }
  }
}

class TripStatusEvent extends RealtimeEvent {
  const TripStatusEvent({required this.tripId, required this.status, required this.trip});
  final String tripId;
  final TripStatus status;
  final Trip trip;
}

class OfferEvent extends RealtimeEvent {
  const OfferEvent(this.offer);
  final TripOffer offer;
}

class OfferExpiredEvent extends RealtimeEvent {
  const OfferExpiredEvent({required this.tripId, required this.offerId});
  final String tripId;
  final String offerId;
}

class OfferCancelledEvent extends RealtimeEvent {
  const OfferCancelledEvent({required this.tripId});
  final String tripId;
}

class DriverLocationEvent extends RealtimeEvent {
  const DriverLocationEvent({required this.tripId, required this.driverId, required this.lat, required this.lng, this.heading, required this.at});
  final String tripId;
  final String driverId;
  final double lat;
  final double lng;
  final double? heading;
  final DateTime at;
}

class PaymentActionRequiredEvent extends RealtimeEvent {
  const PaymentActionRequiredEvent({required this.payment, this.instructions});
  final Payment payment;
  final String? instructions;
}

class PaymentCapturedEvent extends RealtimeEvent {
  const PaymentCapturedEvent(this.payment);
  final Payment payment;
}

class PaymentFailedEvent extends RealtimeEvent {
  const PaymentFailedEvent(this.payment);
  final Payment payment;
}

class BalanceToppedUpEvent extends RealtimeEvent {
  const BalanceToppedUpEvent(this.topUp);
  final TopUp topUp;
}

/// What the gateway answers to `location:update`.
@immutable
class PingAck {
  const PingAck({required this.accepted, this.reason});
  final bool accepted;
  /// forbidden | too_frequent | unavailable | invalid | inaccurate | future | out_of_order | too_fast | timeout
  final String? reason;
  factory PingAck.fromJson(Object? v) {
    final j = asJson(v);
    return PingAck(accepted: readBool(j, 'accepted'), reason: strOrNull(j, 'reason'));
  }
}

/// A driver's position as the app sends it (`location:update`).
@immutable
class LocationPing {
  const LocationPing({required this.lat, required this.lng, this.heading, this.speed, this.accuracy, required this.at});
  final double lat;
  final double lng;
  final double? heading;
  /// m/s
  final double? speed;
  /// metres
  final double? accuracy;
  /// unix ms (device time)
  final int at;
  Json toJson() => {'lat': lat, 'lng': lng, 'heading': ?heading, 'speed': ?speed, 'accuracy': ?accuracy, 'at': at};
}
