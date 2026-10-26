// Typed wrappers for the services the app calls. One class per service; no state.

import 'dart:typed_data';

import 'package:dio/dio.dart';
import '../models/balance.dart';
import '../models/client_config.dart';
import '../models/fleet.dart';
import '../models/json.dart';
import '../models/payment.dart';
import '../models/place.dart';
import '../models/quote.dart';
import '../models/trip.dart';
import '../models/trip_offer.dart';
import 'api_client.dart';

class PlatformApi {
  const PlatformApi(this._c);
  final ApiClient _c;
  Future<ClientConfig> clientConfig({required String audience, String? cityId}) =>
      _c.getJson('/api/platform/client-config', query: {'audience': audience, 'cityId': ?cityId}, auth: false).then(ClientConfig.fromJson);
}

class MapsApi {
  const MapsApi(this._c);
  final ApiClient _c;
  Future<List<Place>> search(String q, {String? cityId, String language = 'en', int limit = 8}) =>
      _c.getJson('/api/maps/search', query: {'q': q, 'cityId': ?cityId, 'language': language, 'limit': limit}).then((j) => asJsonList(j['results']).map(Place.fromJson).toList(growable: false));
  Future<Place?> reverse(double lat, double lng, {String language = 'en'}) => _c.getJson('/api/maps/reverse', query: {'lat': lat, 'lng': lng, 'language': language}).then((j) => j.isEmpty ? null : Place.fromJson(j));
  Future<({double lat, double lng})> snap(double lat, double lng) => _c.getJson('/api/maps/snap', query: {'lat': lat, 'lng': lng}).then((j) => (lat: readDouble(j, 'lat', lat), lng: readDouble(j, 'lng', lng)));
}

class PricingApi {
  const PricingApi(this._c);
  final ApiClient _c;
  Future<List<Quote>> estimates({required Place pickup, required Place dropoff, List<String>? vehicleTypes}) => _c
      .postJson('/api/pricing/estimates', body: {
        'pickup': {'lat': pickup.lat, 'lng': pickup.lng},
        'dropoff': {'lat': dropoff.lat, 'lng': dropoff.lng},
        'vehicleTypes': ?vehicleTypes,
        'pickupAddress': pickup.name,
        'dropoffAddress': dropoff.name,
      })
      .then((j) => asJsonList(j['quotes']).map(Quote.fromJson).toList(growable: false));
  Future<List<FareCard>> fares(String cityId) => _c.getJson('/api/pricing/fares', query: {'cityId': cityId}, auth: false).then((j) => asJsonList(j['fares']).map(FareCard.fromJson).toList(growable: false));
}

class TripsApi {
  const TripsApi(this._c);
  final ApiClient _c;
  static const base = '/api/trips';

  Future<Trip> request({required String quoteId, required PaymentMethod paymentMethod, String? billingOrgId, required String idempotencyKey}) => _c
      .postJson(base, body: {'quoteId': quoteId, 'paymentMethod': paymentMethodToApi(paymentMethod), 'billingOrgId': ?billingOrgId}, idempotencyKey: idempotencyKey)
      .then(Trip.fromJson);
  Future<Trip?> active() => _c.getJson('$base/active').then((j) => j['trip'] is Map ? Trip.fromJson(asJson(j['trip'])) : null);
  Future<({List<Trip> trips, String? next})> list({required String as, String? before, int limit = 20}) =>
      _c.getJson(base, query: {'as': as, 'before': ?before, 'limit': limit}).then((j) => (trips: asJsonList(j['trips']).map(Trip.fromJson).toList(growable: false), next: strOrNull(j, 'next')));
  Future<Trip> get(String id) => _c.getJson('$base/$id').then(Trip.fromJson);
  Future<TripParties> parties(String id) => _c.getJson('$base/$id/parties').then(TripParties.fromJson);
  Future<Trip> accept(String id, String offerId, {required String idempotencyKey}) => _c.postJson('$base/$id/accept', body: {'offerId': offerId}, idempotencyKey: idempotencyKey).then(Trip.fromJson);
  Future<void> decline(String id, String offerId) => _c.postJson('$base/$id/decline', body: {'offerId': offerId});
  Future<Trip> enRoute(String id) => _c.postJson('$base/$id/en-route').then(Trip.fromJson);
  Future<Trip> arrive(String id) => _c.postJson('$base/$id/arrive').then(Trip.fromJson);
  Future<Trip> start(String id, {String? pin}) => _c.postJson('$base/$id/start', body: {'pin': ?pin}).then(Trip.fromJson);
  Future<Trip> complete(String id, {required String idempotencyKey}) => _c.postJson('$base/$id/complete', idempotencyKey: idempotencyKey).then(Trip.fromJson);
  Future<Trip> cancel(String id, CancelReason reason, {required String idempotencyKey}) =>
      _c.postJson('$base/$id/cancel', body: {'reason': cancelReasonToApi(reason)}, idempotencyKey: idempotencyKey).then(Trip.fromJson);
  Future<void> rate(String id, {required int stars, String? comment}) => _c.postJson('$base/$id/rating', body: {'stars': stars, if (comment != null && comment.isNotEmpty) 'comment': comment});
}

