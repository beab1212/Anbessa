import '../../../core/network/api_client.dart';
import '../domain/auth_repository.dart';

class AuthRepositoryImpl implements AuthRepository {
  AuthRepositoryImpl(this._client);
  final ApiClient _client;

  @override
  Future<String> login(String email, String password) async {
    final res = await _client.dio.post('/api/auth/login', data: {'email': email, 'password': password});
    return res.data['accessToken'] as String;
  }
}
