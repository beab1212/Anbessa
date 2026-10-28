// CameraDirector decisions, with a fake camera: gestures free the camera, fits happen only on
// explicit calls or when the insets settle, follow moves chain at the sample rate, navigation
// zooms by speed.

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/features/maps/marker_animator.dart';
import 'package:phone_app/features/maps/scene/camera_director.dart';
import 'package:ride_app_core/ride_app_core.dart';

class _Move {
  _Move(this.kind, {this.center, this.zoom, this.bearing, this.pitch, this.padding, this.duration, this.points});
  final String kind;
  final GeoPoint? center;
  final double? zoom;
  final double? bearing;
  final double? pitch;
  final EdgeInsets? padding;
  final Duration? duration;
  final List<GeoPoint>? points;
}

class FakePort implements CameraPort {
  final moves = <_Move>[];
  @override
  Size? get viewport => const Size(360, 720);
  @override
  double get bearing => 0;
  CameraView? view;
  @override
  CameraView? get current => view;
  @override
  bool get followsEveryFrame => false;
  @override
  Future<void> moveTo({required GeoPoint center, required double zoom, required double bearing, required double pitch, required EdgeInsets padding, required Duration duration}) async =>
      moves.add(_Move('move', center: center, zoom: zoom, bearing: bearing, pitch: pitch, padding: padding, duration: duration));
  @override
  Future<void> fit(List<GeoPoint> points, {required EdgeInsets padding, required double bearing, required double pitch, required Duration duration, double maxZoom = 17, double singleZoom = 15}) async =>
      moves.add(_Move('fit', points: points, padding: padding, pitch: pitch, duration: duration));
}

AnimatedPose pose(double lat, {double heading = 0, double speed = 0}) => AnimatedPose(lat: lat, lng: 38.76, heading: heading, stale: false, speed: speed);

