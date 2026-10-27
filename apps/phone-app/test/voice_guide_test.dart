// Voice guidance: each prompt at its threshold once (500 m only after a long stretch, 200 m,
// "now"), no repeats after a reroute that keeps the same next turn, a new turn starts over,
// "Rerouting" once per reroute, the arrival once; muted still uses the cues up; Amharic falls
// back to English without an am-ET voice.

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phone_app/core/l10n/generated/app_localizations.dart';
import 'package:phone_app/features/maps/nav/navigation_controller.dart';
import 'package:phone_app/features/maps/nav/voice_guide.dart';
import 'package:phone_app/features/maps/scene/route_track.dart';
import 'package:ride_app_core/ride_app_core.dart';

class FakeTts implements TtsEngine {
  FakeTts({this.voices = const {'en-US'}});
  final Set<String> voices;
  final spoken = <String>[];
  var stops = 0;
  String? language;
  @override
  Future<bool> setLanguage(String languageTag) async {
    if (!voices.contains(languageTag)) return false;
    language = languageTag;
    return true;
  }

  @override
  Future<void> speak(String text) async => spoken.add(text);
  @override
  Future<void> stop() async => stops++;
}

const left = RouteStep(type: 'turn', modifier: 'left', lat: 9.0107, lng: 38.7713, bearingAfter: 0, name: 'Bole Road', distanceMeters: 800, durationSeconds: 80);
const right = RouteStep(type: 'turn', modifier: 'right', lat: 9.0207, lng: 38.7713, bearingAfter: 90, name: '', distanceMeters: 300, durationSeconds: 30);
const depart = RouteStep(type: 'depart', lat: 9.0107, lng: 38.7613, bearingAfter: 90, name: 'Africa Avenue', distanceMeters: 1100, durationSeconds: 110);
final track = RouteTrack(const [(lat: 9.0107, lng: 38.7613), (lat: 9.0107, lng: 38.7713), (lat: 9.0207, lng: 38.7713)]);

/// The car [d] metres before the left turn (1100 m along the route).
NavState at(int d, {int version = 1, bool rerouting = false, bool offRoute = false, bool arrived = false, List<RouteStep> steps = const [depart, left, right], int index = 1}) => NavState(
      track: track,
      routeVersion: version,
      steps: steps,
      stepAlong: steps.length == 3 ? const [0, 1100, 2200] : const [0, 1100],
      progressMeters: 1100.0 - d,
      stepIndex: index,
      metersToManeuver: d,
      rerouting: rerouting,
      offRoute: offRoute,
      arrived: arrived,
      loading: false,
    );

void main() {
  final en = lookupAppLocalizations(const Locale('en'));

  test('each threshold speaks once, in order, as the car closes in', () {
    final s = VoiceScheduler();
    final said = <VoiceCueKind>[];
    for (var d = 1000; d >= 0; d -= 20) {
      final cue = s.onState(at(d));
      if (cue != null) said.add(cue.kind);
    }
    expect(said, [VoiceCueKind.far, VoiceCueKind.mid, VoiceCueKind.now]);
  });

  test('the 500 m prompt only after a long enough stretch', () {
    final s = VoiceScheduler();
    // the left turn comes 400 m after the previous maneuver
    NavState short(int d) => NavState(track: track, routeVersion: 1, steps: const [depart, left], stepAlong: const [700, 1100], progressMeters: 1100.0 - d, stepIndex: 1, metersToManeuver: d, loading: false);
    final said = [for (var d = 400; d >= 0; d -= 20) s.onState(short(d))?.kind].nonNulls.toList();
    expect(said, [VoiceCueKind.mid, VoiceCueKind.now]);
  });

  test('at speed, "now" comes earlier; a skipped band is not said late', () {
    final s = VoiceScheduler();
    // fixes 4 s apart at 20 m/s: 260 → 180 → 100 → 20 m
    final said = [for (final d in [260, 180, 100, 20]) s.onState(at(d), speed: 20)?.kind].nonNulls.toList();
    expect(said, [VoiceCueKind.mid, VoiceCueKind.now]);
    // a jump straight inside "now" says only "now"
    final s2 = VoiceScheduler();
    expect(s2.onState(at(600))?.kind, isNull);
    expect(s2.onState(at(25))?.kind, VoiceCueKind.now);
    expect(s2.onState(at(150)), isNull, reason: 'not the 200 m prompt after "now"');
  });

  test('a reroute says "Rerouting" once and does not repeat prompts for the same turn', () {
    final s = VoiceScheduler();
    expect(s.onState(at(190))?.kind, VoiceCueKind.mid);
    expect(s.onState(at(180, rerouting: true))?.kind, VoiceCueKind.rerouting);
    expect(s.onState(at(175, rerouting: true)), isNull);
    // the new route has the same left turn next: its 200 m prompt was said already
    expect(s.onState(at(170, version: 2)), isNull);
    expect(s.onState(at(20, version: 2))?.kind, VoiceCueKind.now);
    // a second reroute speaks "Rerouting" again
    expect(s.onState(at(15, version: 2, rerouting: true))?.kind, VoiceCueKind.rerouting);
  });

  test('a new next turn starts over; off the route stays quiet; the arrival once', () {
    final s = VoiceScheduler();
    expect(s.onState(at(190))?.kind, VoiceCueKind.mid);
    // the right turn is next
    NavState next(int d) => NavState(track: track, routeVersion: 1, steps: const [depart, left, right], stepAlong: const [0, 1100, 2200], progressMeters: 2200.0 - d, stepIndex: 2, metersToManeuver: d, loading: false);
    expect(s.onState(next(190))?.kind, VoiceCueKind.mid);
    expect(s.onState(at(25, offRoute: true)), isNull);
    expect(s.onState(at(0, arrived: true))?.kind, VoiceCueKind.arrived);
    expect(s.onState(at(0, arrived: true)), isNull);
  });

  test('sentences', () async {
    final tts = FakeTts();
    final g = VoiceGuide(tts: tts, strings: en, isMuted: () => false)..setTarget(const NavTarget(lat: 9, lng: 38), toPickup: true);
    await g.init(const Locale('en'));
    g.onState(at(190));
    g.onState(at(20));
    g.onState(at(0, arrived: true));
    expect(tts.spoken, ['In 200 metres, turn left onto Bole Road', 'Turn left now', 'You have arrived at the pickup']);
  });

  test('muted: nothing is spoken and the cues are used up', () async {
    var muted = true;
    final tts = FakeTts();
    final g = VoiceGuide(tts: tts, strings: en, isMuted: () => muted);
    expect(g.onState(at(190)), isNotNull);
    muted = false;
    expect(g.onState(at(170)), isNull);
    expect(tts.spoken, isEmpty);
    g.dispose();
    expect(tts.stops, 1, reason: 'leaving the screen stops the voice');
  });

  test('Amharic without an am-ET voice speaks English; with one, Amharic', () async {
    final noAm = FakeTts();
    final g = VoiceGuide(tts: noAm, strings: lookupAppLocalizations(const Locale('am')), isMuted: () => false);
    await g.init(const Locale('am'));
    expect(g.languageTag, 'en-US');
    g.onState(at(190));
    expect(noAm.spoken.single, startsWith('In 200 metres'));

    final withAm = FakeTts(voices: {'en-US', 'am-ET'});
    final g2 = VoiceGuide(tts: withAm, strings: en, isMuted: () => false);
    await g2.init(const Locale('am'));
    expect(g2.languageTag, 'am-ET');
    g2.onState(at(190));
    expect(withAm.spoken.single, contains('200 ሜትር'));
  });
}
