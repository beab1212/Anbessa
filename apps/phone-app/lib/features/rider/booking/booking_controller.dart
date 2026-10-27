// The booking in progress (workflow 05 A–C): pickup, drop-off, the quotes for them (and the road
// line they share), the chosen vehicle type and payment method, and the request itself (one
// Idempotency-Key per attempt, so a retry after a network error can't create two trips).
// Also a promo code sent with the estimates (workflow 15), a pickup time to book the ride for
// later instead (workflow 12), and the purpose of a company ride (workflow 11).

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/network/providers.dart';
import '../../../core/prefs_keys.dart';
import '../../config/client_config_provider.dart';
import '../scheduled/scheduled_rides_controller.dart';
import '../trip/active_trip_controller.dart';

@immutable
class Booking {
  const Booking({
    this.pickup,
    this.dropoff,
    this.quotes = const [],
    this.route,
    this.vehicleType,
    this.paymentMethod = PaymentMethod.cash,
    this.billingOrgId,
    this.quoting = false,
    this.quoteError,
    this.requestKey,
    this.promoCode,
    this.promo,
    this.scheduledFor,
    this.purpose = '',
  });
  final Place? pickup;
  final Place? dropoff;
  final List<Quote> quotes;
  /// the road line the quotes share
  final QuoteRoute? route;
  final String? vehicleType;
  final PaymentMethod paymentMethod;
  final String? billingOrgId;
  final bool quoting;
  final Object? quoteError;
  /// the Idempotency-Key of the current request attempt
  final String? requestKey;
  /// the promo code sent with every estimate (dropped when pricing-service refuses it)
  final String? promoCode;
  /// what happened to the last code the rider entered
  final PromoOutcome? promo;
  /// book for later instead of now (UTC)
  final DateTime? scheduledFor;
  /// a company ride's purpose or cost centre
  final String purpose;

  Quote? get quote {
    for (final q in quotes) {
      if (q.vehicleType == vehicleType) return q;
    }
    return quotes.isEmpty ? null : quotes.first;
  }

  bool get ready => pickup != null && dropoff != null;
  bool get scheduling => scheduledFor != null;
  /// the purpose to send: only for company rides, only when given
  String? get purposeToSend => paymentMethod == PaymentMethod.corporate && purpose.trim().isNotEmpty ? purpose.trim() : null;

  Booking copyWith({
    Place? pickup,
    Place? dropoff,
    List<Quote>? quotes,
    QuoteRoute? route,
    String? vehicleType,
    PaymentMethod? paymentMethod,
    String? billingOrgId,
    bool? quoting,
    Object? quoteError,
    String? requestKey,
    String? promoCode,
    PromoOutcome? promo,
    DateTime? scheduledFor,
    String? purpose,
    bool clearError = false,
    bool clearOrg = false,
    bool clearRoute = false,
    bool clearPromoCode = false,
    bool clearPromo = false,
    bool clearSchedule = false,
  }) =>
      Booking(
        pickup: pickup ?? this.pickup, dropoff: dropoff ?? this.dropoff, quotes: quotes ?? this.quotes, route: clearRoute ? null : (route ?? this.route), vehicleType: vehicleType ?? this.vehicleType,
        paymentMethod: paymentMethod ?? this.paymentMethod, billingOrgId: clearOrg ? null : (billingOrgId ?? this.billingOrgId), quoting: quoting ?? this.quoting,
        quoteError: clearError ? null : (quoteError ?? this.quoteError), requestKey: requestKey ?? this.requestKey,
        promoCode: clearPromoCode ? null : (promoCode ?? this.promoCode), promo: clearPromo ? null : (promo ?? this.promo),
        scheduledFor: clearSchedule ? null : (scheduledFor ?? this.scheduledFor), purpose: purpose ?? this.purpose,
      );
}

class BookingController extends Notifier<Booking> {
  static const maxRecent = 8;

  @override
  Booking build() {
    final saved = ref.watch(prefsProvider).getString(PrefsKeys.lastPaymentMethod);
    final m = PaymentMethod.values.where((v) => v.name == saved).firstOrNull;
    return Booking(paymentMethod: m ?? PaymentMethod.cash);
  }

  void setPickup(Place p, {bool quote = true}) {
    state = state.copyWith(pickup: p, quotes: const [], clearError: true, clearRoute: true);
    if (quote && state.ready) this.quote();
  }

  void setDropoff(Place p, {bool quote = true}) {
    state = state.copyWith(dropoff: p, quotes: const [], clearError: true, clearRoute: true);
    remember(p);
    if (quote && state.ready) this.quote();
  }

  void swap() {
    final b = state;
    state = b.copyWith(pickup: b.dropoff, dropoff: b.pickup, quotes: const [], clearError: true, clearRoute: true);
    if (state.ready) quote();
  }

  void choose(String vehicleType) => state = state.copyWith(vehicleType: vehicleType);

  void pay(PaymentMethod m, {String? billingOrgId}) {
    state = state.copyWith(paymentMethod: m, billingOrgId: billingOrgId, clearOrg: m != PaymentMethod.corporate);
    ref.read(prefsProvider).setString(PrefsKeys.lastPaymentMethod, m.name);
  }

  void reset() => state = Booking(paymentMethod: state.paymentMethod, billingOrgId: state.billingOrgId);

  /// Use [code] on the quotes: checked for format here (the API would refuse the whole estimate),
  /// then sent with a fresh estimate. A code pricing-service can't use comes back in [Booking.promo].
  Future<void> applyPromo(String code) async {
    final c = code.trim().toUpperCase();
    if (!isValidPromoCode(c)) {
      state = state.copyWith(promo: PromoOutcome(code: c, applied: false, reason: PromoRejection.invalidFormat), clearPromoCode: true);
      return;
    }
    state = state.copyWith(promoCode: c, clearPromo: true);
    await quote();
  }

