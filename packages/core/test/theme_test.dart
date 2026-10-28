import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ride_app_core/ride_app_core.dart';

double contrast(Color a, Color b) {
  final la = a.computeLuminance(), lb = b.computeLuminance();
  final (hi, lo) = la > lb ? (la, lb) : (lb, la);
  return (hi + 0.05) / (lo + 0.05);
}

void main() {
  test('lerp moves between the palettes', () {
    final mid = AnbessaColors.light.lerp(AnbessaColors.dark, 0.5);
    expect(mid.canvas, isNot(AnbessaColors.light.canvas));
    expect(mid.canvas, isNot(AnbessaColors.dark.canvas));
    expect(AnbessaColors.light.lerp(AnbessaColors.dark, 1).canvas, AnbessaColors.dark.canvas);
    expect(AnbessaColors.light.copyWith(accent: Colors.red).accent, Colors.red);
  });

  test('text reads on every surface in both palettes (WCAG AA 4.5:1)', () {
    for (final c in [AnbessaColors.light, AnbessaColors.dark]) {
      for (final bg in [c.canvas, c.surface, c.surface2]) {
        expect(contrast(c.text, bg), greaterThanOrEqualTo(4.5), reason: 'text on $bg');
        expect(contrast(c.text2, bg), greaterThanOrEqualTo(4.5), reason: 'text2 on $bg');
        expect(contrast(c.muted, bg), greaterThanOrEqualTo(3.0), reason: 'muted on $bg');
      }
      expect(contrast(c.onAccent, c.primaryFill), greaterThanOrEqualTo(4.5));
    }
    expect(AnbessaColors.dark.isDark, isTrue);
    expect(AnbessaColors.light.isDark, isFalse);
  });

  test('the main action is amber with ink words in both modes', () {
    for (final b in Brightness.values) {
      final t = anbessaTheme(brightness: b);
      final c = t.extension<AnbessaColors>()!;
      expect(c.primaryFill, const Color(0xFFFFB300));
      expect(c.onAccent, const Color(0xFF17191D));
      expect(contrast(c.onAccent, c.primaryFill), greaterThanOrEqualTo(7.0));
      expect(t.filledButtonTheme.style!.backgroundColor!.resolve({}), c.accent);
      expect(t.outlinedButtonTheme.style!.foregroundColor!.resolve({}), c.text);
      expect(t.colorScheme.primary, c.accent);
    }
    expect(AnbessaRadius.sheet, 28);
    expect(AnbessaRadius.md, 12);
    expect(AnbessaSize.button, 56);
    expect(AnbessaElevation.card(Brightness.light), isEmpty);
    expect(AnbessaElevation.floating(Brightness.dark), isNotEmpty);
  });

  test('GoRide roles: white pages, filled fields, readable amber text, pill buttons', () {
    final l = AnbessaColors.light, d = AnbessaColors.dark;
    expect(l.page, const Color(0xFFFFFFFF));
    expect(l.field, isNot(l.page));
    expect(d.field, isNot(d.page));
    for (final c in [l, d]) {
      expect(contrast(c.accentText, c.page), greaterThanOrEqualTo(4.5), reason: 'amber text on the page');
      expect(contrast(c.onTonal, c.tonalFill), greaterThanOrEqualTo(4.5), reason: 'tonal label');
      expect(contrast(c.text, c.neutralFill), greaterThanOrEqualTo(4.5), reason: 'neutral label');
      expect(contrast(c.text, c.field), greaterThanOrEqualTo(4.5), reason: 'field text');
      expect(contrast(c.muted, c.field), greaterThanOrEqualTo(3.0), reason: 'hint/subtitle on a field');
    }
    for (final b in Brightness.values) {
      final t = anbessaTheme(brightness: b);
      final c = t.extension<AnbessaColors>()!;
      expect(t.scaffoldBackgroundColor, c.page);
      expect(t.inputDecorationTheme.fillColor, c.field);
      expect(t.filledButtonTheme.style!.shape!.resolve({}), isA<StadiumBorder>());
      expect(t.inputDecorationTheme.focusedBorder!.borderSide.color, c.accent);
    }
  });

  test('both themes build with the extension and the font', () {
    for (final b in Brightness.values) {
      final t = anbessaTheme(brightness: b);
      expect(t.brightness, b);
      expect(t.extension<AnbessaColors>()!.brightness, b);
      expect(t.textTheme.bodyLarge!.fontFamily, anbessaFontFamily);
      expect(anbessaFontFamily, 'packages/ride_app_core/Urbanist');
      expect(t.textTheme.bodyLarge!.fontFamilyFallback, contains('NotoSansEthiopic'));
    }
  });
}
