// Installs the app's haptics policy into core's `Haptics.sink`: honour the settings toggles and
// add a vibration pattern when an offer arrives (the phone may be in a pocket).

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:vibration/vibration.dart';
import '../network/providers.dart';
import '../prefs_keys.dart';

class HapticsSettings extends Notifier<({bool haptics, bool vibrateOnOffer})> {
  @override
  ({bool haptics, bool vibrateOnOffer}) build() {
    final p = ref.watch(prefsProvider);
    return (haptics: p.getBool(PrefsKeys.haptics) ?? true, vibrateOnOffer: p.getBool(PrefsKeys.notifVibrateOffer) ?? true);
  }

  Future<void> setHaptics(bool on) async {
    await ref.read(prefsProvider).setBool(PrefsKeys.haptics, on);
    state = (haptics: on, vibrateOnOffer: state.vibrateOnOffer);
  }

  Future<void> setVibrateOnOffer(bool on) async {
    await ref.read(prefsProvider).setBool(PrefsKeys.notifVibrateOffer, on);
    state = (haptics: state.haptics, vibrateOnOffer: on);
  }
}

final hapticsSettingsProvider = NotifierProvider<HapticsSettings, ({bool haptics, bool vibrateOnOffer})>(HapticsSettings.new);

/// Call once at boot; keeps `Haptics.sink` in step with the settings.
void installHaptics(ProviderContainer container) {
  void apply(({bool haptics, bool vibrateOnOffer}) s) {
    Haptics.sink = (kind) {
      if (kind == HapticKind.offer && s.vibrateOnOffer) {
        _vibrateOffer();
        return;
      }
      if (s.haptics) Haptics.platform(kind);
    };
  }

  apply(container.read(hapticsSettingsProvider));
  container.listen(hapticsSettingsProvider, (_, next) => apply(next));
}

Future<void> _vibrateOffer() async {
  if (kIsWeb || !(defaultTargetPlatform == TargetPlatform.android || defaultTargetPlatform == TargetPlatform.iOS)) return;
  try {
    if (await Vibration.hasVibrator()) {
      await Vibration.vibrate(pattern: [0, 300, 150, 300]);
      return;
    }
  } catch (_) {}
  Haptics.platform(HapticKind.heavy);
}
