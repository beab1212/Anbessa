import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/core/push/local_notifications.dart';
import 'package:phone_app/core/realtime/realtime_hub.dart';
import 'package:phone_app/features/driver/offers/offer_controller.dart';
import 'package:ride_app_core/ride_app_core.dart';

import 'support/fakes.dart';

Json offerJson({String tripId = 't1', String offerId = 'o1', Duration left = const Duration(seconds: 15)}) => {
      'tripId': tripId,
      'offerId': offerId,
      'expiresAt': DateTime.now().toUtc().add(left).toIso8601String(),
      'etaToPickupSeconds': 240,
      'pickup': {'lat': 9.0107, 'lng': 38.7613, 'name': 'Meskel Square'},
      'dropoff': {'lat': 8.9806, 'lng': 38.7578, 'name': 'Bole Airport'},
      'vehicleType': 'economy',
      'fare': {'estimateMinor': 25000, 'currency': 'ETB'},
      'paymentMethod': 'CASH',
    };

void main() {
  late RealtimeHub hub;
  late ProviderContainer c;

  final haptics = <HapticKind>[];
  setUp(() {
    haptics.clear();
    Haptics.sink = haptics.add;
    hub = fakeHub();
    c = ProviderContainer(overrides: [
      realtimeHubProvider.overrideWithValue(hub),
      localNotificationsProvider.overrideWithValue(NoLocalNotifications()),
    ]);
    c.listen(offerProvider, (_, _) {});
  });
  tearDown(() => c.dispose());

  Future<void> send(String event, Json data) async {
    hub.inject(RealtimeEvent.fromSocket(event, data)!);
    await Future<void>.delayed(Duration.zero);
  }

  test('an offer shows with its fare and countdown', () async {
    await send('trip:offer', offerJson());
    final s = c.read(offerProvider);
    expect(s.offer?.offerId, 'o1');
    expect(s.offer!.fareEstimateMinor, 25000);
    expect(s.offer!.remaining(DateTime.now().toUtc()).inSeconds, greaterThan(10));
    // the phone buzzes once per offer
    expect(haptics, [HapticKind.offer]);
  });

  test('offer_expired for this offer clears it with a notice', () async {
    await send('trip:offer', offerJson());
    await send('trip:offer_expired', {'tripId': 't1', 'offerId': 'o1'});
    expect(c.read(offerProvider).offer, isNull);
    expect(c.read(offerProvider).notice, 'expired');
  });

  test('events about another offer are ignored', () async {
    await send('trip:offer', offerJson());
    await send('trip:offer_expired', {'tripId': 't1', 'offerId': 'other'});
    await send('trip:offer_cancelled', {'tripId': 'other-trip'});
    expect(c.read(offerProvider).offer?.offerId, 'o1');
  });

  test('the rider cancelling clears the offer', () async {
    await send('trip:offer', offerJson());
    await send('trip:offer_cancelled', {'tripId': 't1'});
    expect(c.read(offerProvider).offer, isNull);
    expect(c.read(offerProvider).notice, 'cancelled');
  });

  test('a newer offer replaces the current one', () async {
    await send('trip:offer', offerJson());
    await send('trip:offer', offerJson(tripId: 't2', offerId: 'o2'));
    expect(c.read(offerProvider).offer?.tripId, 't2');
  });
}
