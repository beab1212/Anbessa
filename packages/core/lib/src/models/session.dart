// Sessions and tokens: the access JWT's claims (Auth.md §8: no personal data, only ids, roles and
// versions), /api/identity/me, and Better Auth's session listing.

import 'dart:convert';

import 'package:meta/meta.dart';
import 'json.dart';

/// One role the user holds, with its scope (libs/shared-authz/src/principal.ts `toRoleClaim`).
@immutable
class RoleClaim {
  const RoleClaim({required this.role, this.orgId, this.cityId, this.global = false});
  final String role;
  final String? orgId;
  final String? cityId;
  final bool global;
  factory RoleClaim.fromJson(Json j) => RoleClaim(role: str(j, 'r'), orgId: strOrNull(j, 'org'), cityId: strOrNull(j, 'city'), global: readBool(j, 'g'));
}

@immutable
class Claims {
  const Claims({required this.userId, required this.audience, required this.expiresAt, required this.issuedAt, required this.permissionVersion, required this.roles, required this.amr});
  final String userId;
  final String audience;
  final DateTime expiresAt;
  final DateTime? issuedAt;
  final int permissionVersion;
  final List<RoleClaim> roles;
  final List<String> amr;

  /// Decode without verifying: the services verify; the app only reads what it was told.
  static Claims decode(String jwt) {
    final parts = jwt.split('.');
    if (parts.length != 3) throw const FormatException('not a JWT');
    final payload = asJson(jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[1])))));
    final aud = payload['aud'];
    return Claims(
      userId: str(payload, 'sub'),
      audience: aud is List ? (aud.isEmpty ? '' : aud.first.toString()) : (aud?.toString() ?? ''),
      expiresAt: DateTime.fromMillisecondsSinceEpoch(readInt(payload, 'exp') * 1000, isUtc: true),
      issuedAt: payload['iat'] is num ? DateTime.fromMillisecondsSinceEpoch(readInt(payload, 'iat') * 1000, isUtc: true) : null,
      permissionVersion: readInt(payload, 'pv'),
      roles: asJsonList(payload['roles']).map(RoleClaim.fromJson).toList(growable: false),
      amr: strList(payload, 'amr'),
    );
  }

  bool hasRole(String code) => roles.any((r) => r.role == code);
  bool get isRider => hasRole('RIDER');
  /// Owner-drivers hold DRIVER; fleet drivers hold FLEET_DRIVER (and DRIVER once activated).
  bool get isDriver => hasRole('DRIVER') || hasRole('FLEET_DRIVER');
  bool get isFleetDriver => hasRole('FLEET_DRIVER');
  List<String> get orgIds => roles.where((r) => r.orgId != null).map((r) => r.orgId!).toSet().toList(growable: false);

  /// Fresh enough to use: refresh when less than [margin] remains.
  bool isFresh(DateTime now, {Duration margin = const Duration(seconds: 60)}) => expiresAt.difference(now) > margin;
}

/// GET /api/identity/me
@immutable
class Me {
  const Me({required this.userId, required this.audience, required this.permissionVersion});
  final String userId;
  final String audience;
  final int permissionVersion;
  factory Me.fromJson(Json j) => Me(userId: str(j, 'userId'), audience: str(j, 'audience'), permissionVersion: readInt(j, 'permissionVersion'));
}

/// Better Auth's /get-session user part: what the app shows on the profile page.
@immutable
class Profile {
  const Profile({required this.id, required this.name, required this.phone, this.image});
  final String id;
  final String name;
  final String phone;
  final String? image;
  factory Profile.fromJson(Json j) => Profile(id: str(j, 'id'), name: str(j, 'name'), phone: str(j, 'phoneNumber'), image: strOrNull(j, 'image'));
}

/// One device signed in (Better Auth /list-sessions).
@immutable
class SessionInfo {
  const SessionInfo({required this.token, required this.createdAt, required this.expiresAt, this.ipAddress, this.userAgent});
  final String token;
  final DateTime createdAt;
  final DateTime expiresAt;
  final String? ipAddress;
  final String? userAgent;
  factory SessionInfo.fromJson(Json j) => SessionInfo(
        token: str(j, 'token'), createdAt: readDate(j, 'createdAt'), expiresAt: readDate(j, 'expiresAt'),
        ipAddress: strOrNull(j, 'ipAddress'), userAgent: strOrNull(j, 'userAgent'),
      );
}

/// A `seed:dev` account the dev sign-in panel lists (GET /api/dev/accounts, DEV_LOGIN=on only).
@immutable
class DevAccount {
  const DevAccount({required this.key, required this.name, required this.label, required this.phone, required this.app, required this.seeded});
  final String key;
  final String name;
  final String label;
  final String phone;
  /// "phone" (drivers, riders) or "web" (portal accounts)
  final String app;
  final bool seeded;
  factory DevAccount.fromJson(Json j) => DevAccount(key: str(j, 'key'), name: str(j, 'name'), label: str(j, 'label'), phone: str(j, 'phone'), app: str(j, 'app', 'web'), seeded: readBool(j, 'seeded'));
}

/// A company (CORPORATE) or fleet (FLEET) the person belongs to (Better Auth organizations).
@immutable
class Organization {
  const Organization({required this.id, required this.name, required this.kind, required this.status, this.slug, this.cityId});
  final String id;
  final String name;
  /// FLEET | CORPORATE | STAFF_CITY | STAFF_HQ
  final String kind;
  /// PENDING | ACTIVE | SUSPENDED
  final String status;
  final String? slug;
  final String? cityId;
  factory Organization.fromJson(Json j) => Organization(
        id: str(j, 'id'), name: str(j, 'name'), kind: str(j, 'kind', ''), status: str(j, 'status', ''), slug: strOrNull(j, 'slug'), cityId: strOrNull(j, 'cityId'),
      );
  bool get isCorporate => kind == 'CORPORATE';
  bool get isFleet => kind == 'FLEET';
}

/// An invitation to join an organisation (fleet driver, company employee).
@immutable
class OrgInvitation {
  const OrgInvitation({required this.id, required this.organizationId, this.organizationName, required this.role, required this.status, this.expiresAt});
  final String id;
  final String organizationId;
  final String? organizationName;
  final String role;
  /// pending | accepted | rejected | canceled
  final String status;
  final DateTime? expiresAt;
  factory OrgInvitation.fromJson(Json j) => OrgInvitation(
        id: str(j, 'id'), organizationId: str(j, 'organizationId'), organizationName: strOrNull(j, 'organizationName'), role: str(j, 'role', ''), status: str(j, 'status', 'pending'), expiresAt: dateOrNull(j, 'expiresAt'),
      );
  bool get isPending => status == 'pending' && (expiresAt == null || expiresAt!.isAfter(DateTime.now().toUtc()));
}
