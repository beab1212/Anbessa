// Who is signed in (Auth.md §9.1): the bearer session in secure storage, the decoded claims of the
// current access token, the profile, and which mode (rider or driver) the person is using.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../network/providers.dart';
import '../push/push_service.dart';
import 'secure_store.dart';

enum AppMode { rider, driver }

@immutable
class Session {
  const Session({required this.claims, required this.profile});
  final Claims claims;
  final Profile profile;
  String get userId => claims.userId;
  bool get canDrive => claims.isDriver;
  /// Name to greet with: the profile name unless it's still the placeholder phone number.
  String get displayName => isPlaceholderName(profile.name) ? formatPhone(profile.phone) : profile.name;
  Session copyWith({Claims? claims, Profile? profile}) => Session(claims: claims ?? this.claims, profile: profile ?? this.profile);
}

/// Why the session went away (shown once on the sign-in screen).
enum SignOutReason { user, sessionEnded, suspended }

class SessionController extends AsyncNotifier<Session?> {
  SignOutReason? lastSignOut;
  final _ended = StreamController<SignOutReason>.broadcast();
  Stream<SignOutReason> get endings => _ended.stream;

  @override
  Future<Session?> build() async {
    ref.onDispose(_ended.close);
    final store = ref.watch(secureStoreProvider);
    if (await store.read(SecureStore.sessionToken) == null) return null;
    try {
      return await _load();
    } on AppError catch (e) {
      if (e.isAuth || e.isForbidden) {
        await _clear();
        return null;
      }
      // the network is down: keep the stored session and let the app work from caches
      final claims = ref.read(tokenManagerProvider).claims;
      if (claims != null) return Session(claims: claims, profile: Profile(id: claims.userId, name: '', phone: ''));
      rethrow;
    }
  }

  Future<Session> _load() async {
    final tokens = ref.read(tokenManagerProvider);
    final jwt = await tokens.accessToken(force: true);
    if (jwt == null) throw const AppError(status: 401, code: ErrorCodes.sessionEnded, message: 'Signed out');
    final claims = tokens.claims!;
    Profile profile;
    try {
      profile = (await ref.read(authApiProvider).session()) ?? Profile(id: claims.userId, name: '', phone: '');
    } on AppError catch (e) {
      if (e.isAuth) rethrow;
      profile = Profile(id: claims.userId, name: '', phone: '');
    }
    return Session(claims: claims, profile: profile);
  }

  /// After a verified OTP: keep the session token, mint the first access token, load the profile.
  Future<Session> signIn(VerifiedSession v) async {
    await ref.read(secureStoreProvider).write(SecureStore.sessionToken, v.sessionToken);
    state = const AsyncLoading();
    final s = await _load().then((s) => s.copyWith(profile: v.user));
    lastSignOut = null;
    state = AsyncData(s);
    return s;
  }

  /// A role changed (the driver was activated): fresh claims, same session.
  Future<void> refreshClaims() async {
    final claims = await ref.read(tokenManagerProvider).refreshClaims();
    final current = state.value;
    if (claims != null && current != null) state = AsyncData(current.copyWith(claims: claims));
  }

  Future<void> updateProfile(Profile p) async {
    final current = state.value;
    if (current != null) state = AsyncData(current.copyWith(profile: p));
  }

  /// The person signs out: tell auth-service (best effort), forget everything.
  Future<void> signOut() async {
    // While the session still authorises it: this device stops receiving the person's pushes.
    await ref.read(pushServiceProvider).unregister().timeout(const Duration(seconds: 5), onTimeout: () {});
    try {
      await ref.read(authApiProvider).signOut().timeout(const Duration(seconds: 5));
    } catch (_) {}
    await _clear();
    lastSignOut = SignOutReason.user;
    state = const AsyncData(null);
  }

  /// auth-service refused the session (revoked, banned, expired): back to sign-in with a reason.
  Future<void> sessionEnded(AppError cause) async {
    if (state.value == null && lastSignOut != null) return;
    await _clear();
    lastSignOut = cause.code == ErrorCodes.tokenRevoked || cause.status == 403 ? SignOutReason.suspended : SignOutReason.sessionEnded;
    _ended.add(lastSignOut!);
    state = const AsyncData(null);
  }

  Future<void> _clear() async {
    ref.read(tokenManagerProvider).clear();
    await ref.read(secureStoreProvider).delete(SecureStore.sessionToken);
  }
}

final sessionProvider = AsyncNotifierProvider<SessionController, Session?>(SessionController.new);

/// The signed-in session, or null (also while loading).
final currentSessionProvider = Provider<Session?>((ref) => ref.watch(sessionProvider).value);

/// rider | driver. Null until chosen (people with both roles choose; everyone else is decided).
class ModeController extends Notifier<AppMode?> {
  static const _key = 'mode';
  @override
  AppMode? build() {
    final saved = ref.watch(prefsProvider).getString(_key);
    return AppMode.values.where((m) => m.name == saved).firstOrNull;
  }

  Future<void> set(AppMode mode) async {
    state = mode;
    await ref.read(prefsProvider).setString(_key, mode.name);
  }

  Future<void> clear() async {
    state = null;
    await ref.read(prefsProvider).remove(_key);
  }
}

final modeProvider = NotifierProvider<ModeController, AppMode?>(ModeController.new);

/// The mode in force: the chosen one, or the only one the roles allow.
final effectiveModeProvider = Provider<AppMode?>((ref) {
  final chosen = ref.watch(modeProvider);
  final s = ref.watch(currentSessionProvider);
  if (s == null) return null;
  if (chosen != null) return chosen;
  return s.canDrive ? null : AppMode.rider;
});
