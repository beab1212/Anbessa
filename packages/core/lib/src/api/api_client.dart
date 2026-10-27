// ignore_for_file: prefer_initializing_formals (private fields behind named parameters)
// The one HTTP client every service API uses. Dio with, in order:
//   BaseUrlRouter        host mode: /api/<prefix> → the service's own port (no Kong in `make dev-services`)
//   AuthInterceptor      Bearer access token from a hook; one forced refresh + replay on a token 401
//   IdempotencyInterceptor   Idempotency-Key for POSTs marked idempotent
//   RetryInterceptor     GETs and idempotent requests: 3 tries on network errors and 502/503/504
//   ErrorMapper          anything that fails → AppError
// Core stays free of Riverpod: the app hands in the hooks.

import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:dio/io.dart';
import 'app_error.dart';

/// Where requests go. `gateway`: everything to [baseUrl] (Kong, or production). `host`: each API
/// prefix to its service's port on [hostBase] (the table apps/web/vite.config.ts uses).
class ApiEndpoints {
  const ApiEndpoints.gateway(this.baseUrl)
      : hostBase = null,
        hostPorts = const {};

  const ApiEndpoints.host({this.hostBase = 'http://localhost', this.hostPorts = defaultHostPorts}) : baseUrl = '';

  final String baseUrl;
  final String? hostBase;
  final Map<String, int> hostPorts;

  bool get isHostMode => hostBase != null;

  static const defaultHostPorts = {
    '/api/auth': 3001,
    '/api/identity': 3001,
    '/api/dev': 3001,
    '/api/trips': 3002,
    '/api/locations': 3003,
    '/api/pricing': 3004,
    '/api/payments': 3005,
    '/api/notifications': 3006,
    '/api/maps': 3007,
    '/api/fleet': 3008,
    '/api/audit': 3010,
    '/api/platform': 3011,
  };

  /// The absolute URL for a service path.
  String resolve(String path) {
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    if (!isHostMode) return '$baseUrl$path';
    for (final e in hostPorts.entries) {
      if (path == e.key || path.startsWith('${e.key}/') || path.startsWith('${e.key}?')) return '$hostBase:${e.value}$path';
    }
    return '$hostBase:3001$path';
  }
}

/// How the client gets and renews the access token (the app's TokenManager implements it).
abstract class AccessTokenSource {
  /// The current JWT, or null when signed out. `force` fetches a fresh one.
  Future<String?> accessToken({bool force = false});

  /// A forced refresh failed: the session is over.
  Future<void> onSessionEnded(AppError cause);
}

/// Per-request switches, read from `RequestOptions.extra`.
abstract final class ReqExtra {
  /// false: send no Authorization header (public endpoints, provider pages)
  static const auth = 'auth';
  /// true: add an Idempotency-Key (the caller may pass its own in headers)
  static const idempotent = 'idempotent';
  /// true: retried after a token refresh already
  static const retriedAuth = 'retriedAuth';
  /// Bearer the session token instead of the JWT (GET /api/auth/token)
  static const sessionBearer = 'sessionBearer';
  /// skip the retry interceptor
  static const noRetry = 'noRetry';
}

typedef IdGenerator = String Function();

class ApiClient {
  ApiClient({
    required this.endpoints,
    AccessTokenSource? tokens,
    Future<String?> Function()? sessionToken,
    required IdGenerator newId,
    Duration connectTimeout = const Duration(seconds: 10),
    Duration receiveTimeout = const Duration(seconds: 20),
    Dio? dio,
    this.retryDelays = const [Duration(milliseconds: 500), Duration(seconds: 1), Duration(seconds: 2)],
    this.userAgent = 'anbessa-app',
  })  : _tokens = tokens,
        _sessionToken = sessionToken,
        _newId = newId,
        dio = dio ?? Dio(BaseOptions(connectTimeout: connectTimeout, receiveTimeout: receiveTimeout, headers: {'accept': 'application/json'})) {
    this.dio.interceptors.addAll([
      InterceptorsWrapper(onRequest: _route),
      // not queued: the replay inside onError would wait on itself (TokenManager single-flights refreshes anyway)
      InterceptorsWrapper(onRequest: _authorize, onError: _onAuthError),
      InterceptorsWrapper(onRequest: _idempotency),
      InterceptorsWrapper(onError: _retry),
      InterceptorsWrapper(onError: (e, h) => h.reject(_mapped(e))),
    ]);
    final adapter = this.dio.httpClientAdapter;
    if (adapter is IOHttpClientAdapter) {
      adapter.createHttpClient = () => HttpClient()..userAgent = userAgent;
    }
  }

