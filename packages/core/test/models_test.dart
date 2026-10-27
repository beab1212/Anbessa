import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ride_app_core/ride_app_core.dart';

Map<String, dynamic> fixture(String name) => jsonDecode(File('test/fixtures/$name.json').readAsStringSync()) as Map<String, dynamic>;

void main() {
  group('trip (libs/shared-types/src/trip.ts)', () {
    test('parses a real tripView and derives both sides\' stages', () {
      final t = Trip.fromJson(fixture('trip'));
      expect(t.status, TripStatus.enRoute);
      expect(t.paymentMethod, PaymentMethod.mobileMoney);
      expect(t.driver?.vehicleId, '01a17851-cd5d-7ee6-a96b-baa5d206fe95');
      expect(t.fare.chargedMinor, 22000);
      expect(t.pin, '4821');
      expect(t.isActive, isTrue);
      expect(riderStageOf(t), RiderStage.driverArrived);
      expect(driverStageOf(t), DriverStage.waitingAtPickup);
      expect(waitingAtPickup(t, DateTime.utc(2026, 10, 26, 13, 12, 2)), const Duration(minutes: 3));
    });

    test('every TS status literal is covered, and a new one degrades to unknown', () {
      for (final s in ['requested', 'matched', 'en_route', 'in_progress', 'completed', 'cancelled']) {
        expect(tripStatusFromApi(s), isNot(TripStatus.unknown), reason: s);
        expect(tripStatusToApi(tripStatusFromApi(s)), s);
      }
      expect(tripStatusFromApi('scheduled'), TripStatus.unknown);
      expect(paymentMethodToApi(PaymentMethod.mobileMoney), 'MOBILE_MONEY');
      expect(cancelReasonToApi(CancelReason.driverAskedToCancel), 'DRIVER_ASKED_TO_CANCEL');
    });

    test('rider cancellations are free while finding a driver and for 2 min after a match', () {
      final t = Trip.fromJson(fixture('trip'));
      expect(riderCancelIsFree(t, DateTime.utc(2026, 10, 26, 13, 8)), isTrue);
      expect(riderCancelIsFree(t, DateTime.utc(2026, 10, 26, 13, 10)), isFalse);
    });
  });

  group('client config', () {
    test('parses, finds cities by point, filters vehicle types, reads flags with defaults', () {
      final c = ClientConfig.fromJson(fixture('client_config'));
      expect(c.cityAt(9.0, 38.75)?.id, 'addis-ababa');
      expect(c.cityAt(0, 0), isNull);
      expect(c.vehicleTypesIn('hawassa').map((v) => v.code), ['economy']);
      expect(c.features[Feature.sos], isTrue);
      expect(c.features[Feature.scheduledRides], isFalse);
      expect(c.minAppVersions['driver']?['android'], '1.2.0');
      expect(c.announcements.single.title, 'Fuel prices');
    });

    test('the fallback covers both built-in cities', () {
      expect(ClientConfig.fallback.city('hawassa')?.name, 'Hawassa');
      expect(ClientConfig.fallback.features[Feature.phoneBooking], isFalse);
    });
  });

  group('balance and driver home', () {
    test('balance: state, dues and the suggested top-up', () {
      final b = Balance.fromJson(fixture('balance'));
      expect(b.state, BalanceState.cashBlocked);
      expect(b.owes, isTrue);
      expect(b.openDues.single.minimumLeftMinor, 17250);
      expect(b.payoutMethod?.destination, '•••3344');
      expect(b.suggestedTopUpMinor, 22500);
    });

    test('driver home: checklist and vehicles', () {
      final h = DriverHome.fromJson(fixture('driver_home'));
      expect(h.driver?.isActive, isTrue);
      expect(h.driver?.checklist.readyToSubmit, isFalse);
      expect(h.driver?.checklist.items.where((i) => i.needsUpload).map((i) => i.kind), [DocumentKind.photo]);
      expect(h.allVehicles.length, 2);
      expect(h.fleetVehicles.single.isFleet, isTrue);
      expect(h.session?.isOpen, isTrue);
    });
  });

  group('claims', () {
    test('decodes an unsigned JWT payload and reads roles', () {
      final payload = base64Url.encode(utf8.encode(jsonEncode({
        'sub': 'u1', 'aud': 'ride-app', 'exp': 1800000000, 'pv': 3, 'amr': ['otp'],
        'roles': [{'r': 'RIDER'}, {'r': 'FLEET_DRIVER', 'org': 'o1'}],
      })));
      final c = Claims.decode('h.$payload.s');
      expect(c.userId, 'u1');
      expect(c.isRider, isTrue);
      expect(c.isDriver, isTrue);
      expect(c.orgIds, ['o1']);
      expect(c.isFresh(DateTime.fromMillisecondsSinceEpoch(1800000000 * 1000 - 120_000, isUtc: true)), isTrue);
      expect(c.isFresh(DateTime.fromMillisecondsSinceEpoch(1800000000 * 1000 - 30_000, isUtc: true)), isFalse);
    });
  });

  group('realtime events', () {
    test('parses every registered event name and ignores unknown ones', () {
      final trip = fixture('trip');
      expect(RealtimeEvent.fromSocket('trip:status', {'tripId': trip['id'], 'status': 'en_route', 'trip': trip}), isA<TripStatusEvent>());
      expect(Trip.fromJson(trip).route.polyline, '_p~iF~ps|U_ulLnnqC');
      final loc = RealtimeEvent.fromSocket('driver:location', {'tripId': 't', 'driverId': 'd', 'lat': 9.01, 'lng': 38.76, 'heading': 90, 'speed': 8.5, 'at': 1700000000000});
      expect((loc as DriverLocationEvent).speed, 8.5);
      final est = Estimates.fromJson({
        'quotes': [{'id': 'q1', 'cityId': 'addis-ababa', 'vehicleType': 'economy', 'pickup': {'lat': 9.0, 'lng': 38.7}, 'dropoff': {'lat': 9.1, 'lng': 38.8}, 'fareMinor': 20000, 'waitingPerMinMinor': 300, 'distanceMeters': 6000, 'durationSeconds': 900, 'approximate': false, 'routePolyline6': 'abc', 'etaToPickupSeconds': 240, 'driversNearby': 3, 'expiresAt': '2026-10-27T10:00:00Z'}],
        'route': {'polyline6': 'abc', 'distanceMeters': 6000, 'durationSeconds': 900, 'approximate': false},
      });
      expect(est.route!.polyline6, 'abc');
      expect(est.quotes.single.etaToPickupSeconds, 240);
      final steps = RouteSteps.fromJson({'polyline6': 'abc', 'distanceMeters': 100, 'durationSeconds': 20, 'approximate': false, 'steps': [{'maneuver': {'type': 'turn', 'modifier': 'left', 'location': {'lat': 9.0, 'lng': 38.7}, 'bearingAfter': 270}, 'name': 'Churchill Avenue', 'distanceMeters': 100, 'durationSeconds': 20}]});
      expect(steps.steps.single.modifier, 'left');
      final place = SavedPlace.fromJson({'id': 'p1', 'label': 'HOME', 'name': 'Home', 'address': 'Bole', 'lat': 8.99, 'lng': 38.79});
      expect(place.label, PlaceLabel.home);
      expect(place.place.label, 'Bole');
      expect(SavedPlace.fromJson({'id': 'p2', 'label': 'SCHOOL', 'name': 'x', 'lat': 1, 'lng': 2}).label, PlaceLabel.unknown);
      final cars = NearbyCars.fromJson({'cars': [{'lat': 9.0, 'lng': 38.7, 'heading': 90}], 'etaSeconds': 120, 'driversNearby': 1, 'approximate': false});
      expect(cars.cars.single.heading, 90);
      expect(cars.etaSeconds, 120);
      final offer = RealtimeEvent.fromSocket('trip:offer', {
        'tripId': 't', 'offerId': 'o', 'expiresAt': '2026-10-26T13:07:29.000Z', 'etaToPickupSeconds': 180,
        'pickup': trip['pickup'], 'dropoff': trip['dropoff'], 'vehicleType': 'economy', 'fare': {'estimateMinor': 22000, 'currency': 'ETB'}, 'paymentMethod': 'CASH',
      });
      expect((offer as OfferEvent).offer.remaining(DateTime.utc(2026, 10, 26, 13, 7, 20)), const Duration(seconds: 9));
      expect(RealtimeEvent.fromSocket('driver:location', {'tripId': 't', 'driverId': 'd', 'lat': 9.0, 'lng': 38.7, 'at': 1761484800000}), isA<DriverLocationEvent>());
      expect(RealtimeEvent.fromSocket('payment:action_required', {'payment': {'id': 'p', 'status': 'ACTION_REQUIRED', 'amountMinor': 22000}, 'instructions': 'Approve in telebirr'}), isA<PaymentActionRequiredEvent>());
      expect(RealtimeEvent.fromSocket('balance:topped_up', {'topUp': {'id': 'x', 'status': 'SUCCEEDED', 'amountMinor': 1000}}), isA<BalanceToppedUpEvent>());
      expect(RealtimeEvent.fromSocket('trip:something_new', {}), isNull);
      expect(PingAck.fromJson({'accepted': false, 'reason': 'too_frequent'}).reason, 'too_frequent');
    });
  });

  group('domain helpers', () {
    test('phone numbers', () {
      expect(toE164('0911 22 33 44'), '+251911223344');
      expect(toE164('911223344'), '+251911223344');
      expect(toE164('+251 7 1122 3344'), '+251711223344');
      expect(toE164('0811223344'), isNull);
      expect(formatPhone('+251911223344'), '+251 91 122 3344');
      expect(isPlaceholderName('+251911223344'), isTrue);
      expect(isPlaceholderName('Sara'), isFalse);
    });

    test('money', () {
      expect(birr(40000), '400 ETB');
      expect(birr(123450), '1,234.50 ETB');
      expect(birr(-6900), '−69 ETB');
      expect(birr(40000, locale: 'am'), '400 ብር');
      expect(birr(null), '—');
      expect(toMinor('1,234.5'), 123450);
      expect(toMinor('abc'), isNull);
    });

    test('versions', () {
      expect(compareVersions('1.0.0', '1.2.0') < 0, isTrue);
      expect(compareVersions('1.10.0', '1.9.3') > 0, isTrue);
      expect(compareVersions('2.0.0+7', '2.0.0'), 0);
      expect(isBelowMinimum('1.1.0', '1.2.0'), isTrue);
      expect(isBelowMinimum('1.2.0', null), isFalse);
    });

    test('time in Addis Ababa', () {
      expect(clockOf(DateTime.utc(2026, 10, 26, 13, 7)), '16:07');
      expect(dayAndTime(DateTime.utc(2026, 10, 26, 13, 7)), '26 Oct, 16:07');
      expect(since(DateTime.utc(2026, 10, 26, 13, 0), DateTime.utc(2026, 10, 26, 13, 4)), '4 min');
      expect(since(DateTime.utc(2026, 10, 26, 12, 0), DateTime.utc(2026, 10, 26, 13, 5)), '1 h 05');
      expect(mmss(const Duration(minutes: 3, seconds: 7)), '3:07');
      expect(minutesOf(900), '15 min');
      expect(km(6000), '6.0 km');
      expect(shortId('01a17852-92d0-7c01-8f2f-301de1969537'), '969537');
    });

    test('geometry', () {
      expect(haversineMeters(8.9806, 38.7578, 9.0349, 38.7469), closeTo(6150, 150));
      expect(bearingDegrees(9.0, 38.7, 9.1, 38.7), closeTo(0, 0.5));
      expect(bearingDegrees(9.0, 38.7, 9.0, 38.8), closeTo(90, 0.5));
    });
  });
}
