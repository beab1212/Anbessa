// Where the session token lives: the platform keychain/keystore. On Linux desktop the keyring
// may be missing; a debug build then falls back to shared preferences with a warning, so the app
// can be developed here. Non-secret preferences (mode, locale, last vehicle) use shared_preferences.
//
// iOS: keychain items are `first_unlock_this_device`: readable after the first unlock (background
// refresh works) and never copied to iCloud/another device by a backup restore. Items written by
// older builds used the plugin default (`unlocked`, which migrates to a new phone); they are moved
// over on first read, so nobody is signed out by the update.

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
  PlatformSecureStore({FlutterSecureStorage? storage}) : _storage = storage ?? const FlutterSecureStorage(iOptions: iosOptions);
  final FlutterSecureStorage _storage;
  bool _fallback = false;

  /// This device only, after the first unlock.
  static const iosOptions = IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device);

  /// What builds before the change wrote with (the plugin default, `unlocked`).
  static const legacyIosOptions = IOSOptions();

  static bool get _isApple => !kIsWeb && (defaultTargetPlatform == TargetPlatform.iOS || defaultTargetPlatform == TargetPlatform.macOS);

  Future<SharedPreferences> get _prefs => SharedPreferences.getInstance();

  @override
  Future<String?> read(String key) async {
    if (_fallback) return (await _prefs).getString('insecure_$key');
    try {
      final value = await _storage.read(key: key, iOptions: iosOptions);
      if (value != null || !_isApple) return value;
      return await _migrateLegacy(key);
    } catch (e) {
      _useFallback(e);
      return (await _prefs).getString('insecure_$key');
    }
  }

  @override
  Future<void> write(String key, String value) async {
    if (_fallback) return (await _prefs).setString('insecure_$key', value).then((_) {});
    try {
      await _writeApple(key, value);
    } catch (e) {
      _useFallback(e);
      await (await _prefs).setString('insecure_$key', value);
    }
  }

  @override
  Future<void> delete(String key) async {
    try {
      await _storage.delete(key: key, iOptions: iosOptions);
      if (_isApple) await _storage.delete(key: key, iOptions: legacyIosOptions);
    } catch (_) {}
    await (await _prefs).remove('insecure_$key');
  }

  /// A write while an older build's item still exists can collide with it (same key, other
  /// accessibility): drop the old one and write again.
  Future<void> _writeApple(String key, String value) async {
    try {
      await _storage.write(key: key, value: value, iOptions: iosOptions);
    } catch (_) {
      if (!_isApple) rethrow;
      await _storage.delete(key: key, iOptions: legacyIosOptions);
      await _storage.write(key: key, value: value, iOptions: iosOptions);
    }
  }

  /// An item from an older build (accessibility `unlocked`): re-save it as this-device-only. The
  /// keychain treats accessibility as an attribute, not part of the key, so the old item is
  /// removed before the new one is added.
  Future<String?> _migrateLegacy(String key) async {
    final old = await _storage.read(key: key, iOptions: legacyIosOptions);
    if (old == null) return null;
    await _storage.delete(key: key, iOptions: legacyIosOptions);
    await _writeApple(key, old);
    return old;
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
