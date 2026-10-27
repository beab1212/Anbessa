// Test doubles shared by the app tests: a socket that never dials, notifiers with fixed state,
// JWTs with chosen claims, in-memory support / safety repositories, and a fake backend under the
// real API client (route → canned JSON, every request recorded).

import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';

import 'package:phone_app/core/realtime/realtime_hub.dart';
import 'package:phone_app/core/session/session_controller.dart';
import 'package:phone_app/features/driver/shift/shift_controller.dart';
import 'package:phone_app/features/rider/trip/active_trip_controller.dart';
import 'package:phone_app/features/support/support_repository.dart';
import 'package:ride_app_core/ride_app_core.dart';

class FakeSocketLink implements SocketLink {
  final handlers = <String, void Function(dynamic)>{};
  final emitted = <(String, dynamic)>[];
  bool _connected = false;
  @override
  void connect(String token) => _connected = true;
  @override
  void disconnect() => _connected = false;
  @override
  bool get connected => _connected;
  @override
  void onConnect(void Function() f) {}
  @override
  void onDisconnect(void Function(dynamic reason) f) {}
  @override
  void onConnectError(void Function(dynamic err) f) {}
  @override
  void onReconnectAttempt(void Function() f) {}
  @override
  void on(String event, void Function(dynamic data) f) => handlers[event] = f;
  @override
  void emitWithAck(String event, dynamic data, void Function(dynamic ack) ack) {
    emitted.add((event, data));
    ack({'ok': true});
  }

  @override
  void setAuthToken(String token) {}
  @override
  void dispose() {}
}

RealtimeHub fakeHub([SocketLink? link]) => RealtimeHub(link: link ?? FakeSocketLink(), token: ({bool force = false}) async => 'jwt', onUnauthorized: () async {}, log: (_) {});

String jwt({String sub = 'u1', List<Map<String, Object?>> roles = const [{'r': 'RIDER'}], required DateTime exp}) {
  String part(Object o) => base64Url.encode(utf8.encode(jsonEncode(o))).replaceAll('=', '');
  return '${part({'alg': 'EdDSA'})}.${part({'sub': sub, 'aud': 'ride-app', 'exp': exp.millisecondsSinceEpoch ~/ 1000, 'pv': 1, 'roles': roles, 'amr': ['otp']})}.sig';
}

Session session({List<Map<String, Object?>> roles = const [{'r': 'RIDER'}]}) => Session(
      claims: Claims.decode(jwt(roles: roles, exp: DateTime.now().toUtc().add(const Duration(minutes: 15)))),
      profile: const Profile(id: 'u1', name: 'Abebe', phone: '+251900000501'),
    );

Json fixture(String name) => asJson(jsonDecode(File('../../packages/core/test/fixtures/$name').readAsStringSync()));

class FixedSession extends SessionController {
  FixedSession(this.value);
  final Session? value;
  @override
  Future<Session?> build() async => value;
}

class FixedMode extends ModeController {
  FixedMode(this.value);
  final AppMode? value;
  @override
  AppMode? build() => value;
}

class FixedActiveTrip extends ActiveTripController {
  FixedActiveTrip(this.value);
  final Trip? value;
  @override
  Future<Trip?> build() async => value;
}

class FixedDriverHome extends DriverHomeController {
  FixedDriverHome(this.value);
  final DriverHome value;
  @override
  Future<DriverHome> build() async => value;
}

/// support-service in memory: tickets and lost items from the core fixtures, every call recorded.
class FakeSupportRepository implements SupportRepository {
  FakeSupportRepository({List<Ticket>? tickets, List<LostItem>? lostItems, this.fail}) {
    final t = TicketThread.fromJson(fixture('ticket.json'));
    final l = LostItemThread.fromJson(fixture('lost_item.json'));
    for (final x in tickets ?? [t.ticket]) {
      threads[x.id] = TicketThread(ticket: x, messages: x.id == t.ticket.id ? t.messages : const []);
    }
    for (final x in lostItems ?? [l.lostItem]) {
      lostThreads[x.id] = LostItemThread(lostItem: x, messages: x.id == l.lostItem.id ? l.messages : const []);
    }
  }

  final threads = <String, TicketThread>{};
  final lostThreads = <String, LostItemThread>{};
  final calls = <String>[];
  /// thrown by every write when set
  AppError? fail;
  final _at = DateTime.utc(2026, 10, 27, 9);

  void _write(String what) {
    calls.add(what);
    if (fail != null) throw fail!;
  }

  @override
  Future<TicketPage> tickets({String? cursor}) async => (tickets: threads.values.map((t) => t.ticket).toList(), next: null);
  @override
  Future<Ticket> open({required TicketCategory category, required String subject, required String message, String? tripId, String? cityId, String? as, required String idempotencyKey}) async {
    _write('open ${ticketCategoryToApi(category)} trip=$tripId city=$cityId as=$as subject=$subject');
    final t = Ticket(id: 'new-ticket', ref: 2001, cityId: cityId ?? 'addis-ababa', category: category, status: TicketStatus.open, subject: subject, description: message, tripId: tripId, createdAt: _at, updatedAt: _at);
    threads[t.id] = TicketThread(ticket: t, messages: const []);
    return t;
  }

  @override
  Future<TicketThread> ticket(String id) async => threads[id] ?? (throw const AppError(status: 404, code: ErrorCodes.notFound, message: 'ticket not found'));
  @override
  Future<TicketMessage> reply(String ticketId, String body) async {
    _write('reply $ticketId $body');
    final m = TicketMessage(id: 'm${calls.length}', author: TicketAuthor.requester, body: body, createdAt: _at);
    final t = threads[ticketId]!;
    threads[ticketId] = t.copyWith(messages: [...t.messages, m]);
    return m;
  }

