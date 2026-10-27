// The design system: warm paper surfaces, near-black ink for text and primary actions, amber only
// for the live thing (the car, the active trip), red only for what needs a person now. Flat: hairline
// borders instead of shadows. One palette per
// brightness; rider and driver share it (the shell says which mode you're in).

import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';
import 'dark_palette.dart';
import 'tokens.dart';

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

  // Warm paper, near-black ink, one amber (the reference design: client-discovery's admin).
  static const light = AnbessaColors(
    canvas: Color(0xFFF6F5F1),
    surface: Color(0xFFFFFFFF),
    surface2: Color(0xFFFBFAF7),
    border: Color(0xFFD9D6CF),
    borderStrong: Color(0xFFBDB8AE),
    text: Color(0xFF17191D),
    text2: Color(0xFF3B4048),
    muted: Color(0xFF5C636D),
    faint: Color(0xFF8F8B83),
    accent: Color(0xFFFFB300),
    accentStrong: Color(0xFFE59E00),
    accentSoft: Color(0xFFFFF4D6),
    success: Color(0xFF007956),
    successSoft: Color(0xFFE3F2EC),
    warning: Color(0xFFA35F00),
    warningSoft: Color(0xFFFFF4D6),
    danger: Color(0xFFD40013),
    dangerSoft: Color(0xFFFEF2F2),
    info: Color(0xFF1F5FD6),
    infoSoft: Color(0xFFE6EEFC),
  );

  static const dark = anbessaDark;

  bool get isDark => canvas.computeLuminance() < 0.2;
  Brightness get brightness => isDark ? Brightness.dark : Brightness.light;

  /// What a primary control is filled with: ink (the text colour). Light mode: near-black with
  /// white text; dark mode: near-white with ink text. Amber stays for what's live on the map.
  Color get primaryFill => text;

  /// The text colour that reads on [primaryFill].
  Color get onAccent => isDark ? const Color(0xFF17191D) : Colors.white;

  /// The text colour that reads on [accent] (amber): always ink.
  Color get onAmber => const Color(0xFF17191D);

  @override
  AnbessaColors copyWith({
    Color? canvas,
    Color? surface,
    Color? surface2,
    Color? border,
    Color? borderStrong,
    Color? text,
    Color? text2,
    Color? muted,
    Color? faint,
    Color? accent,
    Color? accentStrong,
    Color? accentSoft,
    Color? success,
    Color? successSoft,
    Color? warning,
    Color? warningSoft,
    Color? danger,
    Color? dangerSoft,
    Color? info,
    Color? infoSoft,
  }) =>
      AnbessaColors(
        canvas: canvas ?? this.canvas,
        surface: surface ?? this.surface,
        surface2: surface2 ?? this.surface2,
        border: border ?? this.border,
        borderStrong: borderStrong ?? this.borderStrong,
        text: text ?? this.text,
        text2: text2 ?? this.text2,
        muted: muted ?? this.muted,
        faint: faint ?? this.faint,
        accent: accent ?? this.accent,
        accentStrong: accentStrong ?? this.accentStrong,
        accentSoft: accentSoft ?? this.accentSoft,
        success: success ?? this.success,
        successSoft: successSoft ?? this.successSoft,
        warning: warning ?? this.warning,
        warningSoft: warningSoft ?? this.warningSoft,
        danger: danger ?? this.danger,
        dangerSoft: dangerSoft ?? this.dangerSoft,
        info: info ?? this.info,
        infoSoft: infoSoft ?? this.infoSoft,
      );

  @override
  AnbessaColors lerp(ThemeExtension<AnbessaColors>? other, double t) {
    if (other is! AnbessaColors) return this;
    Color l(Color a, Color b) => Color.lerp(a, b, t)!;
    return AnbessaColors(
      canvas: l(canvas, other.canvas),
      surface: l(surface, other.surface),
      surface2: l(surface2, other.surface2),
      border: l(border, other.border),
      borderStrong: l(borderStrong, other.borderStrong),
      text: l(text, other.text),
      text2: l(text2, other.text2),
      muted: l(muted, other.muted),
      faint: l(faint, other.faint),
      accent: l(accent, other.accent),
      accentStrong: l(accentStrong, other.accentStrong),
      accentSoft: l(accentSoft, other.accentSoft),
      success: l(success, other.success),
      successSoft: l(successSoft, other.successSoft),
      warning: l(warning, other.warning),
      warningSoft: l(warningSoft, other.warningSoft),
      danger: l(danger, other.danger),
      dangerSoft: l(dangerSoft, other.dangerSoft),
      info: l(info, other.info),
      infoSoft: l(infoSoft, other.infoSoft),
    );
  }
}

extension AnbessaThemeX on BuildContext {
  AnbessaColors get colors => Theme.of(this).extension<AnbessaColors>() ?? AnbessaColors.light;
  bool get isDark => colors.isDark;
}

