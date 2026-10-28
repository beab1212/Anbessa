// Where positions come from. GeolocatorSource is the phone's GPS (with Android's foreground
// service while a driver is online, so pings continue with the screen off). FakeLocationSource is
// for Linux desktop and tests: a position you steer from the debug panel, which can also "drive"
// towards a point at a speed so the arrival geofence and live tracking can be exercised.

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../config/env.dart';
import '../state.dart';

@immutable
class DevicePosition {
  const DevicePosition({required this.lat, required this.lng, this.heading, this.speed, this.accuracy, required this.at});
  final double lat;
  final double lng;
  final double? heading;
  /// m/s
  final double? speed;
  final double? accuracy;
  final DateTime at;
  LocationPing toPing() => LocationPing(lat: lat, lng: lng, heading: heading, speed: speed, accuracy: accuracy, at: at.millisecondsSinceEpoch);
}

/// How often and how precisely: a rider picking a pickup vs a driver online.
enum LocationProfile { once, rider, driverOnline }

enum LocationPermissionState { granted, denied, deniedForever, serviceOff }

abstract class LocationSource {
  Stream<DevicePosition> watch(LocationProfile profile);
  Future<DevicePosition?> current();
  Future<LocationPermissionState> ensurePermission(LocationProfile profile);
  Future<void> openSettings();
}

class GeolocatorSource implements LocationSource {
  /// Asked once per run before the system's location prompt (the "Enable Location" dialog, set
  /// by the app); false ("Maybe later") skips the system prompt that time.
  static Future<bool> Function()? rationale;
  static bool _rationaleShown = false;

  @override
  Future<LocationPermissionState> ensurePermission(LocationProfile profile) async {
    if (!await Geolocator.isLocationServiceEnabled()) return LocationPermissionState.serviceOff;
    var p = await Geolocator.checkPermission();
    if (p == LocationPermission.denied && rationale != null && !_rationaleShown) {
      _rationaleShown = true;
      if (!await rationale!()) return LocationPermissionState.denied;
    }
    if (p == LocationPermission.denied) p = await Geolocator.requestPermission();
    return switch (p) {
      LocationPermission.always || LocationPermission.whileInUse => LocationPermissionState.granted,
      LocationPermission.deniedForever => LocationPermissionState.deniedForever,
      _ => LocationPermissionState.denied,
    };
  }

  LocationSettings _settings(LocationProfile profile) {
    if (defaultTargetPlatform == TargetPlatform.android && profile == LocationProfile.driverOnline) {
      return AndroidSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: 0,
        intervalDuration: const Duration(seconds: 4),
        // keeps the process alive with the screen off (workflow 04): a "location" foreground service
        foregroundNotificationConfig: const ForegroundNotificationConfig(
          notificationTitle: 'Anbessa is online',
          notificationText: 'Sharing your location with riders while you drive',
          enableWakeLock: true,
          notificationIcon: AndroidResource(name: 'ic_launcher', defType: 'mipmap'),
        ),
      );
    }
    if (defaultTargetPlatform == TargetPlatform.iOS && profile == LocationProfile.driverOnline) {
      return AppleSettings(accuracy: LocationAccuracy.best, distanceFilter: 0, activityType: ActivityType.automotiveNavigation, showBackgroundLocationIndicator: true, allowBackgroundLocationUpdates: true);
    }
    return LocationSettings(accuracy: profile == LocationProfile.once ? LocationAccuracy.high : LocationAccuracy.best, distanceFilter: profile == LocationProfile.rider ? 10 : 0);
  }

  static DevicePosition _of(Position p) => DevicePosition(lat: p.latitude, lng: p.longitude, heading: p.heading.isNaN || p.heading < 0 ? null : p.heading, speed: p.speed.isNaN ? null : p.speed, accuracy: p.accuracy.isNaN ? null : p.accuracy, at: p.timestamp.toUtc());

  @override
  Stream<DevicePosition> watch(LocationProfile profile) => Geolocator.getPositionStream(locationSettings: _settings(profile)).map(_of);

  @override
  Future<DevicePosition?> current() async {
    try {
      return _of(await Geolocator.getCurrentPosition(locationSettings: _settings(LocationProfile.once)).timeout(const Duration(seconds: 12)));
    } catch (_) {
      final last = await Geolocator.getLastKnownPosition();
      return last == null ? null : _of(last);
    }
  }

  @override
  Future<void> openSettings() => Geolocator.openAppSettings();
}

/// A position you control. Default: Meskel Square.
class FakeLocationSource implements LocationSource {
  // ignore: prefer_initializing_formals
  FakeLocationSource({double lat = 9.0107, double lng = 38.7613}) : _lat = lat, _lng = lng;
  double _lat;
  double _lng;
  double? _heading;
  double _speed = 0;
  Timer? _drive;
  final _ctrl = StreamController<DevicePosition>.broadcast();

  DevicePosition get position => DevicePosition(lat: _lat, lng: _lng, heading: _heading, speed: _speed, accuracy: 5, at: DateTime.now().toUtc());

  void set(double lat, double lng) {
    _drive?.cancel();
    _heading = bearingDegrees(_lat, _lng, lat, lng);
    _lat = lat;
    _lng = lng;
    _speed = 0;
    _ctrl.add(position);
  }

  /// Move towards a point at [speedKmh], one step a second, then stop there.
  void driveTo(double lat, double lng, {double speedKmh = 40}) {
    _drive?.cancel();
    final mps = speedKmh / 3.6;
    _drive = Timer.periodic(const Duration(seconds: 1), (t) {
      final d = haversineMeters(_lat, _lng, lat, lng);
      _heading = bearingDegrees(_lat, _lng, lat, lng);
      if (d <= mps) {
        _lat = lat;
        _lng = lng;
        _speed = 0;
        t.cancel();
      } else {
        final f = mps / d;
        _lat += (lat - _lat) * f;
        _lng += (lng - _lng) * f;
        _speed = mps;
      }
      _ctrl.add(position);
    });
  }

  @override
  Stream<DevicePosition> watch(LocationProfile profile) async* {
    yield position;
    yield* _ctrl.stream;
  }

  @override
  Future<DevicePosition?> current() async => position;
  @override
  Future<LocationPermissionState> ensurePermission(LocationProfile profile) async => LocationPermissionState.granted;
  @override
  Future<void> openSettings() async {}
  void dispose() {
    _drive?.cancel();
    _ctrl.close();
  }
}

final locationSourceProvider = Provider<LocationSource>((ref) {
  if (Env.fakeLocationOn) {
    final f = FakeLocationSource();
    ref.onDispose(f.dispose);
    return f;
  }
  return GeolocatorSource();
});

/// The last position the app saw (any profile), for centring maps.
final lastPositionProvider = valueProvider<DevicePosition?>(null);

/// Distance in metres between two points, for geofences in the UI.
double metersBetween(DevicePosition a, double lat, double lng) => haversineMeters(a.lat, a.lng, lat, lng);

double clampLat(double v) => math.max(-90, math.min(90, v));