  final Dio dio;
  final ApiEndpoints endpoints;
  final AccessTokenSource? _tokens;
  final Future<String?> Function()? _sessionToken;
  final IdGenerator _newId;
  final List<Duration> retryDelays;
  final String userAgent;

  // ── interceptors ────────────────────────────────────────────────────────────

  void _route(RequestOptions o, RequestInterceptorHandler h) {
    o.path = endpoints.resolve(o.path);
    h.next(o);
  }

  Future<void> _authorize(RequestOptions o, RequestInterceptorHandler h) async {
    if (o.extra[ReqExtra.auth] == false) return h.next(o);
    try {
      if (o.extra[ReqExtra.sessionBearer] == true) {
        final s = await _sessionToken?.call();
        if (s != null) o.headers['authorization'] = 'Bearer $s';
      } else {
        final t = await _tokens?.accessToken();
        if (t != null) o.headers['authorization'] = 'Bearer $t';
      }
      h.next(o);
    } catch (e, st) {
      h.reject(DioException(requestOptions: o, error: e, stackTrace: st, type: DioExceptionType.unknown));
    }
  }

  static const _tokenCodes = {ErrorCodes.tokenOutdated, ErrorCodes.tokenRevoked, ErrorCodes.invalidToken, 'expired', ErrorCodes.unauthorized};

  Future<void> _onAuthError(DioException e, ErrorInterceptorHandler h) async {
    final o = e.requestOptions;
    final status = e.response?.statusCode;
    final code = _codeOf(e.response?.data);
    final tokenProblem = status == 401 && o.extra[ReqExtra.auth] != false && o.extra[ReqExtra.sessionBearer] != true && _tokens != null;
    if (!tokenProblem || o.extra[ReqExtra.retriedAuth] == true || !(_tokenCodes.contains(code) || code == null)) return h.next(e);
    try {
      final fresh = await _tokens.accessToken(force: true);
      if (fresh == null) return h.next(e);
      final again = await dio.fetch<dynamic>(o.copyWith(extra: {...o.extra, ReqExtra.retriedAuth: true}, headers: {...o.headers, 'authorization': 'Bearer $fresh'}));
      h.resolve(again);
    } on DioException catch (second) {
      if (second.response?.statusCode == 401) await _tokens.onSessionEnded(_mapped(second).error as AppError);
      h.next(second);
    } on AppError catch (err) {
      // The refresh itself failed. A refused session is ended by the token source; a network
      // error or a server hiccup is not a sign-out: surface it and let the caller retry.
      if (err.isAuth || err.isForbidden) await _tokens.onSessionEnded(err);
      h.next(e.copyWith(error: err));
    } catch (_) {
      // an unexpected failure (a bug, a corrupt token) is not proof the session ended either
      h.next(e);
    }
  }

  void _idempotency(RequestOptions o, RequestInterceptorHandler h) {
    if (o.extra[ReqExtra.idempotent] == true && !o.headers.keys.any((k) => k.toLowerCase() == 'idempotency-key')) {
      o.headers['idempotency-key'] = 'app-${_newId()}';
    }
    h.next(o);
  }

  Future<void> _retry(DioException e, ErrorInterceptorHandler h) async {
    final o = e.requestOptions;
    final attempt = (o.extra['_attempt'] as int?) ?? 0;
    final safe = o.method == 'GET' || o.headers.keys.any((k) => k.toLowerCase() == 'idempotency-key');
    final transient = e.type == DioExceptionType.connectionError ||
        e.type == DioExceptionType.connectionTimeout ||
        e.type == DioExceptionType.receiveTimeout ||
        e.type == DioExceptionType.sendTimeout ||
        const {502, 503, 504}.contains(e.response?.statusCode);
    if (!safe || !transient || o.extra[ReqExtra.noRetry] == true || attempt >= retryDelays.length) return h.next(e);
    await Future<void>.delayed(retryDelays[attempt]);
    try {
      h.resolve(await dio.fetch<dynamic>(o.copyWith(extra: {...o.extra, '_attempt': attempt + 1})));
    } on DioException catch (again) {
      h.next(again);
    }
  }

