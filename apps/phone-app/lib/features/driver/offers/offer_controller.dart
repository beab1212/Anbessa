// Trip offers (workflow 05 D–E): one at a time, 15 s to accept. Cleared when it expires, the
// rider cancels, or the driver answers. In the background the app raises a local notification
// so the offer isn't missed (the foreground location service keeps the socket alive).

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/network/providers.dart';
import '../../../core/push/local_notifications.dart';
import '../../../core/realtime/realtime_hub.dart';
import '../../rider/trip/active_trip_controller.dart';

@immutable
class OfferState {
  const OfferState({this.offer, this.busy = false, this.error, this.notice});
  final TripOffer? offer;
  final bool busy;
  final Object? error;
  /// expired | cancelled, shown briefly after an offer goes away
  final String? notice;
  OfferState copyWith({TripOffer? offer, bool? busy, Object? error, String? notice, bool clearOffer = false, bool clearError = false, bool clearNotice = false}) =>
      OfferState(offer: clearOffer ? null : (offer ?? this.offer), busy: busy ?? this.busy, error: clearError ? null : (error ?? this.error), notice: clearNotice ? null : (notice ?? this.notice));
}

class OfferController extends Notifier<OfferState> {
  StreamSubscription<RealtimeEvent>? _sub;
  Timer? _expiry;

  @override
  OfferState build() {
    _sub?.cancel();
    _sub = ref.watch(realtimeHubProvider).events.listen((e) {
      switch (e) {
        case OfferEvent(:final offer):
          _show(offer);
        case OfferExpiredEvent(:final offerId):
          if (state.offer?.offerId == offerId) _gone('expired');
        case OfferCancelledEvent(:final tripId):
          if (state.offer?.tripId == tripId) _gone('cancelled');
        default:
          break;
      }
    });
    ref.onDispose(() {
      _sub?.cancel();
      _expiry?.cancel();
    });
    return const OfferState();
  }

  void _show(TripOffer o) {
    _expiry?.cancel();
    state = OfferState(offer: o);
    Haptics.offer();
    final left = o.remaining(DateTime.now().toUtc());
    _expiry = Timer(left + const Duration(seconds: 1), () => _gone('expired'));
    ref.read(localNotificationsProvider).offer(o);
  }

  void _gone(String why) {
    _expiry?.cancel();
    if (state.offer == null) return;
    state = OfferState(notice: why);
    ref.read(localNotificationsProvider).cancelOffer();
    Timer(const Duration(seconds: 4), () {
      if (state.offer == null) state = const OfferState();
    });
  }

  Future<void> accept() async {
    final o = state.offer;
    if (o == null || state.busy) return;
    state = state.copyWith(busy: true, clearError: true);
    try {
      final trip = await ref.read(apisProvider).trips.accept(o.tripId, o.offerId, idempotencyKey: newIdempotencyKey());
      _expiry?.cancel();
      ref.read(localNotificationsProvider).cancelOffer();
      ref.read(activeTripProvider.notifier).set(trip);
      state = const OfferState();
    } on AppError catch (e) {
      // offer_closed / invalid_state: it went to someone else or was cancelled
      state = OfferState(notice: e.code == ErrorCodes.offerClosed || e.code == ErrorCodes.invalidState ? 'expired' : null, error: e.code == ErrorCodes.offerClosed || e.code == ErrorCodes.invalidState ? null : e);
      ref.read(localNotificationsProvider).cancelOffer();
    } catch (e) {
      state = state.copyWith(busy: false, error: e);
    }
  }

  Future<void> decline() async {
    final o = state.offer;
    if (o == null) return;
    _expiry?.cancel();
    state = const OfferState();
    ref.read(localNotificationsProvider).cancelOffer();
    try {
      await ref.read(apisProvider).trips.decline(o.tripId, o.offerId);
    } catch (_) {}
  }
}

final offerProvider = NotifierProvider<OfferController, OfferState>(OfferController.new);
