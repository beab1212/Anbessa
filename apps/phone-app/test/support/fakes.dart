// Test doubles shared by the app tests: a socket that never dials, notifiers with fixed state,
// and JWTs with chosen claims.

import 'dart:convert';
import 'dart:io';

import 'package:phone_app/core/realtime/realtime_hub.dart';
import 'package:phone_app/core/session/session_controller.dart';
import 'package:phone_app/features/driver/shift/shift_controller.dart';
import 'package:phone_app/features/rider/trip/active_trip_controller.dart';
import 'package:ride_app_core/ride_app_core.dart';

class FakeSocketLink implements SocketLink {
  final handlers = <String, void Function(dynamic)>{};
  final emitted = <(String, dynamic)>[];
  bool _connected = false;
  @override
  void connect(String token) => _connected = true;
  @override
  void disconnect() => _connected = false;
  @override
  bool get connected => _connected;
  @override
  void onConnect(void Function() f) {}
  @override
  void onDisconnect(void Function(dynamic reason) f) {}
  @override
  void onConnectError(void Function(dynamic err) f) {}
  @override
  void onReconnectAttempt(void Function() f) {}
  @override
  void on(String event, void Function(dynamic data) f) => handlers[event] = f;
  @override
  void emitWithAck(String event, dynamic data, void Function(dynamic ack) ack) {
    emitted.add((event, data));
    ack({'ok': true});
  }

  @override
  void setAuthToken(String token) {}
  @override
  void dispose() {}
}

RealtimeHub fakeHub([SocketLink? link]) => RealtimeHub(link: link ?? FakeSocketLink(), token: ({bool force = false}) async => 'jwt', onUnauthorized: () async {}, log: (_) {});

String jwt({String sub = 'u1', List<Map<String, Object?>> roles = const [{'r': 'RIDER'}], required DateTime exp}) {
  String part(Object o) => base64Url.encode(utf8.encode(jsonEncode(o))).replaceAll('=', '');
  return '${part({'alg': 'EdDSA'})}.${part({'sub': sub, 'aud': 'ride-app', 'exp': exp.millisecondsSinceEpoch ~/ 1000, 'pv': 1, 'roles': roles, 'amr': ['otp']})}.sig';
}

Session session({List<Map<String, Object?>> roles = const [{'r': 'RIDER'}]}) => Session(
      claims: Claims.decode(jwt(roles: roles, exp: DateTime.now().toUtc().add(const Duration(minutes: 15)))),
      profile: const Profile(id: 'u1', name: 'Abebe', phone: '+251900000501'),
    );

Json fixture(String name) => asJson(jsonDecode(File('../../packages/core/test/fixtures/$name').readAsStringSync()));

class FixedSession extends SessionController {
  FixedSession(this.value);
  final Session? value;
  @override
  Future<Session?> build() async => value;
}

class FixedMode extends ModeController {
  FixedMode(this.value);
  final AppMode? value;
  @override
  AppMode? build() => value;
}

class FixedActiveTrip extends ActiveTripController {
  FixedActiveTrip(this.value);
  final Trip? value;
  @override
  Future<Trip?> build() async => value;
}

class FixedDriverHome extends DriverHomeController {
  FixedDriverHome(this.value);
  final DriverHome value;
  @override
  Future<DriverHome> build() async => value;
}
