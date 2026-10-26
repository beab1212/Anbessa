import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/core/session/token_manager.dart';
import 'package:ride_app_core/ride_app_core.dart';

import 'support/fakes.dart';

class FakeAuthApi implements AuthApi {
  FakeAuthApi(this.mint);
  Future<String> Function() mint;
  int calls = 0;
  @override
  Future<String> accessToken() {
    calls++;
    return mint();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

void main() {
  var now = DateTime.utc(2026, 10, 26, 9);
  late FakeAuthApi auth;
  late List<AppError> ended;
  String? sessionToken;

  TokenManager manager() => TokenManager(auth: auth, sessionToken: () async => sessionToken, onEnded: (e) async => ended.add(e), now: () => now);

  setUp(() {
    now = DateTime.utc(2026, 10, 26, 9);
    sessionToken = 'session';
    ended = [];
    auth = FakeAuthApi(() async => jwt(exp: now.add(const Duration(minutes: 15))));
  });

  test('caches the token until 60 s before it expires', () async {
    final tm = manager();
    final a = await tm.accessToken();
    expect(await tm.accessToken(), a);
    expect(auth.calls, 1);
    now = now.add(const Duration(minutes: 14, seconds: 1));
    await tm.accessToken();
    expect(auth.calls, 2);
  });

  test('concurrent callers share one refresh', () async {
    final gate = Completer<String>();
    auth.mint = () => gate.future;
    final tm = manager();
    final both = Future.wait([tm.accessToken(), tm.accessToken(), tm.accessToken(force: true)]);
    gate.complete(jwt(exp: now.add(const Duration(minutes: 15))));
    final tokens = await both;
    expect(tokens.toSet(), hasLength(1));
    expect(auth.calls, 1);
  });

  test('no session token: no request, no token', () async {
    sessionToken = null;
    expect(await manager().accessToken(), isNull);
    expect(auth.calls, 0);
  });

  test('a refused session ends it and clears the cache', () async {
    final tm = manager();
    await tm.accessToken();
    auth.mint = () async => throw const AppError(status: 401, code: ErrorCodes.sessionEnded, message: 'ended');
    expect(await tm.accessToken(force: true), isNull);
    expect(ended.single.code, ErrorCodes.sessionEnded);
    expect(tm.cached, isNull);
  });

  test('a network failure is not a sign-out', () async {
    final tm = manager();
    auth.mint = () async => throw const AppError(status: 0, code: ErrorCodes.network, message: 'offline', retryable: true);
    await expectLater(tm.accessToken(), throwsA(isA<AppError>()));
    expect(ended, isEmpty);
  });

  test('refreshClaims returns the new roles', () async {
    final tm = manager();
    await tm.accessToken();
    expect(tm.claims!.isDriver, isFalse);
    auth.mint = () async => jwt(roles: [{'r': 'RIDER'}, {'r': 'DRIVER'}], exp: now.add(const Duration(minutes: 15)));
    final c = await tm.refreshClaims();
    expect(c!.isDriver, isTrue);
  });
}
