// Where the session token lives: the platform keychain/keystore. On Linux desktop the keyring
// may be missing; a debug build then falls back to shared preferences with a warning, so the app
// can be developed here. Non-secret preferences (mode, locale, last vehicle) use shared_preferences.

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

abstract class SecureStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);

  static const sessionToken = 'session_token';
}

class PlatformSecureStore implements SecureStore {
  PlatformSecureStore({FlutterSecureStorage? storage}) : _storage = storage ?? const FlutterSecureStorage();
  final FlutterSecureStorage _storage;
  bool _fallback = false;

  Future<SharedPreferences> get _prefs => SharedPreferences.getInstance();

  @override
  Future<String?> read(String key) async {
    if (_fallback) return (await _prefs).getString('insecure_$key');
    try {
      return await _storage.read(key: key);
    } catch (e) {
      _useFallback(e);
      return (await _prefs).getString('insecure_$key');
    }
  }

  @override
  Future<void> write(String key, String value) async {
    if (_fallback) return (await _prefs).setString('insecure_$key', value).then((_) {});
    try {
      await _storage.write(key: key, value: value);
    } catch (e) {
      _useFallback(e);
      await (await _prefs).setString('insecure_$key', value);
    }
  }

  @override
  Future<void> delete(String key) async {
    try {
      await _storage.delete(key: key);
    } catch (_) {}
    await (await _prefs).remove('insecure_$key');
  }

  void _useFallback(Object e) {
    if (!kDebugMode) throw e;
    if (!_fallback) debugPrint('secure storage unavailable ($e): keeping the session in shared preferences (debug build only)');
    _fallback = true;
  }
}

class MemorySecureStore implements SecureStore {
  final Map<String, String> _m = {};
  @override
  Future<String?> read(String key) async => _m[key];
  @override
  Future<void> write(String key, String value) async => _m[key] = value;
  @override
  Future<void> delete(String key) async => _m.remove(key);
}
