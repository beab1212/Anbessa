// One Socket.io connection to realtime-gateway for the whole app. It connects when someone is
// signed in, refreshes the access token before every (re)connect (the gateway checks it only at
// the handshake), re-joins trip rooms after a reconnect, and turns events into RealtimeEvent.
// Features listen to `events`; the driver streams pings through `sendLocation`.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;
import '../config/env.dart';
import '../network/providers.dart';
import '../session/session_controller.dart';

enum RealtimeState { offline, connecting, connected, reconnecting }

/// The socket behind the hub, so tests can fake it.
abstract class SocketLink {
  void connect(String token);
  void disconnect();
  bool get connected;
  void onConnect(void Function() f);
  void onDisconnect(void Function(dynamic reason) f);
  void onConnectError(void Function(dynamic err) f);
  void onReconnectAttempt(void Function() f);
  void on(String event, void Function(dynamic data) f);
  void emitWithAck(String event, dynamic data, void Function(dynamic ack) ack);
  void setAuthToken(String token);
  void dispose();
}

class SocketIoLink implements SocketLink {
  SocketIoLink(this.url);
  final String url;
  io.Socket? _s;

  // forceNew: socket_io_client caches one manager per URL, which would hand the next signed-in
  // person the previous person's socket
  io.Socket _socket(String token) => _s ??= io.io(
        url,
        io.OptionBuilder().setTransports(['websocket']).disableAutoConnect().enableForceNew().setAuth({'token': token}).setReconnectionDelay(1000).setReconnectionDelayMax(16000).build(),
      );

  final _handlers = <void Function(io.Socket s)>[];

  @override
  void connect(String token) {
    final s = _socket(token);
    s.auth = {'token': token};
    for (final h in _handlers) {
      h(s);
    }
    _handlers.clear();
    s.connect();
  }

  @override
  void disconnect() => _s?.disconnect();
  @override
  bool get connected => _s?.connected ?? false;
  void _register(void Function(io.Socket s) h) {
    final s = _s;
    if (s != null) {
      h(s);
    } else {
      _handlers.add(h);
    }
  }

  @override
  void onConnect(void Function() f) => _register((s) => s.onConnect((_) => f()));
  @override
  void onDisconnect(void Function(dynamic reason) f) => _register((s) => s.onDisconnect(f));
  @override
  void onConnectError(void Function(dynamic err) f) => _register((s) => s.onConnectError(f));
  @override
  void onReconnectAttempt(void Function() f) => _register((s) => s.io.on('reconnect_attempt', (_) => f()));
  @override
  void on(String event, void Function(dynamic data) f) => _register((s) => s.on(event, f));
  @override
  void emitWithAck(String event, dynamic data, void Function(dynamic ack) ack) => _s?.emitWithAck(event, data, ack: ack);
  @override
  void setAuthToken(String token) => _s?.auth = {'token': token};
  @override
  void dispose() {
    _s?.dispose();
    _s = null;
  }
}

class RealtimeHub {
  RealtimeHub({required SocketLink link, required Future<String?> Function({bool force}) token, required Future<void> Function() onUnauthorized, void Function(String)? log})
      : _link = link, // ignore: prefer_initializing_formals
        _token = token, // ignore: prefer_initializing_formals
        _onUnauthorized = onUnauthorized, // ignore: prefer_initializing_formals
        log = log ?? ((m) => debugPrint(m));

  final SocketLink _link;
  final Future<String?> Function({bool force}) _token;
  final Future<void> Function() _onUnauthorized;
  final void Function(String) log;

  final _events = StreamController<RealtimeEvent>.broadcast();
  final _state = StreamController<RealtimeState>.broadcast();
  RealtimeState _current = RealtimeState.offline;
  final _rooms = <String>{};
  int _unauthorized = 0;
  bool _wired = false;
  bool _wanted = false;

  Stream<RealtimeEvent> get events => _events.stream;
  Stream<RealtimeState> get states => _state.stream;
  RealtimeState get state => _current;
  bool get connected => _current == RealtimeState.connected;

  void _set(RealtimeState s) {
    if (s == _current) return;
    _current = s;
    _state.add(s);
  }

