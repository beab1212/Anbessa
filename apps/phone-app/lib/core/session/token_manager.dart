// ignore_for_file: prefer_initializing_formals
// The 15-minute access JWT (Auth.md §8): minted from the bearer session with GET /api/auth/token,
// cached in memory, refreshed 60 s before it expires or when a service refuses it. One refresh at
// a time: concurrent requests share the same future.

import 'dart:async';

import 'package:ride_app_core/ride_app_core.dart';

class TokenManager implements AccessTokenSource {
  TokenManager({required this.auth, required Future<String?> Function() sessionToken, required Future<void> Function(AppError cause) onEnded, DateTime Function()? now})
      : _sessionToken = sessionToken,
        _onEnded = onEnded,
        _now = now ?? (() => DateTime.now().toUtc());

  final AuthApi auth;
  final Future<String?> Function() _sessionToken;
  final Future<void> Function(AppError cause) _onEnded;
  final DateTime Function() _now;

  @override
  Future<void> onSessionEnded(AppError cause) => _onEnded(cause);

  String? _jwt;
  Claims? _claims;
  Future<String?>? _inFlight;

  Claims? get claims => _claims;
  String? get cached => _jwt;

  @override
  Future<String?> accessToken({bool force = false}) async {
    if (!force && _jwt != null && _claims!.isFresh(_now())) return _jwt;
    if (await _sessionToken() == null) return null;
    return _inFlight ??= _refresh().whenComplete(() => _inFlight = null);
  }

  Future<String?> _refresh() async {
    try {
      final jwt = await auth.accessToken();
      _jwt = jwt;
      _claims = Claims.decode(jwt);
      return jwt;
    } on AppError catch (e) {
      if (e.status == 401 || e.status == 403 || e.code == ErrorCodes.sessionEnded) {
        clear();
        await _onEnded(e);
        return null;
      }
      rethrow;
    }
  }

  /// A fresh token and its claims (after a role change, e.g. the driver was activated).
  Future<Claims?> refreshClaims() async {
    final t = await accessToken(force: true);
    return t == null ? null : _claims;
  }

  void clear() {
    _jwt = null;
    _claims = null;
  }
}