  Future<void> removePromo() async {
    final had = state.promoCode != null;
    state = state.copyWith(clearPromoCode: true, clearPromo: true);
    if (had) await quote();
  }

  /// Ride later at [at] (UTC), or now with null. The quotes stay: the booking re-prices near pickup.
  void scheduleAt(DateTime? at) => state = at == null ? state.copyWith(clearSchedule: true) : state.copyWith(scheduledFor: at.toUtc(), requestKey: newIdempotencyKey());

  void setPurpose(String v) => state = state.copyWith(purpose: v);

  /// Fresh prices for the pair (also when a quote expired).
  Future<void> quote() async {
    final b = state;
    if (!b.ready) return;
    state = b.copyWith(quoting: true, clearError: true);
    try {
      final cfg = ref.read(configProvider);
      final city = cfg.cityAt(b.pickup!.lat, b.pickup!.lng);
      final types = city == null ? null : cfg.vehicleTypesIn(city.id).map((v) => v.code).toList();
      final est = await ref.read(apisProvider).pricing.estimatesWithRoute(pickup: b.pickup!, dropoff: b.dropoff!, vehicleTypes: types == null || types.isEmpty ? null : types, promoCode: b.promoCode);
      final keep = est.quotes.any((q) => q.vehicleType == state.vehicleType) ? state.vehicleType : est.quotes.firstOrNull?.vehicleType;
      final promo = est.promo;
      state = state.copyWith(
        quotes: est.quotes, route: est.route, vehicleType: keep, quoting: false, requestKey: newIdempotencyKey(),
        // the outcome of the code sent; without a code, a refusal on screen stays until the rider acts
        promo: promo, clearPromo: b.promoCode != null && promo == null,
        // a refused code isn't sent again with the next estimate
        clearPromoCode: promo != null && !promo.applied,
      );
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
    final trip = await ref.read(apisProvider).trips.request(quoteId: q.id, paymentMethod: state.paymentMethod, billingOrgId: state.billingOrgId, purpose: state.purposeToSend, idempotencyKey: key);
    ref.read(activeTripProvider.notifier).set(trip);
    reset();
    return trip;
  }

  /// Book the current quote for [Booking.scheduledFor] (POST /api/trips/scheduled). Same key rule as [request].
  Future<ScheduledTrip> schedule() async {
    final q = state.quote;
    final at = state.scheduledFor;
    if (q == null) throw const AppError(status: 400, code: ErrorCodes.invalidQuote, message: 'no quote');
    if (at == null) throw const AppError(status: 400, code: ErrorCodes.validation, message: 'no time');
    final key = state.requestKey ?? newIdempotencyKey();
    state = state.copyWith(requestKey: key);
    final s = await ref.read(apisProvider).trips.schedule(quoteId: q.id, paymentMethod: state.paymentMethod, scheduledFor: at, billingOrgId: state.billingOrgId, purpose: state.purposeToSend, idempotencyKey: key);
    ref.read(scheduledRidesProvider.notifier).added(s);
    reset();
    return s;
  }

  List<Place> get recent {
    final raw = ref.read(prefsProvider).getStringList(PrefsKeys.recentPlaces) ?? const [];
    return raw.map((s) {
      final parts = s.split('|');
      return parts.length == 4 ? Place(name: parts[0], label: parts[1].isEmpty ? null : parts[1], lat: double.tryParse(parts[2]) ?? 0, lng: double.tryParse(parts[3]) ?? 0) : null;
    }).whereType<Place>().toList();
  }

  void remember(Place p) {
    final list = [p, ...recent.where((x) => x != p)].take(maxRecent).map((x) => '${x.name}|${x.label ?? ''}|${x.lat}|${x.lng}').toList();
    ref.read(prefsProvider).setStringList(PrefsKeys.recentPlaces, list);
    ref.read(recentPlacesProvider.notifier).set(recent);
  }

  void forget(Place p) {
    final list = recent.where((x) => x != p).map((x) => '${x.name}|${x.label ?? ''}|${x.lat}|${x.lng}').toList();
    ref.read(prefsProvider).setStringList(PrefsKeys.recentPlaces, list);
    ref.read(recentPlacesProvider.notifier).set(recent);
  }
}

final bookingProvider = NotifierProvider<BookingController, Booking>(BookingController.new);

/// Recent places as state, so the home sheet rebuilds when they change.
class RecentPlaces extends Notifier<List<Place>> {
  @override
  List<Place> build() => ref.read(bookingProvider.notifier).recent;
  void set(List<Place> v) => state = v;
}

final recentPlacesProvider = NotifierProvider<RecentPlaces, List<Place>>(RecentPlaces.new);

/// The rules of a company the rider bills rides to; null when they can't be read (no policy
/// permission, offline): the server still checks every ride.
final corporatePolicyProvider = FutureProvider.family<CorporatePolicy?, String>((ref, orgId) async {
  try {
    return await ref.read(apisProvider).trips.corporatePolicy(orgId);
  } catch (_) {
    return null;
  }
});

/// Methods riders may choose in the current city (payment-service /methods), refreshed each minute.
final paymentMethodsProvider = FutureProvider<PaymentMethodsConfig>((ref) async {
  final city = ref.watch(currentCityProvider);
  try {
    return await ref.read(apisProvider).payments.methods(cityId: city.id);
  } catch (_) {
    return PaymentMethodsConfig.fallback;
  }
});
