// Workflow 12 and 15 contracts: promo discounts on estimates, scheduled rides and their window,
// company policies, driver incentives, marketing preferences, the new socket events, and the
// request bodies the API classes send (checked against the services' routes).

import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ride_app_core/ride_app_core.dart';

Json _fixture(String name) => asJson(jsonDecode(File('test/fixtures/$name').readAsStringSync()));

class _Adapter implements HttpClientAdapter {
  final requests = <RequestOptions>[];
  Object Function(RequestOptions o) reply = (_) => {};
  int status = 200;
  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<List<int>>? requestStream, Future<void>? cancelFuture) async {
    requests.add(options);
    return ResponseBody.fromString(jsonEncode(reply(options)), status, headers: {'content-type': ['application/json']});
  }

  @override
  void close({bool force = false}) {}
}

class _Tokens implements AccessTokenSource {
  @override
  Future<String?> accessToken({bool force = false}) async => 'jwt';
  @override
  Future<void> onSessionEnded(AppError cause) async {}
}

void main() {
  group('promo codes', () {
    test('estimates carry each quote\'s discount, the payable amount and the outcome', () {
      final e = Estimates.fromJson(_fixture('estimates_promo.json'));
      final eco = e.quotes.first;
      expect(eco.discountMinor, 5000);
      expect(eco.payableMinor, 21000);
      expect(eco.discounted, isTrue);
      expect(eco.promo!.code, 'WELCOME50');
      expect(e.quotes.last.discounted, isFalse);
      expect(e.quotes.last.payableMinor, 34000);
      expect(e.promo!.applied, isTrue);
      expect(e.promo!.discountedQuotes, 1);
    });

    test('a quote without promo fields pays its fare', () {
      final j = asJson(_fixture('estimates_promo.json')['quotes'][1])..remove('discountMinor')..remove('payableMinor');
      final q = Quote.fromJson(j);
      expect(q.discountMinor, 0);
      expect(q.payableMinor, 34000);
    });

    test('a rejected code says why', () {
      final o = PromoOutcome.fromJson({'code': 'OLD10', 'applied': false, 'reason': 'expired', 'message': 'This code has expired.'});
      expect(o.applied, isFalse);
      expect(o.reason, PromoRejection.expired);
    });

    test('code format matches pricing-service', () {
      expect(isValidPromoCode('WELCOME50'), isTrue);
      expect(isValidPromoCode('  ab_c-1 '), isTrue);
      expect(isValidPromoCode('ab'), isFalse);
      expect(isValidPromoCode('NO SPACES'), isFalse);
      expect(isValidPromoCode('x' * 33), isFalse);
    });

    test('a trip\'s fare: the rider pays the fare minus the discount', () {
      final f = TripFare.fromJson({'estimateMinor': 26000, 'finalMinor': 28000, 'currency': 'ETB', 'promoDiscountMinor': 5000, 'promoCode': 'WELCOME50', 'payableMinor': 23000});
      expect(f.chargedMinor, 28000);
      expect(f.payableMinor, 23000);
      expect(TripFare.fromJson({'estimateMinor': 26000}).payableMinor, 26000);
      expect(TripFare.fromJson({'estimateMinor': 3000, 'promoDiscountMinor': 5000}).payableMinor, 0);
    });
  });

  group('scheduled rides', () {
    test('the booking view parses', () {
      final s = ScheduledTrip.fromJson(_fixture('scheduled_trip.json'));
      expect(s.status, ScheduledStatus.scheduled);
      expect(s.cancellable, isTrue);
      expect(s.upcoming, isTrue);
      expect(s.dropoff.address, 'Bole International Airport');
      expect(s.fareEstimateMinor, 26000);
      expect(s.scheduledFor, DateTime.utc(2026, 10, 28, 5, 30));
      expect(s.tripId, isNull);
      final d = ScheduledTrip.fromJson({..._fixture('scheduled_trip.json'), 'status': 'DISPATCHED', 'tripId': 't1', 'tripStatus': 'matched'});
      expect(d.cancellable, isFalse);
      expect(d.tripStatus, TripStatus.matched);
      expect(scheduledStatusFromApi('SOMETHING_NEW'), ScheduledStatus.unknown);
    });

    test('the booking window is 30 minutes to 7 days ahead', () {
      final now = DateTime.utc(2026, 10, 27, 9, 2);
      const w = ScheduleWindow.tripService;
      expect(w.check(now.add(const Duration(minutes: 29)), now), ErrorCodes.tooSoon);
      expect(w.check(now.add(const Duration(minutes: 30)), now), isNull);
      expect(w.check(now.add(const Duration(days: 7)), now), isNull);
      expect(w.check(now.add(const Duration(days: 7, minutes: 1)), now), ErrorCodes.tooFarAhead);
      final s = w.suggested(now);
      expect(s, DateTime.utc(2026, 10, 27, 10)); // 09:02 + 30 + 15 = 09:47 → the next quarter hour
      expect(w.check(s, now), isNull);
    });
  });

  test('company policy, incentives and marketing preferences parse', () {
    final p = CorporatePolicy.fromJson({'orgId': 'o1', 'allowedVehicleTypes': ['economy'], 'allowedDays': [1, 2], 'startMinute': 420, 'endMinute': 1200, 'maxFareMinor': 50000, 'monthlyBudgetMinor': null, 'requirePurpose': true, 'configured': true, 'spentThisMonthMinor': 1200});
    expect(p.requirePurpose, isTrue);
    expect(p.allowedDays, [1, 2]);
    expect(p.monthlyBudgetMinor, isNull);
    final i = Incentive.fromJson({'id': 'i1', 'name': 'Weekend 20', 'cityId': 'addis-ababa', 'vehicleType': null, 'targetTrips': 20, 'rewardMinor': 50000, 'startsAt': '2026-10-24T21:00:00.000Z', 'endsAt': '2026-10-26T21:00:00.000Z', 'status': 'APPROVED', 'trips': 15, 'awardedMinor': 0});
    expect(i.progress, 0.75);
    expect(i.reached, isFalse);
    expect(i.counting(DateTime.utc(2026, 10, 27)), isTrue);
    expect(MarketingPrefs.fromJson({'push': false, 'sms': true}).push, isFalse);
  });

  test('a policy violation keeps the rule name', () async {
    final adapter = _Adapter()
      ..status = 422
      ..reply = (_) => {'error': 'policy_violation', 'message': 'Your company asks for a trip purpose or cost centre', 'rule': 'purpose'};
    final client = ApiClient(endpoints: const ApiEndpoints.host(), tokens: _Tokens(), newId: () => 'k', dio: Dio()..httpClientAdapter = adapter, retryDelays: const []);
    try {
      await TripsApi(client).request(quoteId: 'q', paymentMethod: PaymentMethod.corporate, billingOrgId: 'o1', idempotencyKey: 'k');
      fail('should throw');
    } on AppError catch (e) {
      expect(e.code, ErrorCodes.policyViolation);
      expect(e.rule, PolicyRule.purpose);
      expect(e.status, 422);
    }
  });

  test('request bodies match the routes', () async {
    final adapter = _Adapter();
    final client = ApiClient(endpoints: const ApiEndpoints.host(), tokens: _Tokens(), newId: () => 'k', dio: Dio()..httpClientAdapter = adapter, retryDelays: const []);
    final apis = Apis(client);
    const a = Place(name: 'Meskel Square', lat: 9.0107, lng: 38.7613);
    const b = Place(name: 'Bole', lat: 8.9779, lng: 38.7993);

    adapter.reply = (_) => _fixture('estimates_promo.json');
    await apis.pricing.estimatesWithRoute(pickup: a, dropoff: b, promoCode: ' welcome50 ');
    expect(adapter.requests.last.data['promoCode'], 'welcome50');
    await apis.pricing.estimatesWithRoute(pickup: a, dropoff: b);
    expect((adapter.requests.last.data as Map).containsKey('promoCode'), isFalse);

    adapter.reply = (_) => _fixture('trip.json');
    await apis.trips.request(quoteId: 'q1', paymentMethod: PaymentMethod.corporate, billingOrgId: 'o1', purpose: 'Client visit', idempotencyKey: 'k1');
    expect(adapter.requests.last.data, {'quoteId': 'q1', 'paymentMethod': 'CORPORATE', 'billingOrgId': 'o1', 'purpose': 'Client visit'});

    adapter.reply = (_) => _fixture('scheduled_trip.json');
    final at = DateTime.utc(2026, 10, 28, 5, 30);
    await apis.trips.schedule(quoteId: 'q1', paymentMethod: PaymentMethod.cash, scheduledFor: at, idempotencyKey: 'k2');
    final r = adapter.requests.last;
    expect(r.method, 'POST');
    expect(r.uri.path, '/api/trips/scheduled');
    expect(r.data, {'quoteId': 'q1', 'paymentMethod': 'CASH', 'scheduledFor': '2026-10-28T05:30:00.000Z'});
    expect(r.headers['idempotency-key'] ?? r.headers['Idempotency-Key'], 'k2');

    adapter.reply = (_) => {'scheduled': [_fixture('scheduled_trip.json')]};
    final list = await apis.trips.scheduled();
    expect(list.single.id, '5c1d2e3f-0000-4000-8000-0000000000a1');
    expect(adapter.requests.last.uri.queryParameters['status'], 'upcoming');

    adapter.reply = (_) => {..._fixture('scheduled_trip.json'), 'status': 'CANCELLED'};
    final c = await apis.trips.cancelScheduled('s1');
    expect(adapter.requests.last.uri.path, '/api/trips/scheduled/s1/cancel');
    expect(c.status, ScheduledStatus.cancelled);

    adapter.reply = (_) => {'orgId': 'o1', 'requirePurpose': true};
    expect((await apis.trips.corporatePolicy('o1')).requirePurpose, isTrue);
    expect(adapter.requests.last.uri.path, '/api/trips/corporate/o1/policy');

    adapter.reply = (_) => {'incentives': []};
    await apis.payments.myIncentives(cityId: 'addis-ababa');
    expect(adapter.requests.last.uri.toString(), 'http://localhost:3005/api/payments/incentives/me?cityId=addis-ababa');

    adapter.reply = (_) => {'push': false, 'sms': true};
    final m = await apis.notifications.setMarketing(push: false);
    expect(adapter.requests.last.method, 'PUT');
    expect(adapter.requests.last.data, {'push': false});
    expect(m.push, isFalse);
  });

  test('trip:reassigned and scheduled:status parse', () {
    expect(realtimeEventNames, containsAll(['trip:reassigned', 'scheduled:status']));
    final r = RealtimeEvent.fromSocket('trip:reassigned', {'tripId': 't1', 'reason': null});
    expect(r, isA<TripReassignedEvent>().having((e) => e.tripId, 'tripId', 't1'));
    final s = RealtimeEvent.fromSocket('scheduled:status', {'scheduledTripId': 's1', 'status': 'DISPATCHED', 'tripId': 't9', 'scheduledFor': '2026-10-28T05:30:00.000Z', 'failReason': null});
    expect(s, isA<ScheduledStatusEvent>().having((e) => e.status, 'status', ScheduledStatus.dispatched).having((e) => e.tripId, 'tripId', 't9'));
  });
}