class LocationsApi {
  const LocationsApi(this._c);
  final ApiClient _c;
  /// The driver's last position on a trip (HTTP fallback while the socket is down).
  Future<DriverPosition?> tripDriver(String tripId) => _c.getJson('/api/locations/trips/$tripId/driver').then((j) => j['lat'] is num ? DriverPosition.fromJson(j) : null);
}

class DriverPosition {
  const DriverPosition({required this.driverId, required this.lat, required this.lng, this.heading, required this.at});
  final String driverId;
  final double lat;
  final double lng;
  final double? heading;
  final DateTime at;
  factory DriverPosition.fromJson(Json j) => DriverPosition(
        driverId: str(j, 'driverId'), lat: readDouble(j, 'lat'), lng: readDouble(j, 'lng'), heading: doubleOrNull(j, 'heading'),
        at: j['at'] is num ? DateTime.fromMillisecondsSinceEpoch(readInt(j, 'at'), isUtc: true) : (dateOrNull(j, 'at') ?? DateTime.now().toUtc()),
      );
}

class PaymentsApi {
  const PaymentsApi(this._c);
  final ApiClient _c;
  static const base = '/api/payments';

  Future<PaymentMethodsConfig> methods({String? cityId}) => _c.getJson('$base/methods', query: {'cityId': ?cityId}, auth: false).then(PaymentMethodsConfig.fromJson);
  Future<Balance> myBalance({required String cityId, bool open = false}) => _c.getJson('$base/balances/me', query: {'cityId': cityId, 'open': open}).then(Balance.fromJson);
  Future<Balance> orgBalance(String orgId, {required String cityId, bool open = false}) => _c.getJson('$base/balances/org/$orgId', query: {'cityId': cityId, 'open': open}).then(Balance.fromJson);
  Future<Balance> balance(String accountId) => _c.getJson('$base/balances/$accountId').then(Balance.fromJson);
  Future<({List<StatementEntry> entries, String? next})> statement(String accountId, {String? before, int limit = 30}) =>
      _c.getJson('$base/balances/$accountId/statement', query: {'before': ?before, 'limit': limit}).then((j) => (entries: asJsonList(j['entries']).map(StatementEntry.fromJson).toList(growable: false), next: strOrNull(j, 'next')));
  Future<List<TopUp>> topUps(String accountId) => _c.getJson('$base/balances/$accountId/top-ups').then((j) => asJsonList(j['topUps']).map(TopUp.fromJson).toList(growable: false));
  Future<TopUp> createTopUp(String accountId, {required int amountMinor, required String provider, required String idempotencyKey}) =>
      _c.postJson('$base/balances/$accountId/top-ups', body: {'amountMinor': amountMinor, 'provider': provider}, idempotencyKey: idempotencyKey).then(TopUp.fromJson);
  Future<TopUp> topUp(String id) => _c.getJson('$base/top-ups/$id').then(TopUp.fromJson);
  Future<Balance> setPayoutMethod(String accountId, {required String provider, required String destination}) =>
      _c.putJson('$base/balances/$accountId/payout-method', body: {'provider': provider, 'destination': destination}).then(Balance.fromJson);
  Future<TripPayments> tripPayments(String tripId) => _c.getJson('$base/trips/$tripId').then(TripPayments.fromJson);
  Future<Payment> payNow(String paymentId, {required String idempotencyKey}) => _c.postJson('$base/payments/$paymentId/pay', idempotencyKey: idempotencyKey).then(Payment.fromJson);
  Future<String?> preference() => _c.getJson('$base/me/preferences').then((j) => strOrNull(j, 'mobileMoneyProvider'));
  Future<void> setPreference(String provider) => _c.putJson('$base/me/preferences', body: {'mobileMoneyProvider': provider});
}

class FleetApi {
  const FleetApi(this._c);
  final ApiClient _c;
  static const base = '/api/fleet';

