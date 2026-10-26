// Push notifications (FCM through notification-service). Initialised only when the FIREBASE_*
// defines are set and the platform is Android/iOS; otherwise every call is a no-op. The device
// token is registered after sign-in and on refresh, and removed on sign-out. Taps route by the
// payload's `type` (services/notification-service/src/notify/templates.ts).

import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../config/env.dart';
import '../network/providers.dart';
import '../session/session_controller.dart';

@immutable
class PushTap {
  const PushTap({required this.type, required this.data});
  final String type;
  final Map<String, String> data;
}

class PushService {
  PushService({required this.ref});
  final Ref ref;
  bool _ready = false;
  String? _registered;
  final _taps = StreamController<PushTap>.broadcast();
  final _foreground = StreamController<RemoteMessage>.broadcast();
  Stream<PushTap> get taps => _taps.stream;
  Stream<RemoteMessage> get foreground => _foreground.stream;

  bool get supported => !kIsWeb && (defaultTargetPlatform == TargetPlatform.android || defaultTargetPlatform == TargetPlatform.iOS) && Env.firebaseConfigured;

  Future<void> init() async {
    if (!supported) return;
    try {
      await Firebase.initializeApp(options: FirebaseOptions(apiKey: Env.firebaseApiKey, appId: Env.firebaseAppId, messagingSenderId: Env.firebaseSenderId, projectId: Env.firebaseProjectId));
      final m = FirebaseMessaging.instance;
      await m.requestPermission();
      FirebaseMessaging.onMessage.listen(_foreground.add);
      FirebaseMessaging.onMessageOpenedApp.listen(_tapped);
      final initial = await m.getInitialMessage();
      if (initial != null) _tapped(initial);
      // notification-service sends to FCM registration tokens (messages:send `token`), not the
      // installation IDs of the newer register()/onRegistered API.
      // ignore: deprecated_member_use
      m.onTokenRefresh.listen((t) => _register(t));
      _ready = true;
    } catch (e) {
      debugPrint('push unavailable: $e');
    }
  }

  void _tapped(RemoteMessage msg) {
    final type = msg.data['type']?.toString() ?? '';
    _taps.add(PushTap(type: type, data: {for (final e in msg.data.entries) e.key: e.value.toString()}));
  }

  /// After sign-in: register this device for the signed-in person.
  Future<void> registerForCurrentUser() async {
    if (!_ready) return;
    try {
      // ignore: deprecated_member_use
      final t = await FirebaseMessaging.instance.getToken();
      if (t != null) await _register(t);
    } catch (_) {}
  }

  Future<void> _register(String token) async {
    if (token == _registered || ref.read(currentSessionProvider) == null) return;
    try {
      await ref.read(apisProvider).notifications.registerDevice(token, defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android');
      _registered = token;
    } catch (_) {}
  }

  /// Before sign-out: this device stops receiving the person's notifications.
  Future<void> unregister() async {
    final t = _registered;
    if (t == null) return;
    _registered = null;
    try {
      await ref.read(apisProvider).notifications.removeDevice(t);
    } catch (_) {}
  }
}

final pushServiceProvider = Provider<PushService>((ref) {
  final p = PushService(ref: ref);
  ref.listen<Session?>(currentSessionProvider, (prev, next) {
    if (next != null && prev?.userId != next.userId) p.registerForCurrentUser();
  });
  return p;
});
