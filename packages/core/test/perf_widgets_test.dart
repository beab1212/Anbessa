// The performance helpers: the avatar's decoded-picture cache and the self-ticking texts.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ride_app_core/ride_app_core.dart';

/// A 1×1 transparent PNG as a data URL; [salt] makes distinct strings for the same picture.
String dataUrl([int salt = 0]) {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  final bytes = [...base64Decode(png), for (var i = 0; i < salt; i++) 0];
  return 'data:image/png;base64,${base64Encode(bytes)}';
}

void main() {
  group('AvatarImage cache', () {
    setUp(AvatarImage.clearCache);

    test('the same data URL gives the same MemoryImage, decoded once', () {
      final a = AvatarImage.memoryImageOf(dataUrl());
      // an equal string that isn't the same object still hits
      final b = AvatarImage.memoryImageOf(String.fromCharCodes(dataUrl().codeUnits));
      expect(a, isNotNull);
      expect(identical(a, b), isTrue);
      expect(AvatarImage.cachedCount, 1);
      expect(identical(a, AvatarImage.memoryImageOf(dataUrl(1))), isFalse);
      expect(AvatarImage.cachedCount, 2);
    });

    test('not a data URL, or broken base64: nothing cached', () {
      expect(AvatarImage.memoryImageOf('https://example.com/a.jpg'), isNull);
      expect(AvatarImage.memoryImageOf('data:image/png;base64,%%%'), isNull);
      expect(AvatarImage.cachedCount, 0);
    });

    test('least recently used pictures leave first', () {
      final first = AvatarImage.memoryImageOf(dataUrl(0));
      for (var i = 1; i < AvatarImage.cacheCapacity; i++) {
        AvatarImage.memoryImageOf(dataUrl(i));
      }
      // touch the first so it is the most recent, then overflow by one
      expect(identical(AvatarImage.memoryImageOf(dataUrl(0)), first), isTrue);
      AvatarImage.memoryImageOf(dataUrl(AvatarImage.cacheCapacity));
      expect(AvatarImage.cachedCount, AvatarImage.cacheCapacity);
      expect(identical(AvatarImage.memoryImageOf(dataUrl(0)), first), isTrue);
      // the second one was the oldest: decoded again into a new MemoryImage
      final again = AvatarImage.memoryImageOf(dataUrl(1));
      expect(again, isNotNull);
    });

    testWidgets('rebuilding an avatar keeps its image provider', (tester) async {
      final src = dataUrl();
      Widget avatar() => MaterialApp(theme: anbessaTheme(), home: Center(child: AvatarImage(src: src, name: 'Sara')));
      await tester.pumpWidget(avatar());
      final p1 = tester.widget<Image>(find.byType(Image)).image;
      await tester.pumpWidget(avatar());
      final p2 = tester.widget<Image>(find.byType(Image)).image;
      expect(identical(p1, p2), isTrue);
    });

    testWidgets('an https picture goes to the installed network builder', (tester) async {
      final seen = <String>[];
      AvatarImage.networkBuilder = (url, size, fallback) {
        seen.add(url);
        return SizedBox(width: size, height: size);
      };
      addTearDown(() => AvatarImage.networkBuilder = null);
      await tester.pumpWidget(MaterialApp(theme: anbessaTheme(), home: const Center(child: AvatarImage(src: 'https://example.com/a.jpg', name: 'Sara'))));
      expect(seen, ['https://example.com/a.jpg']);
    });
  });

  group('ticking texts', () {
    testWidgets('Countdown ticks down by itself, stops at zero and calls onDone once', (tester) async {
      var now = DateTime(2026, 10, 27, 12);
      var done = 0;
      var parentBuilds = 0;
      await tester.pumpWidget(MaterialApp(
        home: Builder(builder: (context) {
          parentBuilds++;
          return Center(child: Countdown(until: DateTime(2026, 10, 27, 12, 0, 3), format: mmss, now: () => now, onDone: () => done++));
        }),
      ));
      expect(find.text('0:03'), findsOneWidget);
      for (final want in ['0:02', '0:01', '0:00']) {
        now = now.add(const Duration(seconds: 1));
        await tester.pump(const Duration(seconds: 1));
        expect(find.text(want), findsOneWidget);
      }
      await tester.pump(); // the post-frame onDone
      expect(done, 1);
      now = now.add(const Duration(seconds: 5));
      await tester.pump(const Duration(seconds: 5));
      expect(find.text('0:00'), findsOneWidget); // never negative
      expect(done, 1);
      expect(parentBuilds, 1); // only the text rebuilt
    });

    testWidgets('ElapsedText counts up and pauses while its TickerMode is muted', (tester) async {
      var now = DateTime(2026, 10, 27, 12);
      final since = now.subtract(const Duration(seconds: 41));
      Widget app(bool enabled) => MaterialApp(home: TickerMode(enabled: enabled, child: Center(child: ElapsedText(since: since, format: mmss, now: () => now))));
      await tester.pumpWidget(app(true));
      expect(find.text('0:41'), findsOneWidget);
      now = now.add(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('0:42'), findsOneWidget);
      await tester.pumpWidget(app(false));
      now = now.add(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 3));
      // muted: no timer runs, the text keeps what the last build saw
      expect(find.text('0:42'), findsOneWidget);
      await tester.pumpWidget(app(true));
      expect(find.text('0:45'), findsOneWidget);
      now = now.add(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('0:46'), findsOneWidget);
    });
  });
}
