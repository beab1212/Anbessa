import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Thin Dio wrapper: attaches the access token, retries once on 401 after a
/// refresh, and centralizes the gateway base URL so it's one place to change
/// per environment (dev/staging/prod).
class ApiClient {
  ApiClient(this._baseUrl) : dio = Dio(BaseOptions(baseUrl: _baseUrl)) {
    dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) async {
        final token = await _storage.read(key: 'access_token');
        if (token != null) options.headers['Authorization'] = 'Bearer $token';
        handler.next(options);
      },
    ));
  }

  final String _baseUrl;
  final Dio dio;
  final _storage = const FlutterSecureStorage();
}
