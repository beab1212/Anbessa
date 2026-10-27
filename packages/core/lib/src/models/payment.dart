// payment-service, the rider's side: charges for a trip (paymentView), how a trip was settled,
// and the methods offered in a city.

import 'package:meta/meta.dart';
import 'json.dart';
import 'trip.dart';

enum PaymentStatus { pending, actionRequired, retryScheduled, succeeded, failed, refunded, partiallyRefunded, unknown }

String paymentStatusToApi(PaymentStatus s) => snakeOf(s.name).toUpperCase();

@immutable
class Payment {
  const Payment({
    required this.id,
    required this.purpose,
    required this.tripId,
    required this.method,
    required this.provider,
    required this.amountMinor,
    this.currency = 'ETB',
    required this.status,
    this.checkoutUrl,
    required this.attempts,
    this.nextAttemptAt,
    this.lastError,
    required this.refundedMinor,
    required this.settledAsReceivable,
    required this.createdAt,
    this.completedAt,
  });

  final String id;
  /// TRIP_FARE | CANCELLATION_FEE
  final String purpose;
  final String tripId;
  final PaymentMethod method;
  final String provider;
  final int amountMinor;
  final String currency;
  final PaymentStatus status;
  /// the provider's page to approve on; only while ACTION_REQUIRED
  final String? checkoutUrl;
  final int attempts;
  final DateTime? nextAttemptAt;
  final String? lastError;
  final int refundedMinor;
  /// the last retry failed: the rider owes this until they pay
  final bool settledAsReceivable;
  final DateTime createdAt;
  final DateTime? completedAt;

  factory Payment.fromJson(Json j) => Payment(
        id: str(j, 'id'), purpose: str(j, 'purpose', 'TRIP_FARE'), tripId: str(j, 'tripId'),
        method: paymentMethodFromApi(strOrNull(j, 'method')), provider: str(j, 'provider'),
        amountMinor: readInt(j, 'amountMinor'), currency: str(j, 'currency', 'ETB'),
        status: enumFrom(PaymentStatus.values, strOrNull(j, 'status'), PaymentStatus.unknown, apiName: paymentStatusToApi),
        checkoutUrl: strOrNull(j, 'checkoutUrl'), attempts: readInt(j, 'attempts'), nextAttemptAt: dateOrNull(j, 'nextAttemptAt'),
        lastError: strOrNull(j, 'lastError'), refundedMinor: readInt(j, 'refundedMinor'), settledAsReceivable: readBool(j, 'settledAsReceivable'),
        createdAt: readDate(j, 'createdAt'), completedAt: dateOrNull(j, 'completedAt'),
      );

  bool get isPaid => status == PaymentStatus.succeeded || status == PaymentStatus.refunded || status == PaymentStatus.partiallyRefunded;
  bool get isOpen => status == PaymentStatus.pending || status == PaymentStatus.actionRequired || status == PaymentStatus.retryScheduled;
  bool get isOwed => status == PaymentStatus.failed;
}

/// How a trip was settled (drivers and staff only): what came off the balance.
@immutable
class Settlement {
  const Settlement({required this.purpose, required this.paymentMethod, required this.fareMinor, required this.commissionMinor, required this.vatMinor, required this.earningsMinor, required this.settledAt});
  final String purpose;
  final PaymentMethod paymentMethod;
  final int fareMinor;
  final int commissionMinor;
  final int vatMinor;
  /// what the beneficiary's balance moved by (negative on cash trips)
  final int earningsMinor;
  final DateTime settledAt;
  factory Settlement.fromJson(Json j) => Settlement(
        purpose: str(j, 'purpose'), paymentMethod: paymentMethodFromApi(strOrNull(j, 'paymentMethod')), fareMinor: readInt(j, 'fareMinor'),
        commissionMinor: readInt(j, 'commissionMinor'), vatMinor: readInt(j, 'vatMinor'), earningsMinor: readInt(j, 'earningsMinor'), settledAt: readDate(j, 'settledAt'),
      );
}