  void _wire() {
    if (_wired) return;
    _wired = true;
    _link.onConnect(() {
      _unauthorized = 0;
      _set(RealtimeState.connected);
      for (final id in _rooms.toList()) {
        subscribeTrip(id);
      }
    });
    _link.onDisconnect((reason) => _set(_wanted ? RealtimeState.reconnecting : RealtimeState.offline));
    _link.onReconnectAttempt(() async {
      _set(RealtimeState.reconnecting);
      final t = await _token();
      if (t != null) _link.setAuthToken(t);
    });
    _link.onConnectError((err) async {
      final msg = err.toString();
      if (msg.contains('unauthorized')) {
        _unauthorized++;
        if (_unauthorized >= 3) {
          log('realtime: refused 3 times, signing out');
          await _onUnauthorized();
          return;
        }
        final t = await _token(force: true);
        if (t != null) _link.setAuthToken(t);
      }
    });
    for (final name in realtimeEventNames) {
      _link.on(name, (data) {
        final e = RealtimeEvent.fromSocket(name, data);
        if (e != null) _events.add(e);
      });
    }
  }

  /// Connect (or reconnect) with a fresh token.
  Future<void> connect() async {
    _wanted = true;
    final t = await _token();
    if (t == null) return;
    _wire();
    _set(RealtimeState.connecting);
    _link.connect(t);
  }

  void disconnect() {
    _wanted = false;
    _rooms.clear();
    _link.disconnect();
    _set(RealtimeState.offline);
  }

  /// Join a trip's room for `driver:location` (the rider and driver only). Re-joined on reconnect.
  Future<bool> subscribeTrip(String tripId) {
    _rooms.add(tripId);
    if (!_link.connected) return Future.value(false);
    final c = Completer<bool>();
    _link.emitWithAck('trip:subscribe', tripId, (ack) {
      final j = asJson(ack);
      if (!c.isCompleted) c.complete(readBool(j, 'ok'));
    });
    return c.future.timeout(const Duration(seconds: 5), onTimeout: () => false);
  }

  void unsubscribeTrip(String tripId) {
    _rooms.remove(tripId);
    if (_link.connected) _link.emitWithAck('trip:unsubscribe', tripId, (_) {});
  }

  /// A driver's position; the ack says whether the gateway kept it.
  Future<PingAck> sendLocation(LocationPing ping) {
    if (!_link.connected) return Future.value(const PingAck(accepted: false, reason: 'offline'));
    final c = Completer<PingAck>();
    _link.emitWithAck('location:update', ping.toJson(), (ack) {
      if (!c.isCompleted) c.complete(PingAck.fromJson(ack));
    });
    return c.future.timeout(const Duration(seconds: 3), onTimeout: () => const PingAck(accepted: false, reason: 'timeout'));
  }

  /// Tests and fakes push events here.
  @visibleForTesting
  void inject(RealtimeEvent e) => _events.add(e);

  void dispose() {
    _link.dispose();
    _events.close();
    _state.close();
  }
}

final socketLinkProvider = Provider<SocketLink>((ref) => SocketIoLink(Env.wsUrl));

final realtimeHubProvider = Provider<RealtimeHub>((ref) {
  final hub = RealtimeHub(
    link: ref.watch(socketLinkProvider),
    token: ({bool force = false}) => ref.read(tokenManagerProvider).accessToken(force: force),
    onUnauthorized: () => ref.read(sessionProvider.notifier).sessionEnded(const AppError(status: 401, code: ErrorCodes.sessionEnded, message: 'Your session has ended.')),
  );
  ref.onDispose(hub.dispose);
  // follow the session: connect when signed in, drop when signed out
  ref.listen<Session?>(currentSessionProvider, (prev, next) {
    if (next != null && prev?.userId != next.userId) {
      hub.connect();
    } else if (next == null) {
      hub.disconnect();
    }
  }, fireImmediately: true);
  return hub;
});

final realtimeStateProvider = StreamProvider<RealtimeState>((ref) => ref.watch(realtimeHubProvider).states);
final realtimeEventsProvider = StreamProvider<RealtimeEvent>((ref) => ref.watch(realtimeHubProvider).events);
