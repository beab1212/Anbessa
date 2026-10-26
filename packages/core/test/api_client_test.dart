// The client's interceptors against a fake HTTP adapter: host routing, bearer tokens, one forced
// refresh on a token 401, idempotency keys, retries on transient failures, and error mapping.

import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ride_app_core/ride_app_core.dart';

class _Req {
  _Req(this.o);
  final RequestOptions o;
  String get auth => o.headers['authorization']?.toString() ?? '';
}

class _FakeAdapter implements HttpClientAdapter {
  final List<_Req> requests = [];
  final List<ResponseBody Function(RequestOptions o)> script = [];
  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<List<int>>? requestStream, Future<void>? cancelFuture) async {
    requests.add(_Req(options));
    if (script.isEmpty) return json(200, {'ok': true});
    return script.removeAt(0)(options);
  }

  static ResponseBody json(int status, Object body) => ResponseBody.fromString(jsonEncode(body), status, headers: {'content-type': ['application/json']});
  static ResponseBody failConnection(RequestOptions o) => throw DioException.connectionError(requestOptions: o, reason: 'refused');

  @override
  void close({bool force = false}) {}
}

class _Tokens implements AccessTokenSource {
  String current = 'jwt-1';
  int refreshes = 0;
  bool ended = false;
  @override
  Future<String?> accessToken({bool force = false}) async {
    if (force) current = 'jwt-${++refreshes + 1}';
    return current;
  }

  @override
  Future<void> onSessionEnded(AppError cause) async => ended = true;
}

void main() {
  late _FakeAdapter adapter;
  late _Tokens tokens;
  late ApiClient client;

  setUp(() {
    adapter = _FakeAdapter();
    tokens = _Tokens();
    final dio = Dio()..httpClientAdapter = adapter;
    client = ApiClient(endpoints: const ApiEndpoints.host(), tokens: tokens, sessionToken: () async => 'sess', newId: () => 'fixed', dio: dio, retryDelays: const [Duration.zero, Duration.zero]);
  });

  test('host mode routes each prefix to its service port and sends the bearer token', () async {
    await client.getJson('/api/trips/active');
    await client.getJson('/api/platform/client-config', auth: false);
    await client.call('GET', '/api/auth/token', sessionBearer: true, parse: (_) => 0);
    expect(adapter.requests[0].o.uri.toString(), 'http://localhost:3002/api/trips/active');
    expect(adapter.requests[0].auth, 'Bearer jwt-1');
    expect(adapter.requests[1].o.uri.port, 3011);
    expect(adapter.requests[1].auth, '');
    expect(adapter.requests[2].auth, 'Bearer sess');
    expect(const ApiEndpoints.gateway('https://api.anbessa.et').resolve('/api/trips'), 'https://api.anbessa.et/api/trips');
  });

  test('a token 401 is retried once with a fresh token; a second 401 ends the session', () async {
    adapter.script.addAll([(_) => _FakeAdapter.json(401, {'error': 'token_outdated', 'message': 'old'}), (_) => _FakeAdapter.json(200, {'trip': null})]);
    final r = await client.getJson('/api/trips/active');
    expect(r, {'trip': null});
    expect(adapter.requests.length, 2);
    expect(adapter.requests[1].auth, 'Bearer jwt-2');
    expect(tokens.ended, isFalse);

    adapter.script.addAll([(_) => _FakeAdapter.json(401, {'error': 'token_revoked'}), (_) => _FakeAdapter.json(401, {'error': 'token_revoked'})]);
    await expectLater(client.getJson('/api/trips/active'), throwsA(isA<AppError>().having((e) => e.code, 'code', 'token_revoked')));
    expect(tokens.ended, isTrue);
  });

  test('idempotent POSTs get a key and are retried on transient failures; plain POSTs are not', () async {
    adapter.script.addAll([_FakeAdapter.failConnection, (_) => _FakeAdapter.json(201, {'id': 't1'})]);
    final r = await client.postJson('/api/trips', body: {'quoteId': 'q'}, idempotent: true);
    expect(r['id'], 't1');
    expect(adapter.requests.length, 2);
    expect(adapter.requests[0].o.headers['idempotency-key'], 'app-fixed');
    expect(adapter.requests[1].o.headers['idempotency-key'], 'app-fixed');

    adapter.script.add(_FakeAdapter.failConnection);
    await expectLater(client.postJson('/api/trips/x/decline', body: {}), throwsA(isA<AppError>().having((e) => e.code, 'code', ErrorCodes.network).having((e) => e.retryable, 'retryable', isTrue)));
    expect(adapter.requests.length, 3);
  });

  test('errors carry the backend code, message and validation issues', () async {
    adapter.script.add((_) => _FakeAdapter.json(409, {'error': 'active_trip_exists', 'message': 'the rider already has an active trip'}));
    await expectLater(client.postJson('/api/trips', body: {}), throwsA(isA<AppError>().having((e) => e.code, 'code', 'active_trip_exists').having((e) => e.isConflict, 'conflict', isTrue)));
    adapter.script.add((_) => _FakeAdapter.json(400, {'error': 'validation_error', 'message': 'invalid request', 'issues': [{'path': 'phoneNumber', 'message': 'invalid'}]}));
    await expectLater(client.postJson('/api/auth/phone-number/send-otp', body: {}), throwsA(isA<AppError>().having((e) => e.issues.single.path, 'issue', 'phoneNumber')));
    adapter.script.add((_) => _FakeAdapter.json(429, {'error': 'rate_limited'}));
    await expectLater(client.getJson('/api/trips/active'), throwsA(isA<AppError>().having((e) => e.retryable, 'retryable', isTrue)));
  });
}
