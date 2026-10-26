// The booking in progress (workflow 05 A–C): pickup, drop-off, the quotes for them, the chosen
// vehicle type and payment method, and the request itself (one Idempotency-Key per attempt, so a
// retry after a network error can't create two trips).

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/network/providers.dart';
import '../../config/client_config_provider.dart';
import '../trip/active_trip_controller.dart';

@immutable
class Booking {
  const Booking({this.pickup, this.dropoff, this.quotes = const [], this.vehicleType, this.paymentMethod = PaymentMethod.cash, this.billingOrgId, this.quoting = false, this.quoteError, this.requestKey});
  final Place? pickup;
  final Place? dropoff;
  final List<Quote> quotes;
  final String? vehicleType;
  final PaymentMethod paymentMethod;
  final String? billingOrgId;
  final bool quoting;
  final Object? quoteError;
  /// the Idempotency-Key of the current request attempt
  final String? requestKey;

  Quote? get quote {
    for (final q in quotes) {
      if (q.vehicleType == vehicleType) return q;
    }
    return quotes.isEmpty ? null : quotes.first;
  }

  bool get ready => pickup != null && dropoff != null;

  Booking copyWith({Place? pickup, Place? dropoff, List<Quote>? quotes, String? vehicleType, PaymentMethod? paymentMethod, String? billingOrgId, bool? quoting, Object? quoteError, String? requestKey, bool clearError = false, bool clearOrg = false}) => Booking(
        pickup: pickup ?? this.pickup, dropoff: dropoff ?? this.dropoff, quotes: quotes ?? this.quotes, vehicleType: vehicleType ?? this.vehicleType,
        paymentMethod: paymentMethod ?? this.paymentMethod, billingOrgId: clearOrg ? null : (billingOrgId ?? this.billingOrgId), quoting: quoting ?? this.quoting,
        quoteError: clearError ? null : (quoteError ?? this.quoteError), requestKey: requestKey ?? this.requestKey,
      );
}

class BookingController extends Notifier<Booking> {
  static const _recentKey = 'recent_places';

  @override
  Booking build() => const Booking();

  void setPickup(Place p) {
    state = state.copyWith(pickup: p, quotes: const [], clearError: true);
    _remember(p);
    if (state.ready) quote();
  }

  void setDropoff(Place p) {
    state = state.copyWith(dropoff: p, quotes: const [], clearError: true);
    _remember(p);
    if (state.ready) quote();
  }

  void choose(String vehicleType) => state = state.copyWith(vehicleType: vehicleType);
  void pay(PaymentMethod m, {String? billingOrgId}) => state = state.copyWith(paymentMethod: m, billingOrgId: billingOrgId, clearOrg: m != PaymentMethod.corporate);
  void reset() => state = const Booking();

  /// Fresh prices for the pair (also when a quote expired).
  Future<void> quote() async {
    final b = state;
    if (!b.ready) return;
    state = b.copyWith(quoting: true, clearError: true);
    try {
      final cfg = ref.read(configProvider);
      final city = cfg.cityAt(b.pickup!.lat, b.pickup!.lng);
      final types = city == null ? null : cfg.vehicleTypesIn(city.id).map((v) => v.code).toList();
      final quotes = await ref.read(apisProvider).pricing.estimates(pickup: b.pickup!, dropoff: b.dropoff!, vehicleTypes: types == null || types.isEmpty ? null : types);
      final keep = quotes.any((q) => q.vehicleType == state.vehicleType) ? state.vehicleType : quotes.firstOrNull?.vehicleType;
      state = state.copyWith(quotes: quotes, vehicleType: keep, quoting: false, requestKey: newIdempotencyKey());
    } catch (e) {
      state = state.copyWith(quoting: false, quoteError: e);
    }
  }

  /// Request the trip with the current quote. The key is reused if this call failed on the network.
  Future<Trip> request() async {
    final q = state.quote;
    if (q == null) throw const AppError(status: 400, code: ErrorCodes.invalidQuote, message: 'no quote');
    final key = state.requestKey ?? newIdempotencyKey();
    state = state.copyWith(requestKey: key);
    final trip = await ref.read(apisProvider).trips.request(quoteId: q.id, paymentMethod: state.paymentMethod, billingOrgId: state.billingOrgId, idempotencyKey: key);
    ref.read(activeTripProvider.notifier).set(trip);
    state = const Booking();
    return trip;
  }

  List<Place> get recent {
    final raw = ref.read(prefsProvider).getStringList(_recentKey) ?? const [];
    return raw.map((s) {
      final parts = s.split('|');
      return parts.length == 4 ? Place(name: parts[0], label: parts[1].isEmpty ? null : parts[1], lat: double.tryParse(parts[2]) ?? 0, lng: double.tryParse(parts[3]) ?? 0) : null;
    }).whereType<Place>().toList();
  }

  void _remember(Place p) {
    final list = [p, ...recent.where((x) => x != p)].take(5).map((x) => '${x.name}|${x.label ?? ''}|${x.lat}|${x.lng}').toList();
    ref.read(prefsProvider).setStringList(_recentKey, list);
  }
}

final bookingProvider = NotifierProvider<BookingController, Booking>(BookingController.new);

/// Methods riders may choose in the current city (payment-service /methods), refreshed each minute.
final paymentMethodsProvider = FutureProvider<PaymentMethodsConfig>((ref) async {
  final city = ref.watch(currentCityProvider);
  try {
    return await ref.read(apisProvider).payments.methods(cityId: city.id);
  } catch (_) {
    return PaymentMethodsConfig.fallback;
  }
});