  // ── error mapping ───────────────────────────────────────────────────────────

  static String? _codeOf(Object? body) {
    if (body is Map) {
      final c = body['error'] ?? body['code'];
      if (c is String) return c;
      if (c is Map && c['code'] is String) return c['code'] as String;
    }
    return null;
  }

  static AppError toAppError(DioException e) {
    if (e.error is AppError) return e.error as AppError;
    final res = e.response;
    if (res == null) {
      final timeout = e.type == DioExceptionType.connectionTimeout || e.type == DioExceptionType.receiveTimeout || e.type == DioExceptionType.sendTimeout;
      if (e.type == DioExceptionType.cancel) return const AppError(status: 0, code: ErrorCodes.cancelled, message: 'Cancelled');
      return AppError(status: 0, code: timeout ? ErrorCodes.timeout : ErrorCodes.network, message: "Can't reach the server. Check your connection and try again.", retryable: true);
    }
    final status = res.statusCode ?? 0;
    final body = res.data;
    final code = _codeOf(body) ?? (status == 401 ? ErrorCodes.unauthorized : status == 403 ? ErrorCodes.forbidden : status == 404 ? ErrorCodes.notFound : status == 429 ? ErrorCodes.rateLimited : 'http_$status');
    String message = 'Request failed ($status)';
    var issues = const <FieldIssue>[];
    if (body is Map) {
      if (body['message'] is String) message = body['message'] as String;
      if (body['issues'] is List) {
        issues = (body['issues'] as List).whereType<Map>().map((i) => FieldIssue(path: i['path']?.toString() ?? '', message: i['message']?.toString() ?? '')).toList(growable: false);
      }
    } else if (body is String && body.isNotEmpty && body.length < 200) {
      message = body;
    }
    if (status == 429) message = 'Too many attempts. Wait a minute and try again.';
    return AppError(status: status, code: code, message: message, retryable: status == 429 || status == 502 || status == 503 || status == 504, issues: issues);
  }

  static DioException _mapped(DioException e) => e.error is AppError ? e : e.copyWith(error: toAppError(e));

  // ── calls ───────────────────────────────────────────────────────────────────

  /// Run a request and hand back the body, with every failure as an [AppError].
  Future<T> call<T>(
    String method,
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    Map<String, String>? headers,
    bool auth = true,
    bool idempotent = false,
    String? idempotencyKey,
    bool sessionBearer = false,
    bool noRetry = false,
    ResponseType responseType = ResponseType.json,
    required T Function(Response<dynamic> res) parse,
  }) async {
    try {
      final res = await dio.request<dynamic>(
        path,
        data: body,
        queryParameters: query,
        options: Options(
          method: method,
          headers: {...?headers, 'idempotency-key': ?idempotencyKey},
          responseType: responseType,
          extra: {ReqExtra.auth: auth, ReqExtra.idempotent: idempotent, ReqExtra.sessionBearer: sessionBearer, ReqExtra.noRetry: noRetry},
        ),
      );
      return parse(res);
    } on DioException catch (e) {
      throw toAppError(e);
    }
  }

  Future<Map<String, dynamic>> getJson(String path, {Map<String, dynamic>? query, bool auth = true, Map<String, String>? headers}) =>
      call('GET', path, query: query, auth: auth, headers: headers, parse: _json);

  Future<Map<String, dynamic>> postJson(String path, {Object? body, bool auth = true, bool idempotent = false, String? idempotencyKey, Map<String, String>? headers}) =>
      call('POST', path, body: body ?? const <String, dynamic>{}, auth: auth, idempotent: idempotent, idempotencyKey: idempotencyKey, headers: headers, parse: _json);

  Future<Map<String, dynamic>> putJson(String path, {Object? body, bool auth = true}) => call('PUT', path, body: body, auth: auth, parse: _json);

  Future<void> delete(String path, {bool auth = true}) => call('DELETE', path, auth: auth, parse: (_) {});

  static Map<String, dynamic> _json(Response<dynamic> res) {
    final d = res.data;
    if (d is Map) return Map<String, dynamic>.from(d);
    return <String, dynamic>{};
  }
}
