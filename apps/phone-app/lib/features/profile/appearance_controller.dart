// Light, dark or follow the system. `isDarkProvider` resolves the choice against the platform
// brightness so the map can switch its tiles with the theme.

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/network/providers.dart';
import '../../core/prefs_keys.dart';

class ThemeModeController extends Notifier<ThemeMode> {
  @override
  ThemeMode build() {
    final saved = ref.watch(prefsProvider).getString(PrefsKeys.themeMode);
    return ThemeMode.values.where((m) => m.name == saved).firstOrNull ?? ThemeMode.system;
  }

  Future<void> set(ThemeMode mode) async {
    state = mode;
    await ref.read(prefsProvider).setString(PrefsKeys.themeMode, mode.name);
  }
}

final themeModeProvider = NotifierProvider<ThemeModeController, ThemeMode>(ThemeModeController.new);

/// The platform's brightness, kept current.
class PlatformBrightness extends Notifier<Brightness> {
  @override
  Brightness build() {
    final d = SchedulerBinding.instance.platformDispatcher;
    final prev = d.onPlatformBrightnessChanged;
    d.onPlatformBrightnessChanged = () {
      prev?.call();
      state = d.platformBrightness;
    };
    ref.onDispose(() => d.onPlatformBrightnessChanged = prev);
    return d.platformBrightness;
  }
}

final platformBrightnessProvider = NotifierProvider<PlatformBrightness, Brightness>(PlatformBrightness.new);

final isDarkProvider = Provider<bool>((ref) {
  final mode = ref.watch(themeModeProvider);
  return switch (mode) {
    ThemeMode.dark => true,
    ThemeMode.light => false,
    ThemeMode.system => ref.watch(platformBrightnessProvider) == Brightness.dark,
  };
});
