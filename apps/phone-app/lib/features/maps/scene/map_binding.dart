// Turns what a screen asks of AnbessaMap (follow, fit, insets, the animated car) into
// CameraDirector calls, the same way for both engines. Screens describe intent; the binding
// decides when that intent is new (a different follow mode, a new fitKey, changed points) so a
// rebuild never moves the camera by itself.

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart' show EdgeInsets;
import 'package:latlong2/latlong.dart' show LatLng;
import 'package:ride_app_core/ride_app_core.dart';
import '../anbessa_map.dart';
import '../fit.dart';
import 'camera_director.dart';

class MapBinding {
  MapBinding(CameraPort port, {DateTime Function()? now}) : director = CameraDirector(port: port, now: now);

  final CameraDirector director;

  /// The pose the camera follows (the animated car, the person, or a static car).
  final subject = ValueNotifier<AnimatedPose?>(null);

  AnbessaMap? _w;
  ValueListenable<AnimatedPose?>? _car;
  ValueListenable<double>? _sheet;
  bool _started = false;
  FollowMode? _lastFollow;
  bool _lastFrames = false;
  Object? _lastFitKey;
  List<LatLng> _lastFit = const [];

  /// The bottom inset now (the live sheet height when the screen gives one).
  double bottomOf(AnbessaMap w) => w.sheetHeight?.value ?? w.bottomInset;

  EdgeInsets insetsOf(AnbessaMap w) => EdgeInsets.fromLTRB(w.padding.left, w.topInset, w.padding.right, bottomOf(w));

  /// Apply the widget's intent. [ready]: the engine has a camera to move.
  void sync(AnbessaMap w, {required bool ready}) {
    _w = w;
    if (!identical(w.driverCar, _car)) {
      _car?.removeListener(_onCar);
      _car = w.driverCar;
      _car?.addListener(_onCar);
    }
    if (!identical(w.sheetHeight, _sheet)) {
      _sheet?.removeListener(_onSheet);
      _sheet = w.sheetHeight;
      _sheet?.addListener(_onSheet);
    }
    subject.value = subjectOf(w);
    director.setInsets(insetsOf(w));
    if (!ready) return;
    final first = !_started;
    _started = true;
    final followChanged = first || w.follow != _lastFollow;
    _lastFollow = w.follow;
    final frames = followsAnimatedCar(w);
    final framesChanged = frames != _lastFrames;
    _lastFrames = frames;
    switch (w.follow) {
      case FollowMode.driverBearing:
        if (followChanged || framesChanged) director.navigate(subject, animate: !first, everyFrame: frames);
      case FollowMode.me || FollowMode.driver:
        if (followChanged || framesChanged) director.follow(subject, zoom: w.followZoom, animate: !first, everyFrame: frames);
      case FollowMode.none:
        if (w.fit.isNotEmpty) {
          final keyed = w.fitKey != null;
          final explicit = first || followChanged || (keyed && w.fitKey != _lastFitKey);
          final moved = !keyed && !sameLatLngs(w.fit, _lastFit);
          if (explicit || moved) director.overview(toGeo(w.fit), force: explicit, animate: !first);
        } else if (followChanged && director.mode != CameraModeKind.free) {
          director.free();
        }
    }
    _lastFitKey = w.fitKey;
    _lastFit = List.of(w.fit);
  }

  void _onCar() {
    final w = _w;
    if (w != null) subject.value = subjectOf(w);
  }

  void _onSheet() {
    final w = _w;
    if (w != null) director.setInsets(insetsOf(w));
  }

  /// The recenter control or pill: back to what the camera was doing, and tell the screen.
  void recenter() {
    final w = _w;
    if (director.resumeMode != null) {
      director.recenter();
    } else if (w != null) {
      // nothing interrupted: redo the screen's intent
      switch (w.follow) {
        case FollowMode.driverBearing:
          director.navigate(subject, everyFrame: followsAnimatedCar(w));
        case FollowMode.me || FollowMode.driver:
          director.follow(subject, zoom: w.followZoom, everyFrame: followsAnimatedCar(w));
        case FollowMode.none:
          if (w.fit.isNotEmpty) director.overview(toGeo(w.fit));
      }
    }
    w?.onRecenter?.call();
  }

  void dispose() {
    _car?.removeListener(_onCar);
    _sheet?.removeListener(_onSheet);
    director.dispose();
    subject.dispose();
  }
}

/// The camera follows the animated car ([AnbessaMap.driverCar]), which changes on every frame:
/// the camera then moves with each frame (see CameraDirector).
bool followsAnimatedCar(AnbessaMap w) => w.driverCar != null && switch (w.follow) {
      FollowMode.driver || FollowMode.driverBearing => true,
      FollowMode.me => w.mePoseOrPoint == null,
      FollowMode.none => false,
    };

List<GeoPoint> toGeo(List<LatLng> pts) => [for (final p in pts) (lat: p.latitude, lng: p.longitude)];

/// Who the camera follows for [w]: the person for [FollowMode.me] (falling back to the car when
/// the screen only has the car, as the driver's home does), the car otherwise.
AnimatedPose? subjectOf(AnbessaMap w) {
  AnimatedPose? car() {
    final live = w.driverCar?.value;
    if (live != null) return live;
    final p = w.driverPose;
    if (p != null) return p;
    final d = w.driver;
    return d == null ? null : AnimatedPose(lat: d.position.latitude, lng: d.position.longitude, heading: d.heading ?? 0, stale: d.stale);
  }

  AnimatedPose? me() {
    final m = w.mePoseOrPoint;
    return m == null ? null : AnimatedPose(lat: m.position.latitude, lng: m.position.longitude, heading: m.heading ?? 0, stale: false);
  }

  return switch (w.follow) {
    FollowMode.me => me() ?? car(),
    FollowMode.driver || FollowMode.driverBearing => car(),
    FollowMode.none => null,
  };
}
