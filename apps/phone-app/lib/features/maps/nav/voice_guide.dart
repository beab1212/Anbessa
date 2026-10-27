// Spoken turn-by-turn guidance for the driver.
//
// [VoiceScheduler] decides what to say from each NavState (pure, unit tested):
//   - each maneuver at about 500 m (only after a stretch of road long enough for it), 200 m and
//     30 m (further out at speed: about 4 s before the turn), each prompt once
//   - "Rerouting" when a new route is being fetched, and the arrival once
//   - a maneuver is known by what and where it is, not its index, so a reroute that keeps the
//     same next turn doesn't repeat what was already said
// [VoiceGuide] turns the cues into sentences in the app's language and speaks them through a
// [TtsEngine] (flutter_tts on phones, a fake in tests). Amharic uses an am-ET voice when the
// phone has one installed; without it the guide speaks English. Speaking asks for audio focus
// so music ducks under it; the guide stops talking when the navigation screen closes.
// The mute switch is persisted under `nav_voice`.

import 'dart:async';
import 'dart:io' show Platform;
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart' show Locale;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/network/providers.dart';
import '../../../core/prefs_keys.dart';
import 'nav_format.dart';
import 'navigation_controller.dart';

/// What speaks. Tests use a fake.
abstract interface class TtsEngine {
  /// Pick a voice for [languageTag] ("en-US", "am-ET"); false when the phone has none.
  Future<bool> setLanguage(String languageTag);
  Future<void> speak(String text);
  Future<void> stop();
}

class FlutterTtsEngine implements TtsEngine {
  FlutterTts? _tts;
  bool _ready = false;

  Future<FlutterTts?> _engine() async {
    if (_tts != null) return _tts;
    try {
      final t = FlutterTts();
      _tts = t;
      if (!kIsWeb && Platform.isAndroid) {
        await t.setAudioAttributesForNavigation();
      } else if (!kIsWeb && Platform.isIOS) {
        await t.setIosAudioCategory(IosTextToSpeechAudioCategory.playback, [IosTextToSpeechAudioCategoryOptions.duckOthers, IosTextToSpeechAudioCategoryOptions.interruptSpokenAudioAndMixWithOthers], IosTextToSpeechAudioMode.voicePrompt);
      }
      await t.setSpeechRate(0.5);
      await t.awaitSpeakCompletion(false);
      _ready = true;
    } catch (_) {
      _ready = false; // no TTS on this platform (desktop, tests)
    }
    return _tts;
  }

