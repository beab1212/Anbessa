// The painted icon glyph (LionGrilleArt, used by the phone app's splash) stays in sync with the
// SVG master the launcher icons and AnbessaMark are made from.

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ride_app_core/ride_app_core.dart';

void main() {
  final svg = File('assets/brand/anbessa_icon.svg').readAsStringSync();
  List<String> attr(String tag, String name) =>
      [for (final m in RegExp('<$tag\\b[^>]*>').allMatches(svg)) RegExp('\\b$name="([^"]*)"').firstMatch(m[0]!)?[1] ?? ''];
  String n(double v) => v == v.roundToDouble() ? v.toInt().toString() : '$v';

  test('the square, the shift and the colours match the master', () {
    expect(attr('rect', 'rx').first, n(LionGrilleArt.cornerRadius));
    expect(attr('svg', 'viewBox').single, '0 0 ${n(LionGrilleArt.size)} ${n(LionGrilleArt.size)}');
    expect(attr('g', 'transform').single, 'translate(0,${n(LionGrilleArt.shiftY)})');
    String hex(Color c) => '#${(c.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0').toUpperCase()}';
    expect(attr('path', 'fill'), [hex(LionGrilleArt.ink), hex(LionGrilleArt.cream), hex(LionGrilleArt.amber)]);
    expect(attr('circle', 'fill'), [for (final c in [LionGrilleArt.paper, LionGrilleArt.paper, LionGrilleArt.ink, LionGrilleArt.ink]) hex(c)]);
  });

  test('every shape matches the master', () {
    expect(attr('path', 'd'), [LionGrilleArt.roofPath, LionGrilleArt.windshieldPath, LionGrilleArt.nosePath]);
    expect(attr('polygon', 'points').single, LionGrilleArt.grillePoints);
    final rects = [for (final m in RegExp(r'<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" rx="(\d+)"').allMatches(svg)) [for (var i = 1; i <= 5; i++) double.parse(m[i]!)]];
    expect(rects, [
      for (final r in [LionGrilleArt.body, ...LionGrilleArt.wheels]) [r.$1, r.$2, r.$3, r.$4, r.$5],
    ]);
    final circles = [for (final m in RegExp(r'<circle cx="(\d+)" cy="(\d+)" r="(\d+)"').allMatches(svg)) (Offset(double.parse(m[1]!), double.parse(m[2]!)), double.parse(m[3]!))];
    expect(circles, [
      for (final h in LionGrilleArt.headlights) (h, LionGrilleArt.headlightRadius),
      for (final p in LionGrilleArt.pupils) (p, LionGrilleArt.pupilRadius),
    ]);
  });

  test('paints every part without throwing, and the parsed paths sit where the master puts them', () {
    final recorder = ui.PictureRecorder();
    LionGrilleArt.paintGlyph(Canvas(recorder), lights: 0.5, windshieldOpacity: 0, underLights: (_) {});
    recorder.endRecording().dispose();
    expect(LionGrilleArt.roof.getBounds(), const Rect.fromLTRB(332, 292, 692, 496));
    expect(LionGrilleArt.windshield.getBounds(), const Rect.fromLTRB(384, 334, 640, 470));
    expect(LionGrilleArt.nose.getBounds(), const Rect.fromLTRB(466, 566, 558, 622));
    expect(LionGrilleArt.grille.getBounds(), const Rect.fromLTRB(448, 652, 576, 687.5));
  });
}
