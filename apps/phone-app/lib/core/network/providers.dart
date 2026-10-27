// The object graph: environment, storage, the API client and typed APIs, the token manager.
// Everything else reads these; tests override them with fakes.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';
import '../config/env.dart';
import '../session/secure_store.dart';
import '../session/session_controller.dart';
import '../session/token_manager.dart';

final secureStoreProvider = Provider<SecureStore>((ref) => PlatformSecureStore());

/// Resolved once at boot (main.dart) and injected, so reads are synchronous.
final prefsProvider = Provider<SharedPreferences>((ref) => throw UnimplementedError('prefsProvider is overridden at boot'));

final endpointsProvider = Provider<ApiEndpoints>((ref) => Env.endpoints);

const _uuid = Uuid();
String newIdempotencyKey() => _uuid.v4();

final tokenManagerProvider = Provider<TokenManager>((ref) {
  final store = ref.watch(secureStoreProvider);
  Future<String?> session() => store.read(SecureStore.sessionToken);
  // the token manager mints JWTs with the session bearer, so its own client carries no JWT source
  final plain = ApiClient(endpoints: ref.watch(endpointsProvider), sessionToken: session, newId: newIdempotencyKey);
  ref.onDispose(plain.dio.close);
  return TokenManager(auth: AuthApi(plain), sessionToken: session, onEnded: (cause) => ref.read(sessionProvider.notifier).sessionEnded(cause));
});

final apiClientProvider = Provider<ApiClient>((ref) {
  final store = ref.watch(secureStoreProvider);
  return ApiClient(endpoints: ref.watch(endpointsProvider), tokens: ref.watch(tokenManagerProvider), sessionToken: () => store.read(SecureStore.sessionToken), newId: newIdempotencyKey);
});

final apisProvider = Provider<Apis>((ref) => Apis(ref.watch(apiClientProvider)));
final authApiProvider = Provider<AuthApi>((ref) => AuthApi(ref.watch(apiClientProvider)));
final identityApiProvider = Provider<IdentityApi>((ref) => IdentityApi(ref.watch(apiClientProvider)));
final organizationsApiProvider = Provider<OrganizationsApi>((ref) => OrganizationsApi(ref.watch(apiClientProvider)));