  @override
  Future<bool> setLanguage(String languageTag) async {
    final t = await _engine();
    if (t == null || !_ready) return false;
    try {
      final available = await t.isLanguageAvailable(languageTag);
      if (available != true && available != 1) return false;
      final r = await t.setLanguage(languageTag);
      return r == 1 || r == true;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<void> speak(String text) async {
    final t = await _engine();
    if (t == null || !_ready) return;
    try {
      // focus: Android ducks other audio while the prompt plays
      await t.speak(text, focus: true);
    } catch (_) {}
  }

  @override
  Future<void> stop() async {
    final t = _tts;
    if (t == null || !_ready) return;
    try {
      await t.stop();
    } catch (_) {}
  }
}

final ttsEngineProvider = Provider<TtsEngine>((ref) => FlutterTtsEngine());

/// Voice guidance on (true) or muted; persisted.
class NavVoiceController extends Notifier<bool> {
  @override
  bool build() => ref.watch(prefsProvider).getBool(PrefsKeys.navVoice) ?? true;

  Future<void> set(bool on) async {
    state = on;
    await ref.read(prefsProvider).setBool(PrefsKeys.navVoice, on);
  }

  Future<void> toggle() => set(!state);
}

final navVoiceProvider = NotifierProvider<NavVoiceController, bool>(NavVoiceController.new);

enum VoiceCueKind { far, mid, now, rerouting, arrived }

@immutable
class VoiceCue {
  const VoiceCue(this.kind, {this.step, this.meters});
  final VoiceCueKind kind;
  final RouteStep? step;
  final int? meters;
  @override
  String toString() => 'VoiceCue(${kind.name}${step == null ? '' : ' ${step!.type}/${step!.modifier}'}${meters == null ? '' : ' $meters m'})';
}

/// What to say, and when. One instance per navigation target.
class VoiceScheduler {
  VoiceScheduler({this.farMeters = 500, this.midMeters = 200, this.nowMeters = 30, this.farMinLeg = 700});

  final int farMeters;
  final int midMeters;
  final int nowMeters;
  /// the 500 m prompt only after a stretch of road at least this long
  final int farMinLeg;

  // per maneuver, the closest band already spoken (0 far, 1 mid, 2 now)
  final _spoken = <String, int>{};
  bool _wasRerouting = false;
  bool _arrivedSaid = false;

  /// A maneuver's identity across reroutes: what it is and where (to ~30 m).
  static String stepKey(RouteStep s) => '${s.type}|${s.modifier}|${s.exit}|${(s.lat * 3000).round()}|${(s.lng * 3000).round()}';

  /// The distance at which "now" is said: 30 m, or about 4 s before the turn at speed.
  double nowAt(double speed) => max(nowMeters.toDouble(), min(90.0, speed * 4));

  /// The cue for [s], if one is due. [speed] in m/s.
  VoiceCue? onState(NavState s, {double speed = 0}) {
    if (s.arrived) {
      if (_arrivedSaid) return null;
      _arrivedSaid = true;
      return const VoiceCue(VoiceCueKind.arrived);
    }
    if (s.rerouting) {
      if (_wasRerouting) return null;
      _wasRerouting = true;
      return const VoiceCue(VoiceCueKind.rerouting);
    }
    _wasRerouting = false;
    if (s.loading || s.offRoute || s.wrongWay || s.error != null) return null;
    final i = s.stepIndex, d = s.metersToManeuver;
    if (i == null || d == null) return null;
    final step = s.steps[i];
    if (step.type == 'depart') return null;
    final leg = s.stepAlong[i] - (i > 0 ? s.stepAlong[i - 1] : 0);
    final arrive = step.type == 'arrive';
    final now = nowAt(speed);
    int? band;
    if (d <= now) {
      // the arrival itself is said by the geofence
      band = arrive ? null : 2;
    } else if (d <= midMeters + 20) {
      band = d >= now + 40 ? 1 : null;
    } else if (d <= farMeters + 50 && d >= 300 && leg >= farMinLeg) {
      band = 0;
    }
    if (band == null) return null;
    final key = stepKey(step);
    final said = _spoken[key];
    if (said != null && said >= band) return null;
    _spoken[key] = band;
    return VoiceCue(const [VoiceCueKind.far, VoiceCueKind.mid, VoiceCueKind.now][band], step: step, meters: d);
  }
}

/// Speaks the scheduler's cues. [toPickup]: the arrival sentence names the pickup, else the
/// destination.
class VoiceGuide {
  VoiceGuide({required this.tts, required AppLocalizations strings, required this.isMuted, this.toPickup = true}) : _l = strings;

  final TtsEngine tts;
  final bool Function() isMuted;
  bool toPickup;
  AppLocalizations _l;
  VoiceScheduler _scheduler = VoiceScheduler();
  NavTarget? _target;
  bool _disposed = false;
  /// The language actually spoken (English when no Amharic voice is installed).
  String languageTag = 'en-US';

  /// Choose the voice for [locale]; Amharic falls back to English when the phone has no am-ET
  /// voice.
  Future<void> init(Locale locale) async {
    if (locale.languageCode == 'am') {
      if (await tts.setLanguage('am-ET')) {
        languageTag = 'am-ET';
        _l = lookupAppLocalizations(const Locale('am'));
        return;
      }
      _l = lookupAppLocalizations(const Locale('en'));
    }
    languageTag = 'en-US';
    await tts.setLanguage('en-US');
  }

  /// A new target (pickup → drop-off): the prompts start over.
  void setTarget(NavTarget? t, {required bool toPickup}) {
    if (t == _target) return;
    _target = t;
    this.toPickup = toPickup;
    _scheduler = VoiceScheduler();
  }

  /// The latest navigation state; speaks when a cue is due (the cue is used up even when muted,
  /// so unmuting doesn't replay old prompts).
  String? onState(NavState s, {double speed = 0}) {
    if (_disposed) return null;
    final cue = _scheduler.onState(s, speed: speed);
    if (cue == null) return null;
    final text = textFor(cue);
    if (!isMuted()) unawaited(tts.speak(text));
    return text;
  }

  String textFor(VoiceCue cue) {
    final l = _l;
    switch (cue.kind) {
      case VoiceCueKind.rerouting:
        return l.navVoiceRerouting;
      case VoiceCueKind.arrived:
        return toPickup ? l.navVoiceArrivedPickup : l.navVoiceArrivedDropoff;
      case VoiceCueKind.now:
        return l.navVoiceNow(navShortInstruction(l, cue.step!));
      case VoiceCueKind.far || VoiceCueKind.mid:
        final dist = navSpokenDistance(l, cue.meters ?? 0);
        final what = navInstruction(l, cue.step!);
        return dist == null ? l.navVoiceNow(what) : l.navVoiceIn(dist, _inSentence(what, l));
    }
  }

  /// English instructions start with a capital; inside a sentence they don't.
  static String _inSentence(String s, AppLocalizations l) {
    if (!l.localeName.startsWith('en') || s.isEmpty) return s;
    return s[0].toLowerCase() + s.substring(1);
  }

  /// Mute now: cut what is being said.
  Future<void> silence() => tts.stop();

  void dispose() {
    _disposed = true;
    unawaited(tts.stop());
  }
}