// kept for existing call sites; new code uses AnbessaRadius
const anbessaRadiusSm = AnbessaRadius.sm;
const anbessaRadius = AnbessaRadius.md;
const anbessaRadiusLg = AnbessaRadius.lg;

/// Ids and money use a monospace fallback; the app bundles the body font (Inter) and Noto Sans
/// Ethiopic for Amharic.
const monoFamilyFallback = ['JetBrains Mono', 'Roboto Mono', 'DejaVu Sans Mono', 'Menlo', 'monospace'];

ThemeData anbessaTheme({Brightness brightness = Brightness.light, String? fontFamily = 'Inter', List<String> fontFamilyFallback = const ['NotoSansEthiopic']}) {
  final dark = brightness == Brightness.dark;
  final c = dark ? AnbessaColors.dark : AnbessaColors.light;
  final scheme = ColorScheme.fromSeed(seedColor: c.accent, brightness: brightness).copyWith(
    primary: c.primaryFill,
    onPrimary: c.onAccent,
    primaryContainer: c.accentSoft,
    onPrimaryContainer: c.text,
    secondary: c.text2,
    surface: c.surface,
    onSurface: c.text,
    onSurfaceVariant: c.text2,
    surfaceContainerHighest: c.surface2,
    outline: c.borderStrong,
    outlineVariant: c.border,
    error: c.danger,
    onError: dark ? const Color(0xFF1A0000) : Colors.white,
    errorContainer: c.dangerSoft,
    onErrorContainer: c.danger,
  );
  final base = ThemeData(useMaterial3: true, colorScheme: scheme, brightness: brightness, fontFamily: fontFamily);
  TextStyle t(TextStyle s) => s.copyWith(color: c.text, fontFamily: fontFamily, fontFamilyFallback: fontFamilyFallback);
  final text = base.textTheme
      .copyWith(
        displayLarge: t(AnbessaType.display),
        displayMedium: t(AnbessaType.display.copyWith(fontSize: 28)),
        headlineLarge: t(AnbessaType.h1),
        headlineMedium: t(AnbessaType.h1.copyWith(fontSize: 22)),
        headlineSmall: t(AnbessaType.h2),
        titleLarge: t(AnbessaType.h2),
        titleMedium: t(AnbessaType.title),
        titleSmall: t(AnbessaType.body2.copyWith(fontWeight: FontWeight.w600)),
        bodyLarge: t(AnbessaType.body),
        bodyMedium: t(AnbessaType.body2),
        bodySmall: t(AnbessaType.caption.copyWith(color: c.muted)),
        labelLarge: t(AnbessaType.body2.copyWith(fontWeight: FontWeight.w600)),
        labelMedium: t(AnbessaType.label),
        labelSmall: t(AnbessaType.label.copyWith(fontSize: 11)),
      )
      .apply(fontFamily: fontFamily, fontFamilyFallback: fontFamilyFallback);
  final radius = BorderRadius.circular(AnbessaRadius.md);
  return base.copyWith(
    scaffoldBackgroundColor: c.canvas,
    canvasColor: c.canvas,
    textTheme: text,
    extensions: [c],
    splashFactory: InkRipple.splashFactory,
    pageTransitionsTheme: const PageTransitionsTheme(builders: {
      TargetPlatform.android: FadeForwardsPageTransitionsBuilder(),
      TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
      TargetPlatform.linux: FadeForwardsPageTransitionsBuilder(),
      TargetPlatform.macOS: FadeForwardsPageTransitionsBuilder(),
      TargetPlatform.windows: FadeForwardsPageTransitionsBuilder(),
    }),
    appBarTheme: AppBarTheme(
      backgroundColor: c.canvas,
      foregroundColor: c.text,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: text.titleLarge,
      iconTheme: IconThemeData(color: c.text),
    ),
    cardTheme: CardThemeData(
      color: c.surface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AnbessaRadius.lg), side: BorderSide(color: c.border)),
    ),
    // primary: ink-filled, 56 tall, 12 px corners, bold label (no icons needed)
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: c.primaryFill,
        foregroundColor: c.onAccent,
        disabledBackgroundColor: c.border,
        disabledForegroundColor: c.muted,
        minimumSize: const Size(48, 56),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
        shape: RoundedRectangleBorder(borderRadius: radius),
        elevation: 0,
        textStyle: AnbessaType.body.copyWith(fontSize: 17, fontWeight: FontWeight.w600, fontFamily: fontFamily, fontFamilyFallback: fontFamilyFallback),
      ),
    ),
    // secondary: a 2 px ink-grey outline on the surface
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: c.text,
        backgroundColor: c.surface,
        minimumSize: const Size(48, 56),
        side: BorderSide(color: c.border, width: 2),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
        shape: RoundedRectangleBorder(borderRadius: radius),
        textStyle: AnbessaType.body.copyWith(fontSize: 17, fontWeight: FontWeight.w600, fontFamily: fontFamily, fontFamilyFallback: fontFamilyFallback),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: c.text,
        minimumSize: const Size(48, 44),
        shape: RoundedRectangleBorder(borderRadius: radius),
        textStyle: AnbessaType.body2.copyWith(fontWeight: FontWeight.w600, fontFamily: fontFamily, fontFamilyFallback: fontFamilyFallback),
      ),
    ),
    iconButtonTheme: IconButtonThemeData(style: IconButton.styleFrom(foregroundColor: c.text, minimumSize: const Size(48, 48))),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: c.surface,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
      // 2 px borders; ink when focused
      border: OutlineInputBorder(borderRadius: radius, borderSide: BorderSide(color: c.border, width: 2)),
      enabledBorder: OutlineInputBorder(borderRadius: radius, borderSide: BorderSide(color: c.border, width: 2)),
      focusedBorder: OutlineInputBorder(borderRadius: radius, borderSide: BorderSide(color: c.text, width: 2)),
      errorBorder: OutlineInputBorder(borderRadius: radius, borderSide: BorderSide(color: c.danger, width: 2)),
      focusedErrorBorder: OutlineInputBorder(borderRadius: radius, borderSide: BorderSide(color: c.danger, width: 2)),
      labelStyle: TextStyle(color: c.text2, fontWeight: FontWeight.w500),
      floatingLabelStyle: TextStyle(color: c.text, fontWeight: FontWeight.w600),
      hintStyle: TextStyle(color: c.faint),
      prefixIconColor: c.muted,
      suffixIconColor: c.muted,
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: c.surface,
      surfaceTintColor: Colors.transparent,
      modalBackgroundColor: c.surface,
      showDragHandle: true,
      dragHandleColor: c.borderStrong,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(AnbessaRadius.sheet))),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: c.surface,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AnbessaRadius.xl)),
      titleTextStyle: text.titleLarge,
      contentTextStyle: text.bodyMedium?.copyWith(color: c.text2),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: c.surface,
      // no pill: the selected tab is ink, the others muted; a hairline above (see the shells)
      indicatorColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      height: 64,
      elevation: 0,
      labelTextStyle: WidgetStateProperty.resolveWith((s) => AnbessaType.label.copyWith(color: s.contains(WidgetState.selected) ? c.text : c.muted, fontWeight: s.contains(WidgetState.selected) ? FontWeight.w700 : FontWeight.w500, fontFamily: fontFamily, fontFamilyFallback: fontFamilyFallback)),
      iconTheme: WidgetStateProperty.resolveWith((s) => IconThemeData(color: s.contains(WidgetState.selected) ? c.text : c.muted, size: 24)),
    ),
    dividerTheme: DividerThemeData(color: c.border, thickness: 1, space: 1),
    chipTheme: ChipThemeData(
      backgroundColor: c.surface,
      selectedColor: c.text,
      secondarySelectedColor: c.text,
      side: BorderSide(color: c.border, width: 1.5),
      labelStyle: TextStyle(color: c.text, fontWeight: FontWeight.w600, fontFamily: fontFamily, fontFamilyFallback: fontFamilyFallback),
      secondaryLabelStyle: TextStyle(color: c.onAccent, fontWeight: FontWeight.w600, fontFamily: fontFamily, fontFamilyFallback: fontFamilyFallback),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AnbessaRadius.sm)),
      showCheckmark: false,
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: dark ? c.surface2 : c.text,
      contentTextStyle: TextStyle(color: dark ? c.text : Colors.white, fontFamily: fontFamily, fontFamilyFallback: fontFamilyFallback),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: radius),
    ),
    listTileTheme: ListTileThemeData(iconColor: c.text2, textColor: c.text, minVerticalPadding: 12),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: c.text, linearTrackColor: c.border, circularTrackColor: c.border),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.onAccent : c.surface),
      trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.primaryFill : c.borderStrong),
      trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
    ),
    radioTheme: RadioThemeData(fillColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.text : c.borderStrong)),
    checkboxTheme: CheckboxThemeData(fillColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.primaryFill : Colors.transparent), checkColor: WidgetStatePropertyAll(c.onAccent)),
    sliderTheme: SliderThemeData(activeTrackColor: c.text, thumbColor: c.text, inactiveTrackColor: c.border),
    tabBarTheme: TabBarThemeData(labelColor: c.text, unselectedLabelColor: c.muted, indicatorColor: c.text, dividerColor: c.border),
    badgeTheme: BadgeThemeData(backgroundColor: c.danger, textColor: Colors.white),
    tooltipTheme: TooltipThemeData(decoration: BoxDecoration(color: c.text, borderRadius: BorderRadius.circular(AnbessaRadius.sm)), textStyle: TextStyle(color: c.canvas)),
  );
}
