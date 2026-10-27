// Timing marks for cold start and stage changes, in debug and profile builds only (nothing in
// release). Each mark logs the milliseconds since main() started (the earliest moment the Dart
// side sees; the engine's own start-up comes before it) and adds an instant event to the
// DevTools timeline, so `flutter run --profile` shows them next to the frames.
//
//   [perf] +412 ms first frame
//
// Marks: main start, first frame (main.dart), session ready, home shown (app.dart).

import 'dart:developer' as developer;

import 'package:flutter/foundation.dart';

abstract final class Perf {
  static final Stopwatch _clock = Stopwatch();
  static final Set<String> _seen = {};

  /// Logs written so far ("+412 ms first frame"), for tests and a debug overlay.
  static final List<String> log = [];

  /// Starts the clock. Call first thing in main(); later calls do nothing.
  static void start() {
    if (kReleaseMode || _clock.isRunning) return;
    _clock.start();
  }

  /// Time since [start] (zero when it never started, and in release).
  static Duration get elapsed => _clock.elapsed;

  /// Logs [name] with the time since [start]. With [once], only the first mark of that name
  /// counts (a "home shown" that a later navigation would repeat).
  static void mark(String name, {bool once = false}) {
    if (kReleaseMode) return;
    if (once && !_seen.add(name)) return;
    if (!_clock.isRunning) _clock.start();
    final line = '+${_clock.elapsedMilliseconds} ms $name';
    log.add(line);
    developer.Timeline.instantSync('perf: $name');
    debugPrint('[perf] $line');
  }

  @visibleForTesting
  static void reset() {
    _clock
      ..stop()
      ..reset();
    _seen.clear();
    log.clear();
  }
}