  Future<DriverHome> me() => _c.getJson('$base/drivers/me').then(DriverHome.fromJson);
  Future<DriverProfile> apply({required String fullName, required String licenseNumber, required String cityId}) =>
      _c.postJson('$base/drivers/apply', body: {'fullName': fullName, 'licenseNumber': licenseNumber, 'cityId': cityId}).then(DriverProfile.fromJson);
  Future<DriverProfile> submit() => _c.postJson('$base/drivers/me/submit').then(DriverProfile.fromJson);
  Future<List<Vehicle>> drivableVehicles() => _c.getJson('$base/drivers/me/vehicles').then((j) => asJsonList(j['vehicles']).map(Vehicle.fromJson).toList(growable: false));
  Future<Vehicle> registerVehicle({required String plateNumber, required String vehicleType, required String make, required String model, required int year, required String color, required int seats}) => _c
      .postJson('$base/vehicles', body: {'ownerType': 'INDIVIDUAL', 'plateNumber': plateNumber, 'vehicleType': vehicleType, 'make': make, 'model': model, 'year': year, 'color': color, 'seats': seats})
      .then(Vehicle.fromJson);
  Future<Vehicle> vehicle(String id) => _c.getJson('$base/vehicles/$id').then(Vehicle.fromJson);
  Future<Checklist> vehicleChecklist(String id) => _c.getJson('$base/vehicles/$id').then(Checklist.fromJson);
  Future<Vehicle> submitVehicle(String id) => _c.postJson('$base/vehicles/$id/submit').then(Vehicle.fromJson);
  Future<void> retireVehicle(String id) => _c.postJson('$base/vehicles/$id/retire');

  Future<UploadTicket> uploadUrl({required String subjectType, required String subjectId, required DocumentKind kind, required String contentType, required int sizeBytes, required String sha256Hex}) => _c
      .postJson('$base/documents/upload-url', body: {'subjectType': subjectType, 'subjectId': subjectId, 'kind': documentKindToApi(kind), 'contentType': contentType, 'sizeBytes': sizeBytes, 'sha256': sha256Hex})
      .then(UploadTicket.fromJson);

  /// PUT the bytes where the ticket says, with exactly the headers it gave (local storage or S3).
  Future<void> putFile(UploadTicket t, Uint8List bytes, {void Function(int sent, int total)? onProgress}) => _c.call(
        'PUT',
        t.uploadUrl,
        body: Stream<List<int>>.value(bytes),
        headers: {...t.headers, 'content-length': '${bytes.length}'},
        auth: false,
        noRetry: true,
        responseType: ResponseType.plain,
        parse: (_) {},
      );

  Future<DocumentView> confirmDocument(String ticket, {String? expiresAt}) =>
      _c.postJson('$base/documents', body: {'ticket': ticket, 'expiresAt': ?expiresAt}).then(DocumentView.fromJson);
  Future<List<ChecklistItem>> documents({required String subjectType, required String subjectId}) =>
      _c.getJson('$base/documents', query: {'subjectType': subjectType, 'subjectId': subjectId}).then((j) => asJsonList(j['documents']).map(ChecklistItem.fromJson).toList(growable: false));

  Future<DrivingSession> goOnline(String vehicleId, {required String idempotencyKey}) => _c.postJson('$base/sessions', body: {'vehicleId': vehicleId}, idempotencyKey: idempotencyKey).then(DrivingSession.fromJson);
  Future<DrivingSession?> currentSession() => _c.getJson('$base/sessions/current').then((j) => j['session'] is Map ? DrivingSession.fromJson(asJson(j['session'])) : null);
  Future<void> goOffline() => _c.delete('$base/sessions/current');
}

class NotificationsApi {
  const NotificationsApi(this._c);
  final ApiClient _c;
  Future<void> registerDevice(String token, String platform) => _c.postJson('/api/notifications/devices', body: {'token': token, 'platform': platform});
  Future<void> removeDevice(String token) => _c.postJson('/api/notifications/devices/remove', body: {'token': token});
}

/// Everything in one place, so the app builds it once from one [ApiClient].
class Apis {
  Apis(this.client)
      : platform = PlatformApi(client),
        maps = MapsApi(client),
        pricing = PricingApi(client),
        trips = TripsApi(client),
        locations = LocationsApi(client),
        payments = PaymentsApi(client),
        fleet = FleetApi(client),
        notifications = NotificationsApi(client);
  final ApiClient client;
  final PlatformApi platform;
  final MapsApi maps;
  final PricingApi pricing;
  final TripsApi trips;
  final LocationsApi locations;
  final PaymentsApi payments;
  final FleetApi fleet;
  final NotificationsApi notifications;
}

// keep the offer type reachable from here for consumers that import only the APIs
typedef OfferModel = TripOffer;