  @override
  Future<Ticket> reopen(String ticketId, String reason) async {
    _write('reopen $ticketId $reason');
    final t = threads[ticketId]!;
    final open = Ticket.fromJson({...asJson(fixture('ticket.json')['ticket']), 'id': ticketId, 'status': 'OPEN', 'resolvedAt': null, 'resolution': null, 'resolutionNote': null});
    threads[ticketId] = t.copyWith(ticket: open);
    return open;
  }

  @override
  Future<LostItemPage> lostItems({String? cursor}) async => (lostItems: lostThreads.values.map((t) => t.lostItem).toList(), next: null);
  @override
  Future<LostItem> reportLostItem({required String tripId, required String description, required String idempotencyKey}) async {
    _write('report $tripId $description');
    final l = LostItem.fromJson({...asJson(fixture('lost_item.json')['lostItem']), 'id': 'new-lost', 'tripId': tripId, 'description': description, 'status': 'REPORTED', 'driverNote': null});
    lostThreads[l.id] = LostItemThread(lostItem: l, messages: const []);
    return l;
  }

  @override
  Future<LostItemThread> lostItem(String id) async => lostThreads[id] ?? (throw const AppError(status: 404, code: ErrorCodes.notFound, message: 'lost item not found'));
  @override
  Future<LostItemMessage> replyToLostItem(String id, String body) async {
    _write('lost-reply $id $body');
    final t = lostThreads[id]!;
    final m = LostItemMessage(id: 'lm${calls.length}', author: t.lostItem.viewerRole, body: body, createdAt: _at);
    lostThreads[id] = t.copyWith(messages: [...t.messages, m]);
    return m;
  }

  LostItem _move(String id, String status) {
    final t = lostThreads[id]!;
    final next = LostItem.fromJson({...asJson(fixture('lost_item.json')['lostItem']), 'id': id, 'status': status, 'viewerRole': lostItemRoleToApi(t.lostItem.viewerRole), 'description': t.lostItem.description});
    lostThreads[id] = t.copyWith(lostItem: next);
    return next;
  }

  @override
  Future<LostItem> confirmReturned(String id) async {
    _write('returned $id');
    return _move(id, 'RETURNED');
  }

  @override
  Future<LostItem> answerLostItem(String id, {required bool found, String? note}) async {
    _write('answer $id found=$found note=$note');
    return _move(id, found ? 'FOUND' : 'NOT_FOUND');
  }
}

/// The SOS side of support-service: answers [trigger] (or throws [fail]), then each status poll
/// pops the next of [statuses] (the last one repeats).
class FakeSafetyRepository implements SafetyRepository {
  FakeSafetyRepository({this.fail, List<SosAlert>? statuses}) : statuses = statuses ?? [];
  AppError? fail;
  final List<SosAlert> statuses;
  final sent = <({String tripId, double lat, double lng, double? accuracy, String? cityId, String key})>[];
  int polls = 0;

  static SosAlert alert(String status) => SosAlert.fromJson({...asJson(fixture('sos_alert.json')['alert']), 'status': status, 'acknowledgedAt': status == 'OPEN' ? null : '2026-10-26T13:20:40.000Z'});

  @override
  Future<SosTrigger> raiseSos({required String tripId, required double lat, required double lng, double? accuracy, String? cityId, required String idempotencyKey}) async {
    sent.add((tripId: tripId, lat: lat, lng: lng, accuracy: accuracy, cityId: cityId, key: idempotencyKey));
    if (fail != null) throw fail!;
    return SosTrigger(alert: alert('OPEN'), duplicate: false);
  }

  @override
  Future<SosAlert> sosStatus(String alertId) async {
    polls++;
    if (statuses.isEmpty) return alert('OPEN');
    return statuses.length == 1 ? statuses.first : statuses.removeAt(0);
  }

  @override
  Future<void> updateSosLocation(String alertId, {required double lat, required double lng, double? accuracy}) async {}
}

/// A reply with a status other than 200.
class FakeReply {
  const FakeReply(this.status, this.body);
  final int status;
  final Object body;
}

/// The services behind the real [ApiClient]: `on('POST', '/api/trips', (o) => {...})` answers a
/// route with JSON (or a [FakeReply]); unknown routes answer 404. Requests land in [requests].
class FakeBackend implements HttpClientAdapter {
  final requests = <RequestOptions>[];
  final _routes = <String, Object Function(RequestOptions o)>{};
  void on(String method, String path, Object Function(RequestOptions o) reply) => _routes['$method $path'] = reply;

  /// The JSON bodies sent to one route, oldest first.
  List<Map<String, dynamic>> bodies(String method, String path) =>
      requests.where((r) => r.method == method && r.uri.path == path).map((r) => asJson(r.data)).toList();

  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<List<int>>? requestStream, Future<void>? cancelFuture) async {
    requests.add(options);
    final h = _routes['${options.method} ${options.uri.path}'];
    final r = h == null ? const FakeReply(404, {'error': 'not_found', 'message': 'Not found'}) : h(options);
    final (status, body) = r is FakeReply ? (r.status, r.body) : (200, r);
    return ResponseBody.fromString(jsonEncode(body), status, headers: {'content-type': ['application/json']});
  }

  @override
  void close({bool force = false}) {}

  /// The app's API wrappers over this backend (override `apisProvider` with it).
  Apis apis() => Apis(ApiClient(endpoints: const ApiEndpoints.host(), tokens: _Tokens(), sessionToken: () async => 'sess', newId: () => 'key-${requests.length}', dio: Dio()..httpClientAdapter = this, retryDelays: const []));
}

class _Tokens implements AccessTokenSource {
  @override
  Future<String?> accessToken({bool force = false}) async => 'jwt';
  @override
  Future<void> onSessionEnded(AppError cause) async {}
}
