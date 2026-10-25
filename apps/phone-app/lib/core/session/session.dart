import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Which side of the app the signed-in user sees. Mirrors the `role` claim in
/// the JWT issued by auth-service (`RIDER` / `DRIVER`).
enum AppRole { rider, driver }

/// `null` means signed out. Set after login from the token's role claim.
class SessionRole extends Notifier<AppRole?> {
  @override
  AppRole? build() => null;

  void signIn(AppRole role) => state = role;
  void signOut() => state = null;
}

final sessionRoleProvider = NotifierProvider<SessionRole, AppRole?>(SessionRole.new);
