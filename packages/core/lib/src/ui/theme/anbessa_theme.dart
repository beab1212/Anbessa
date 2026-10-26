// The design system, from the web app's tokens (apps/web/src/styles/tokens.css): light neutral
// surfaces, amber for the active thing, red only for what needs a person now. One palette for
// both modes; the shell says which mode you're in.

import 'package:flutter/material.dart';

@immutable
class AnbessaColors extends ThemeExtension<AnbessaColors> {
  const AnbessaColors({
    required this.canvas,
    required this.surface,
    required this.surface2,
    required this.border,
    required this.borderStrong,
    required this.text,
    required this.text2,
    required this.muted,
    required this.faint,
    required this.accent,
    required this.accentStrong,
    required this.accentSoft,
    required this.success,
    required this.successSoft,
    required this.warning,
    required this.warningSoft,
    required this.danger,
    required this.dangerSoft,
    required this.info,
    required this.infoSoft,
  });

  final Color canvas;
  final Color surface;
  final Color surface2;
  final Color border;
  final Color borderStrong;
  final Color text;
  final Color text2;
  final Color muted;
  final Color faint;
  final Color accent;
  final Color accentStrong;
  final Color accentSoft;
  final Color success;
  final Color successSoft;
  final Color warning;
  final Color warningSoft;
  final Color danger;
  final Color dangerSoft;
  final Color info;
  final Color infoSoft;

  static const light = AnbessaColors(
    canvas: Color(0xFFF5F6F8),
    surface: Color(0xFFFFFFFF),
    surface2: Color(0xFFF8FAFC),
    border: Color(0xFFE4E7EC),
    borderStrong: Color(0xFFCBD2DC),
    text: Color(0xFF0F172A),
    text2: Color(0xFF475569),
    muted: Color(0xFF64748B),
    faint: Color(0xFF94A3B8),
    accent: Color(0xFFD97706),
    accentStrong: Color(0xFFB45309),
    accentSoft: Color(0xFFFEF3C7),
    success: Color(0xFF15803D),
    successSoft: Color(0xFFDCFCE7),
    warning: Color(0xFFB45309),
    warningSoft: Color(0xFFFEF3C7),
    danger: Color(0xFFDC2626),
    dangerSoft: Color(0xFFFEE2E2),
    info: Color(0xFF2563EB),
    infoSoft: Color(0xFFDBEAFE),
  );

  @override
  AnbessaColors copyWith() => this;

  @override
  AnbessaColors lerp(ThemeExtension<AnbessaColors>? other, double t) => this;
}

extension AnbessaThemeX on BuildContext {
  AnbessaColors get colors => Theme.of(this).extension<AnbessaColors>() ?? AnbessaColors.light;
}

const anbessaRadiusSm = 6.0;
const anbessaRadius = 8.0;
const anbessaRadiusLg = 12.0;

/// Fonts: the app bundles Inter and JetBrains Mono? No: the system sans is fine on phones; ids and
/// money use a monospace fallback. Amharic falls back to Noto Sans Ethiopic (bundled by the app).
const monoFamilyFallback = ['JetBrains Mono', 'Roboto Mono', 'DejaVu Sans Mono', 'Menlo', 'monospace'];

ThemeData anbessaTheme({List<String> fontFamilyFallback = const ['NotoSansEthiopic']}) {
  const c = AnbessaColors.light;
  final scheme = ColorScheme.fromSeed(seedColor: c.accent, brightness: Brightness.light).copyWith(
    primary: c.accentStrong,
    onPrimary: Colors.white,
    primaryContainer: c.accentSoft,
    onPrimaryContainer: c.accentStrong,
    secondary: c.text2,
    surface: c.surface,
    onSurface: c.text,
    onSurfaceVariant: c.text2,
    outline: c.borderStrong,
    outlineVariant: c.border,
    error: c.danger,
    onError: Colors.white,
    errorContainer: c.dangerSoft,
    onErrorContainer: c.danger,
  );
  final base = ThemeData(useMaterial3: true, colorScheme: scheme, brightness: Brightness.light);
  final text = base.textTheme.apply(bodyColor: c.text, displayColor: c.text, fontFamilyFallback: fontFamilyFallback);
  return base.copyWith(
    scaffoldBackgroundColor: c.canvas,
    canvasColor: c.canvas,
    textTheme: text,
    extensions: const [c],
    appBarTheme: AppBarTheme(
      backgroundColor: c.surface,
      foregroundColor: c.text,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      shape: Border(bottom: BorderSide(color: c.border)),
      titleTextStyle: text.titleLarge?.copyWith(fontWeight: FontWeight.w600, fontSize: 18),
    ),
    cardTheme: CardThemeData(
      color: c.surface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(anbessaRadiusLg), side: BorderSide(color: c.border)),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: c.accentStrong,
        foregroundColor: Colors.white,
        minimumSize: const Size(48, 48),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(anbessaRadius)),
        textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: c.text,
        minimumSize: const Size(48, 48),
        side: BorderSide(color: c.borderStrong),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(anbessaRadius)),
        textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: c.accentStrong, minimumSize: const Size(48, 44), textStyle: const TextStyle(fontWeight: FontWeight.w600)),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: c.surface,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(anbessaRadius), borderSide: BorderSide(color: c.borderStrong)),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(anbessaRadius), borderSide: BorderSide(color: c.borderStrong)),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(anbessaRadius), borderSide: BorderSide(color: c.accent, width: 2)),
      errorBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(anbessaRadius), borderSide: BorderSide(color: c.danger)),
      labelStyle: TextStyle(color: c.text2),
      hintStyle: TextStyle(color: c.faint),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: c.surface,
      surfaceTintColor: Colors.transparent,
      showDragHandle: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: c.surface,
      indicatorColor: c.accentSoft,
      surfaceTintColor: Colors.transparent,
      labelTextStyle: WidgetStatePropertyAll(text.labelSmall?.copyWith(fontWeight: FontWeight.w600)),
      iconTheme: WidgetStateProperty.resolveWith((s) => IconThemeData(color: s.contains(WidgetState.selected) ? c.accentStrong : c.muted)),
    ),
    dividerTheme: DividerThemeData(color: c.border, thickness: 1, space: 1),
    chipTheme: ChipThemeData(
      backgroundColor: c.surface,
      selectedColor: c.accentSoft,
      side: BorderSide(color: c.border),
      labelStyle: TextStyle(color: c.text, fontWeight: FontWeight.w500),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
    ),
    snackBarTheme: SnackBarThemeData(backgroundColor: c.text, contentTextStyle: const TextStyle(color: Colors.white), behavior: SnackBarBehavior.floating),
    listTileTheme: ListTileThemeData(iconColor: c.text2, textColor: c.text),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: c.accent),
  );
}
