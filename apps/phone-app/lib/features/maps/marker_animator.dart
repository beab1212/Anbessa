// Moves a car marker smoothly between GPS samples. Each new sample becomes the target: the shown
// pose glides from where it is to the sample over the time between samples (capped), heading
// turns the short way round, and when the next sample is late the car keeps rolling at its last
// speed for a few seconds before it freezes and is marked stale. A big jump snaps.

import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:ride_app_core/ride_app_core.dart';

@immutable
class AnimatedPose {
  const AnimatedPose({required this.lat, required this.lng, required this.heading, required this.stale});
  final double lat;
  final double lng;
  final double heading;
  final bool stale;
  GeoPoint get point => (lat: lat, lng: lng);
}

class MarkerAnimator extends ChangeNotifier {
  MarkerAnimator({TickerProvider? vsync, DateTime Function()? now, this.maxGlide = const Duration(seconds: 4), this.deadReckonFor = const Duration(seconds: 8), this.snapOverMeters = 300, this.staleAfter = const Duration(seconds: 20)})
      : _now = now ?? DateTime.now {
    if (vsync != null) _ticker = vsync.createTicker(_tick);
  }

  final DateTime Function() _now;
  final Duration maxGlide;
  final Duration deadReckonFor;
  final double snapOverMeters;
  final Duration staleAfter;
  Ticker? _ticker;

  // the pose shown now
  GeoPoint? _shown;
  double _shownHeading = 0;
  // the glide in progress
  GeoPoint? _from;
  double _fromHeading = 0;
  GeoPoint? _to;
  double _toHeading = 0;
  DateTime? _glideStart;
  Duration _glide = Duration.zero;
  // the last sample, for dead reckoning
  DateTime? _sampleAt;
  double _speed = 0;
  bool _hasSample = false;

  AnimatedPose? get pose => _shown == null ? null : AnimatedPose(lat: _shown!.lat, lng: _shown!.lng, heading: _shownHeading, stale: isStale);
  bool get isStale => _sampleAt != null && _now().difference(_sampleAt!) > staleAfter;

  /// A new GPS sample. [heading] in degrees, [speed] in m/s, [at] when the phone measured it.
  void push(GeoPoint p, {double? heading, double? speed, DateTime? at}) {
    final now = _now();
    final sampleAt = at ?? now;
    final prevAt = _sampleAt;
    final h = heading ?? (_shown == null ? _shownHeading : geoBearing(_shown!, p));
    final first = _shown == null;
    final jump = first ? 0.0 : geoDistanceMeters(_shown!, p);
    _speed = speed ?? (prevAt == null || first ? 0 : (geoDistanceMeters(_to ?? _shown!, p) / (sampleAt.difference(prevAt).inMilliseconds.clamp(1, 1 << 30) / 1000)));
    _sampleAt = sampleAt;
    _hasSample = true;
    if (first || jump > snapOverMeters) {
      _shown = p;
      _shownHeading = h;
      _from = _to = p;
      _fromHeading = _toHeading = h;
      _glideStart = null;
      notifyListeners();
      _ensureTicking();
      return;
    }
    // glide from the pose shown now to the sample, over the sample gap (capped)
    final gap = prevAt == null ? maxGlide : sampleAt.difference(prevAt);
    _from = _shown;
    _fromHeading = _shownHeading;
    _to = p;
    _toHeading = h;
    _glide = gap <= Duration.zero ? maxGlide : (gap > maxGlide ? maxGlide : gap);
    _glideStart = now;
    _ensureTicking();
  }

  void _ensureTicking() {
    final t = _ticker;
    if (t != null && !t.isActive) t.start();
  }

  /// Advance to [now] (the ticker calls this; tests call it by hand).
  void advance([DateTime? at]) {
    final now = at ?? _now();
    if (!_hasSample || _to == null) return;
    final start = _glideStart;
    if (start != null) {
      final t = (now.difference(start).inMilliseconds / _glide.inMilliseconds.clamp(1, 1 << 30)).clamp(0.0, 1.0);
      _shown = geoLerp(_from!, _to!, t);
      _shownHeading = lerpAngleDeg(_fromHeading, _toHeading, t);
      if (t >= 1) {
        _glideStart = null;
        _from = _to;
        _fromHeading = _toHeading;
      }
      notifyListeners();
      return;
    }
    // the glide is done: keep rolling at the last speed while the next sample is late
    final since = now.difference(_sampleAt!);
    if (_speed > 0.5 && since > _glide && since <= deadReckonFor + _glide) {
      final extra = (since - _glide).inMilliseconds / 1000 * _speed;
      _shown = geoOffset(_to!, _toHeading, extra);
      notifyListeners();
      return;
    }
    if (since > staleAfter && _ticker != null && _ticker!.isActive) {
      _ticker!.stop();
      notifyListeners();
    }
  }

  void _tick(Duration _) => advance();

  @override
  void dispose() {
    _ticker?.dispose();
    super.dispose();
  }
}
