// Which way a car on the map faces, and how it turns. Pure Dart (no ticker), unit tested.
//
// A car's direction is its actual travel heading:
//   1. the phone's GPS heading, but only while the car is really moving (a phone standing still
//      reports 0 = north, or whatever its last fix said, so a parked car would point north and
//      back every few seconds);
//   2. else the bearing of its movement between real samples at least [HeadingFilter.minMoveMeters]
//      apart (closer fixes are GPS jitter: their bearing is noise);
//   3. else the road's bearing where the car is snapped onto it, when it has one;
//   4. else the last heading, held: a parked or creeping car keeps facing where it faced.
//
// The drawn heading then turns to the new one the short way round (350° → 10° turns 20°, never
// 340°) over a short ease ([HeadingEaser]), only when the heading actually changes. The map turns
// the icon with itself (`icon-rotation-alignment: map`), so moving the camera never turns a car.

import 'dart:math';

import 'package:ride_app_core/ride_app_core.dart';

/// The signed shortest turn from [from] to [to], degrees in (-180, 180].
double shortestTurn(double from, double to) {
  var d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/// [deg] in [0, 360).
double normDeg(double deg) {
  final d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/// Decides a car's heading from its samples (see the file comment).
class HeadingFilter {
  HeadingFilter({this.minMoveMeters = 8, this.movingSpeed = 1.5});

  /// metres between two samples before their bearing counts as movement
  final double minMoveMeters;
  /// m/s; below it the phone's GPS heading is not trusted
  final double movingSpeed;

  double? _heading;
  GeoPoint? _anchor;

  /// The heading decided so far; null before any could be.
  double? get heading => _heading;

  /// Forget everything (a car that jumped far away).
  void reset() {
    _heading = null;
    _anchor = null;
  }

  /// A real sample at [p]: [gpsHeading] in degrees from the phone, [speed] in m/s (measured or
  /// reported; null when unknown), [roadBearing] the road's bearing where the car is snapped.
  /// Returns the heading to show (the last one when this sample says nothing new).
  double? update(GeoPoint p, {double? gpsHeading, double? speed, double? roadBearing}) {
    final anchor = _anchor;
    final moved = anchor == null ? 0.0 : geoDistanceMeters(anchor, p);
    final moving = speed != null && speed >= movingSpeed;
    if (gpsHeading != null && gpsHeading.isFinite && (moving || (anchor == null && speed == null))) {
      // a moving car's own heading; or the very first sample of a car we know nothing about
      _heading = normDeg(gpsHeading);
      _anchor = p;
    } else if (anchor != null && moved >= minMoveMeters && (speed == null || speed > 0.3)) {
      _heading = roadBearing != null ? normDeg(roadBearing) : geoBearing(anchor, p);
      _anchor = p;
    } else if (_heading == null && roadBearing != null) {
      _heading = normDeg(roadBearing);
      _anchor ??= p;
    } else {
      // standing still or jitter: hold; the anchor stays, so slow real movement still adds up
      _anchor ??= p;
    }
    return _heading;
  }
}

/// Turns a drawn heading to a target the short way, easing over [duration] (ease-out cubic).
/// Time is passed in, so tests drive it by hand.
class HeadingEaser {
  HeadingEaser({this.duration = const Duration(milliseconds: 450), this.minTurn = 1.0});

  final Duration duration;
  /// degrees; a smaller change is applied at once (no ease, no ticking for nothing)
  final double minTurn;

  double? _from;
  double? _to;
  DateTime? _start;
  double? _shown;

  /// The heading the turn ends at.
  double? get target => _to;

  /// Turning now (the caller keeps its ticker running).
  bool busyAt(DateTime now) => _start != null && now.difference(_start!) < duration;

  /// Jump to [deg] at once (the first sample, a far jump).
  void snap(double deg) {
    _from = _to = _shown = normDeg(deg);
    _start = null;
  }

  /// Turn towards [deg], starting at [now] from what is shown at [now]. The same target again
  /// changes nothing (a turn in progress goes on).
  void turnTo(double deg, DateTime now) {
    final to = normDeg(deg);
    final shown = valueAt(now);
    if (shown == null) return snap(to);
    if (_to != null && shortestTurn(_to!, to).abs() < 0.05) return;
    if (shortestTurn(shown, to).abs() < minTurn) {
      _from = _to = _shown = to;
      _start = null;
      return;
    }
    _from = shown;
    _to = to;
    _start = now;
  }

  /// The heading drawn at [now].
  double? valueAt(DateTime now) {
    final from = _from, to = _to, start = _start;
    if (to == null || from == null) return _shown;
    if (start == null) return _shown = to;
    final ms = max(1, duration.inMilliseconds);
    final t = (now.difference(start).inMilliseconds / ms).clamp(0.0, 1.0);
    if (t >= 1) {
      _start = null;
      return _shown = to;
    }
    final e = 1 - pow(1 - t, 3).toDouble();
    return _shown = normDeg(from + shortestTurn(from, to) * e);
  }
}