void main() {
  late FakePort port;
  late DateTime now;
  late CameraDirector d;
  late ValueNotifier<AnimatedPose?> subject;

  setUp(() {
    port = FakePort();
    now = DateTime.utc(2026, 10, 27, 9);
    d = CameraDirector(port: port, now: () => now);
    subject = ValueNotifier(pose(9.01));
  });
  tearDown(() => d.dispose());

  const pts = [(lat: 9.01, lng: 38.76), (lat: 9.02, lng: 38.77)];

  testWidgets('overview fits once per explicit call, not when the points it was given move', (tester) async {
    d.overview(pts);
    expect(port.moves.map((m) => m.kind), ['fit']);
    expect(d.mode, CameraModeKind.overview);
    // nothing else asks for a fit: no more moves however long we wait
    await tester.pump(const Duration(seconds: 5));
    expect(port.moves, hasLength(1));
  });

  testWidgets('a gesture frees the camera, shows recenter, and stops refits; recenter fits again', (tester) async {
    d.overview(pts);
    d.onUserGesture();
    expect(d.mode, CameraModeKind.free);
    expect(d.showRecenter.value, isTrue);
    // the sheet moves: no refit while free
    d.setInsets(const EdgeInsets.only(bottom: 300));
    await tester.pump(const Duration(seconds: 1));
    expect(port.moves, hasLength(1));
    // a non-forced overview (a route refresh) keeps the person's camera
    d.overview(pts, force: false);
    expect(port.moves, hasLength(1));
    expect(d.mode, CameraModeKind.free);
    d.recenter();
    expect(d.mode, CameraModeKind.overview);
    expect(d.showRecenter.value, isFalse);
    expect(port.moves.last.kind, 'fit');
    expect(port.moves.last.padding!.bottom, 300 + 32);
  });

  testWidgets('a forced overview (a new stage) wins over a gesture', (tester) async {
    d.follow(subject);
    d.onUserGesture();
    d.overview(pts);
    expect(d.mode, CameraModeKind.overview);
    expect(d.showRecenter.value, isFalse);
    expect(port.moves.last.kind, 'fit');
  });

  testWidgets('insets refit only once they have settled', (tester) async {
    d.overview(pts);
    for (var h = 100.0; h <= 300; h += 20) {
      d.setInsets(EdgeInsets.only(bottom: h));
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(port.moves, hasLength(1));
    await tester.pump(const Duration(milliseconds: 300));
    expect(port.moves, hasLength(2));
    expect(port.moves.last.padding!.bottom, 300 + 32);
  });

  testWidgets('follow moves on new samples, chained at the cadence with the sample gap as duration', (tester) async {
    d.follow(subject, zoom: 15);
    expect(port.moves.single.kind, 'move');
    expect(port.moves.single.zoom, 15);
    expect(port.moves.single.bearing, 0);
    // samples every 16 ms (an animator): moves go out at most every 300 ms
    for (var i = 1; i <= 30; i++) {
      now = now.add(const Duration(milliseconds: 16));
      subject.value = pose(9.01 + i * 1e-5);
      await tester.pump(const Duration(milliseconds: 16));
    }
    final follows = port.moves.skip(1).toList();
    expect(follows.length, inInclusiveRange(1, 2));
    for (final m in follows) {
      expect(m.duration!.inMilliseconds, inInclusiveRange(300, 1000));
    }
    // the trailing move carries the latest pose
    await tester.pump(const Duration(milliseconds: 400));
    expect(port.moves.last.center!.lat, closeTo(9.01 + 30 * 1e-5, 1e-9));
  });

  testWidgets('a slow subject (one fix every 4 s) gets 1 s moves', (tester) async {
    d.follow(subject);
    now = now.add(const Duration(seconds: 4));
    subject.value = pose(9.011);
    expect(port.moves.last.duration, const Duration(seconds: 1));
  });

  testWidgets('a gesture stops following; recenter follows again', (tester) async {
    d.follow(subject);
    d.onUserGesture();
    final n = port.moves.length;
    now = now.add(const Duration(seconds: 1));
    subject.value = pose(9.02);
    await tester.pump(const Duration(seconds: 1));
    expect(port.moves, hasLength(n));
    d.recenter();
    expect(d.mode, CameraModeKind.follow);
    expect(port.moves.last.center!.lat, 9.02);
  });

  testWidgets('navigate: turned with the car, tilted, car in the lower third, zoom by speed', (tester) async {
    d.setInsets(const EdgeInsets.only(top: 120, bottom: 240));
    d.setLook(basePitch: 0, threeD: false);
    subject.value = pose(9.01, heading: 75, speed: 3);
    d.navigate(subject);
    final m = port.moves.last;
    expect(m.bearing, 75);
    expect(m.pitch, 45);
    expect(m.zoom, 17.5);
    // free height 720 - 120 - 240 = 360; the padded area starts a third of the way down
    expect(m.padding!.top, 120 + 120);
    expect(m.padding!.bottom, 240);
    d.setLook(basePitch: 55, threeD: true);
    expect(port.moves.last.pitch, 55);
    await tester.pump(const Duration(seconds: 1));
  });

  test('zoom by speed', () {
    expect(navZoomForSpeed(0), 17.5);
    expect(navZoomForSpeed(20 / 3.6), 17.5);
    expect(navZoomForSpeed(50 / 3.6), closeTo(16.5, 1e-9));
    expect(navZoomForSpeed(80 / 3.6), 15.5);
    expect(navZoomForSpeed(120 / 3.6), 15.5);
  });

  test('navigation zoom is smoothed towards the speed zoom', () {
    final dd = CameraDirector(port: FakePort());
    expect(dd.navZoom(0), 17.5);
    final z = dd.navZoom(100 / 3.6);
    expect(z, lessThan(17.5));
    expect(z, greaterThan(15.5));
    dd.dispose();
  });

  test('fit zoom for points', () {
    // ~1.1 km apart north-south on a 360 × 720 map: zoom about 15–16
    final z = fitZoomFor(const [(lat: 9.0, lng: 38.76), (lat: 9.01, lng: 38.76)], const Size(360, 720), EdgeInsets.zero);
    expect(z, inInclusiveRange(15, 16.5));
    // the same building: far past the cap
    expect(fitZoomFor(const [(lat: 9.0, lng: 38.76), (lat: 9.00001, lng: 38.76)], const Size(360, 720), EdgeInsets.zero), greaterThan(17));
    expect(fitZoomFor(const [(lat: 9.0, lng: 38.76)], const Size(360, 720), EdgeInsets.zero), double.infinity);
  });

  test('follow move duration is the sample gap, 300–1000 ms', () {
    expect(followMoveDuration(const Duration(milliseconds: 16)), const Duration(milliseconds: 300));
    expect(followMoveDuration(const Duration(milliseconds: 650)), const Duration(milliseconds: 650));
    expect(followMoveDuration(const Duration(seconds: 4)), const Duration(seconds: 1));
  });

  group('frame by frame (an animated car)', () {
    testWidgets('every frame of the car moves the camera exactly onto it, at once', (tester) async {
      d.follow(subject, zoom: 17, animate: false, everyFrame: true);
      port.moves.clear();
      for (var i = 1; i <= 5; i++) {
        now = now.add(const Duration(milliseconds: 16));
        subject.value = pose(9.01 + i * 1e-5);
        final m = port.moves.last;
        expect(m.duration, Duration.zero);
        expect(m.center!.lat, closeTo(9.01 + i * 1e-5, 1e-12));
        expect(m.zoom, 17);
      }
      // no cadence, no trailing timers: one move per frame
      expect(port.moves.length, 5);
    });

    testWidgets('entering it blends from where the camera was, then sits on the car', (tester) async {
      port.view = (center: (lat: 9.0, lng: 38.76), zoom: 13, bearing: 0, pitch: 0);
      d.follow(subject, zoom: 17, everyFrame: true);
      now = now.add(d.transition ~/ 2);
      subject.value = pose(9.0100001);
      final half = port.moves.last;
      expect(half.duration, Duration.zero);
      expect(half.center!.lat, closeTo(9.005, 1e-3));
      expect(half.zoom, closeTo(15, 0.01));
      now = now.add(d.transition);
      subject.value = pose(9.0101);
      expect(port.moves.last.center!.lat, closeTo(9.0101, 1e-12));
      expect(port.moves.last.zoom, 17);
    });

    testWidgets('navigation: the zoom follows the speed over time, not per frame', (tester) async {
      d.navigate(subject, animate: false, everyFrame: true);
      subject.value = pose(9.0100001, speed: 0);
      expect(port.moves.last.zoom, closeTo(17.5, 1e-9));
      // suddenly fast: one frame later the zoom has hardly moved
      now = now.add(const Duration(milliseconds: 16));
      subject.value = pose(9.0101, speed: 25);
      expect(port.moves.last.zoom, greaterThan(17.48));
      // seconds later it has settled near the speed's zoom
      for (var i = 0; i < 600; i++) {
        now = now.add(const Duration(milliseconds: 16));
        subject.value = pose(9.0102 + i * 1e-6, speed: 25);
      }
      expect(port.moves.last.zoom, closeTo(navZoomForSpeed(25), 0.05));
    });

    testWidgets('a gesture stops it', (tester) async {
      d.follow(subject, animate: false, everyFrame: true);
      d.onUserGesture();
      port.moves.clear();
      subject.value = pose(9.02);
      expect(port.moves, isEmpty);
    });
  });
}
