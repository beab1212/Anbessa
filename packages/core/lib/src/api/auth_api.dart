// auth-service, the app surface (Auth.md §5, §9.1): phone OTP sign-in, the bearer session, the
// 15-minute access token, profile, sessions, and the dev sign-in routes (DEV_LOGIN=on only).

import 'package:dio/dio.dart';
import '../models/json.dart';
import '../models/session.dart';
import 'api_client.dart';
import 'app_error.dart';

class AuthApi {
  const AuthApi(this._c);
  final ApiClient _c;

  static const base = '/api/auth';

  Future<void> sendOtp(String phoneE164) => _c.postJson('$base/phone-number/send-otp', body: {'phoneNumber': phoneE164}, auth: false);

  /// Verifies the code. The bearer plugin returns the session token in the `set-auth-token`
  /// header; older responses carry it only in the session cookie, read as a fallback.
  Future<VerifiedSession> verifyOtp(String phoneE164, String code) => _c.call(
        'POST',
        '$base/phone-number/verify',
        body: {'phoneNumber': phoneE164, 'code': code},
        auth: false,
        parse: (res) {
          final body = asJson(res.data);
          final header = res.headers.value('set-auth-token');
          final token = header ?? _sessionFromCookies(res.headers['set-cookie']) ?? strOrNull(body, 'token');
          if (token == null || token.isEmpty) throw const AppError(status: 500, code: 'no_session_token', message: 'Signed in, but no session token came back.');
          return VerifiedSession(sessionToken: token, user: Profile.fromJson(asJson(body['user'])));
        },
      );

  static String? _sessionFromCookies(List<String>? cookies) {
    if (cookies == null) return null;
    for (final c in cookies) {
      final m = RegExp(r'(?:^|; ?)[a-z]+\.session_token=([^;]+)').firstMatch(c);
      if (m != null) return Uri.decodeComponent(m.group(1)!);
    }
    return null;
  }

  /// The 15-minute access JWT, minted for the bearer session.
  Future<String> accessToken() => _c.call('GET', '$base/token', sessionBearer: true, noRetry: false, parse: (res) {
        final t = strOrNull(asJson(res.data), 'token');
        if (t == null) throw const AppError(status: 401, code: ErrorCodes.sessionEnded, message: 'Your session has ended. Sign in again.');
        return t;
      });

  Future<Profile?> session() => _c.call('GET', '$base/get-session', sessionBearer: true, parse: (res) {
        final j = asJson(res.data);
        return j['user'] is Map ? Profile.fromJson(asJson(j['user'])) : null;
      });

  Future<void> signOut() => _c.call('POST', '$base/sign-out', body: const <String, dynamic>{}, sessionBearer: true, noRetry: true, parse: (_) {});

  /// Name and/or photo (a small JPEG data URL; the server refuses big ones).
  Future<Profile> updateProfile({String? name, String? image}) => _c.call('POST', '$base/update-user', body: {'name': ?name, 'image': ?image}, sessionBearer: true, parse: (res) => Profile.fromJson(asJson(asJson(res.data)['user'] ?? res.data)));
  Future<Profile> updateName(String name) =>
      _c.call('POST', '$base/update-user', body: {'name': name}, sessionBearer: true, parse: (res) => Profile.fromJson(asJson(asJson(res.data)['user'])));

  Future<List<SessionInfo>> listSessions() => _c.call('GET', '$base/list-sessions', sessionBearer: true, parse: (res) {
        final d = res.data;
        final list = d is List ? d : asJson(d)['sessions'];
        return asJsonList(list).map(SessionInfo.fromJson).toList(growable: false);
      });

  Future<void> revokeSession(String token) => _c.call('POST', '$base/revoke-session', body: {'token': token}, sessionBearer: true, parse: (_) {});

  Future<void> revokeOtherSessions() => _c.call('POST', '$base/revoke-other-sessions', body: const <String, dynamic>{}, sessionBearer: true, parse: (_) {});

  // ── development only (auth-service DEV_LOGIN=on; never routed by Kong) ──────

  Future<List<DevAccount>> devAccounts() =>
      _c.getJson('/api/dev/accounts', auth: false).then((j) => asJsonList(j['accounts']).where((a) => a['phone'] is String).map(DevAccount.fromJson).toList(growable: false));

  Future<String> devCode(String phoneE164) => _c.getJson('/api/dev/code', query: {'phone': phoneE164}, auth: false).then((j) => str(j, 'code'));
}

class VerifiedSession {
  const VerifiedSession({required this.sessionToken, required this.user});
  final String sessionToken;
  final Profile user;
}

class IdentityApi {
  const IdentityApi(this._c);
  final ApiClient _c;
  Future<Me> me() => _c.getJson('/api/identity/me').then(Me.fromJson);
  Future<List<Map<String, dynamic>>> cities() => _c.call('GET', '/api/identity/cities', parse: (res) => asJsonList(res.data));
}

/// How a caller may inspect a raw response when a typed wrapper doesn't fit.
typedef RawResponse = Response<dynamic>;

/// Better Auth's organization plugin, the parts the apps use: my organisations and invitations.
class OrganizationsApi {
  const OrganizationsApi(this._c);
  final ApiClient _c;
  static const base = '/api/auth/organization';

  Future<List<Organization>> mine() => _c.call('GET', '$base/list', sessionBearer: true, parse: (res) => asJsonList(res.data).map(Organization.fromJson).toList(growable: false));
  Future<List<OrgInvitation>> invitations() =>
      _c.call('GET', '$base/list-user-invitations', sessionBearer: true, parse: (res) => asJsonList(res.data).map(OrgInvitation.fromJson).toList(growable: false));
  Future<void> accept(String invitationId) => _c.call('POST', '$base/accept-invitation', body: {'invitationId': invitationId}, sessionBearer: true, parse: (_) {});
  Future<void> reject(String invitationId) => _c.call('POST', '$base/reject-invitation', body: {'invitationId': invitationId}, sessionBearer: true, parse: (_) {});
}