/// GET /api/payments/trips/:tripId
@immutable
class TripPayments {
  const TripPayments({required this.payments, required this.settlements});
  final List<Payment> payments;
  final List<Settlement> settlements;
  factory TripPayments.fromJson(Json j) => TripPayments(
        payments: asJsonList(j['payments']).map(Payment.fromJson).toList(growable: false),
        settlements: asJsonList(j['settlements']).map(Settlement.fromJson).toList(growable: false),
      );
  static const empty = TripPayments(payments: [], settlements: []);

  Payment? get fare {
    for (final p in payments) {
      if (p.purpose == 'TRIP_FARE') return p;
    }
    return payments.isEmpty ? null : payments.first;
  }
}

/// A provider the app can pay with (GET /api/payments/methods).
@immutable
class PaymentProvider {
  const PaymentProvider({required this.provider, required this.label, required this.methods, required this.mode});
  final String provider;
  final String label;
  final List<PaymentMethod> methods;
  /// "simulated" until the real integration exists
  final String mode;
  factory PaymentProvider.fromJson(Json j) => PaymentProvider(
        provider: str(j, 'provider'), label: str(j, 'label'), methods: strList(j, 'methods').map(paymentMethodFromApi).toList(growable: false), mode: str(j, 'mode'),
      );
  bool get isSimulated => mode == 'simulated';
  bool get takesMobileMoney => methods.contains(PaymentMethod.mobileMoney);
}

@immutable
class PaymentMethodsConfig {
  const PaymentMethodsConfig({required this.methods, required this.providers});
  /// methods riders may choose in the city
  final List<PaymentMethod> methods;
  final List<PaymentProvider> providers;
  factory PaymentMethodsConfig.fromJson(Json j) => PaymentMethodsConfig(
        methods: strList(j, 'methods').map(paymentMethodFromApi).toList(growable: false),
        providers: asJsonList(j['providers']).map(PaymentProvider.fromJson).toList(growable: false),
      );
  static const fallback = PaymentMethodsConfig(methods: [PaymentMethod.cash], providers: []);
}

/// GET /api/payments/earnings/me: what a driver made over a period.
@immutable
class EarningsDay {
  const EarningsDay({required this.day, required this.trips, required this.grossMinor, required this.netMinor});
  /// YYYY-MM-DD, Addis time
  final String day;
  final int trips;
  final int grossMinor;
  final int netMinor;
  factory EarningsDay.fromJson(Json j) => EarningsDay(day: str(j, 'day'), trips: readInt(j, 'trips'), grossMinor: readInt(j, 'grossMinor'), netMinor: readInt(j, 'netMinor'));
}

@immutable
class EarningsSummary {
  const EarningsSummary({required this.from, required this.to, required this.trips, required this.cancellations, required this.grossMinor, required this.commissionMinor, required this.vatMinor, required this.netMinor, this.balanceChangeMinor = 0, required this.cashCollectedMinor, required this.byDay});
  final DateTime from;
  final DateTime to;
  final int trips;
  final int cancellations;
  final int grossMinor;
  final int commissionMinor;
  final int vatMinor;
  /// what the driver made (fare − commission − VAT), whatever the payment method
  final int netMinor;
  /// how the balance moved; on cash trips it goes down by what's owed
  final int balanceChangeMinor;
  final int cashCollectedMinor;
  final List<EarningsDay> byDay;
  factory EarningsSummary.fromJson(Json j) => EarningsSummary(
        from: readDate(j, 'from'), to: readDate(j, 'to'), trips: readInt(j, 'trips'), cancellations: readInt(j, 'cancellations', 0),
        grossMinor: readInt(j, 'grossMinor'), commissionMinor: readInt(j, 'commissionMinor'), vatMinor: readInt(j, 'vatMinor'), netMinor: readInt(j, 'netMinor'),
        balanceChangeMinor: readInt(j, 'balanceChangeMinor', 0), cashCollectedMinor: readInt(j, 'cashCollectedMinor'), byDay: asJsonList(j['byDay']).map(EarningsDay.fromJson).toList(growable: false),
      );
  static final empty = EarningsSummary(from: DateTime.fromMillisecondsSinceEpoch(0), to: DateTime.fromMillisecondsSinceEpoch(0), trips: 0, cancellations: 0, grossMinor: 0, commissionMinor: 0, vatMinor: 0, netMinor: 0, cashCollectedMinor: 0, byDay: const []);
}
