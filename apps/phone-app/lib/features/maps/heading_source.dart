// Which way the car points when GPS can't tell (standing still): the phone's compass, tilt
// compensated and low-pass filtered. Only on phones; Linux has no sensors.

import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sensors_plus/sensors_plus.dart';

bool get compassSupported => !kIsWeb && (defaultTargetPlatform == TargetPlatform.android || defaultTargetPlatform == TargetPlatform.iOS);

/// Compass heading in degrees, or null where there's no compass.
final compassHeadingProvider = StreamProvider<double?>((ref) {
  if (!compassSupported) return Stream.value(null);
  final ctrl = StreamController<double?>();
  double ax = 0, ay = 0, az = 1;
  double? smoothed;
  final accSub = accelerometerEventStream(samplingPeriod: SensorInterval.uiInterval).listen((e) {
    ax = e.x;
    ay = e.y;
    az = e.z;
  }, onError: (_) {});
  final magSub = magnetometerEventStream(samplingPeriod: SensorInterval.uiInterval).listen((m) {
    // tilt compensation (Android sensor frame: x right, y up, z out of the screen)
    final norm = sqrt(ax * ax + ay * ay + az * az);
    if (norm == 0) return;
    final gx = ax / norm, gy = ay / norm, gz = az / norm;
    final pitch = asin(-gx);
    final roll = atan2(gy, gz);
    final mx = m.x * cos(pitch) + m.z * sin(pitch);
    final my = m.x * sin(roll) * sin(pitch) + m.y * cos(roll) - m.z * sin(roll) * cos(pitch);
    var heading = (atan2(-my, mx) * 180 / pi + 360) % 360;
    if (smoothed != null) {
      // shortest-arc low-pass
      var d = (heading - smoothed!) % 360;
      if (d > 180) d -= 360;
      heading = (smoothed! + d * 0.15 + 360) % 360;
    }
    smoothed = heading;
    if (!ctrl.isClosed) ctrl.add(heading);
  }, onError: (_) {});
  ref.onDispose(() {
    accSub.cancel();
    magSub.cancel();
    ctrl.close();
  });
  return ctrl.stream;
});
