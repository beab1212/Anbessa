// The design system: warm paper surfaces, near-black ink for text, one bold amber for the main
// action and the live thing (the car, the active trip), red only for what needs a person now.
// Lists are flat with hairline borders; what floats over the map gets a soft shadow. One palette
// per brightness; rider and driver share it (the shell says which mode you're in).

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

  // GoRide's light neutrals mapped onto ours: white pages and sheets (surface), barely-grey filled
  // fields (surface2), a warm F5F5F5 for grouped pages (canvas), #EEE-like hairlines (border).
  static const light = AnbessaColors(
    canvas: Color(0xFFF6F5F1),
    surface: Color(0xFFFFFFFF),
    surface2: Color(0xFFFAF9F6),
    border: Color(0xFFEEECE7),
    borderStrong: Color(0xFFD9D6CF),
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

  /// What a primary control (the main call to action) is filled with: amber, in both modes.
  Color get primaryFill => accent;

  /// The text colour that reads on [primaryFill]: ink, in both modes.
  Color get onAccent => const Color(0xFF17191D);

  /// The text colour that reads on [accent] (amber): always ink.
  Color get onAmber => const Color(0xFF17191D);

  // GoRide roles. Screens use these names; they resolve to the palette per brightness.

  /// A screen's background, its sheets and the bottom bar: white / charcoal.
  Color get page => surface;

  /// A grouped page behind white cards (Account, Payment methods): warm F5F5F5 / the page.
  Color get groupedPage => isDark ? surface : canvas;

  /// A filled text field, a segmented tab track, an OTP box.
  Color get field => surface2;

  /// A card: white on light pages (with a hairline), a lifted grey on dark ones.
  Color get cardFill => isDark ? surface2 : surface;

  /// The hairline around a card (invisible in dark mode, where the fill separates it).
  Color get cardBorder => isDark ? surface2 : border;

  /// A neutral filled button (dark mode "Skip", "Call", "Cancel").
  Color get neutralFill => isDark ? border : canvas;

  /// Amber that reads as text: dark amber on light surfaces (5.7:1 on white), amber on dark.
  Color get accentText => isDark ? accent : const Color(0xFF8F5B00);

  /// The tinted fill of a selected card (with an [accent] border).
  Color get selectedFill => isDark ? const Color(0x1FFFB300) : const Color(0xFFFFF8E5);

  /// The pale amber of a tonal pill button ("Skip", "Sign in", "Use Later") in light mode.
  Color get tonalFill => isDark ? neutralFill : accentSoft;

  /// The label on [tonalFill].
  Color get onTonal => isDark ? text : accentText;

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

/// The body font: Urbanist (OFL), bundled in this package (`assets/fonts`). The app bundles Noto
/// Sans Ethiopic for Amharic, the fallback.
const anbessaFontFamily = 'packages/ride_app_core/Urbanist';

/// Ids and money use a monospace fallback.
const monoFamilyFallback = ['JetBrains Mono', 'Roboto Mono', 'DejaVu Sans Mono', 'Menlo', 'monospace'];

ThemeData anbessaTheme({Brightness brightness = Brightness.light, String? fontFamily = anbessaFontFamily, List<String> fontFamilyFallback = const ['NotoSansEthiopic']}) {
  final dark = brightness == Brightness.dark;
  final c = dark ? AnbessaColors.dark : AnbessaColors.light;
  final scheme = ColorScheme.fromSeed(seedColor: c.accent, brightness: brightness).copyWith(
    primary: c.primaryFill,
    onPrimary: c.onAccent,
    primaryContainer: c.accentSoft,
    onPrimaryContainer: c.text,
    secondary: c.text2,
    surface: c.page,
    onSurface: c.text,
    onSurfaceVariant: c.text2,
    surfaceContainerHighest: c.field,
    surfaceContainerHigh: c.field,
    surfaceContainer: c.cardFill,
    surfaceContainerLow: c.page,
    outline: c.borderStrong,
    outlineVariant: c.border,
    error: c.danger,
    onError: dark ? const Color(0xFF1A0000) : Colors.white,
    errorContainer: c.dangerSoft,
    onErrorContainer: c.danger,
  );
  final base = ThemeData(useMaterial3: true, colorScheme: scheme, brightness: brightness, fontFamily: fontFamily);
  TextStyle f(TextStyle s) => s.copyWith(fontFamily: fontFamily, fontFamilyFallback: fontFamilyFallback);
  TextStyle t(TextStyle s) => f(s).copyWith(color: c.text);
  final text = base.textTheme
      .copyWith(
        displayLarge: t(AnbessaType.display.copyWith(fontSize: 32)),
        displayMedium: t(AnbessaType.display),
        displaySmall: t(AnbessaType.h1),
        headlineLarge: t(AnbessaType.display),
        headlineMedium: t(AnbessaType.h1),
        headlineSmall: t(AnbessaType.h2),
        titleLarge: t(AnbessaType.h2),
        titleMedium: t(AnbessaType.title),
        titleSmall: t(AnbessaType.body2.copyWith(fontWeight: FontWeight.w700)),
        bodyLarge: t(AnbessaType.body),
        bodyMedium: t(AnbessaType.body2),
        bodySmall: t(AnbessaType.caption.copyWith(color: c.muted)),
        labelLarge: t(AnbessaType.button),
        labelMedium: t(AnbessaType.label),
        labelSmall: t(AnbessaType.label.copyWith(fontSize: 11)),
      )
      .apply(fontFamily: fontFamily, fontFamilyFallback: fontFamilyFallback);
  final radius = BorderRadius.circular(AnbessaRadius.md);
  const pill = StadiumBorder();
  OutlineInputBorder field(Color? color) =>
      OutlineInputBorder(borderRadius: radius, borderSide: color == null ? BorderSide.none : BorderSide(color: color, width: 1.5));
  return base.copyWith(
    scaffoldBackgroundColor: c.page,
    canvasColor: c.page,
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
    // back arrow + bold title, centred (the kit's default); see AppTopBar
    appBarTheme: AppBarTheme(
      backgroundColor: c.page,
      foregroundColor: c.text,
      elevation: 0,
      scrolledUnderElevation: 0,
      surfaceTintColor: Colors.transparent,
      centerTitle: true,
      toolbarHeight: AnbessaSize.topBar,
      titleTextStyle: text.titleLarge,
      iconTheme: IconThemeData(color: c.text, size: 24),
      actionsIconTheme: IconThemeData(color: c.text, size: 24),
    ),
    cardTheme: CardThemeData(
      color: c.cardFill,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: radius, side: BorderSide(color: c.cardBorder)),
      clipBehavior: Clip.antiAlias,
    ),
    // primary: an amber pill, 56 tall, ink bold label (see PillButton)
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: c.primaryFill,
        foregroundColor: c.onAccent,
        disabledBackgroundColor: dark ? c.surface2 : c.border,
        disabledForegroundColor: c.muted,
        minimumSize: const Size(48, AnbessaSize.button),
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
        shape: pill,
        elevation: 0,
        textStyle: f(AnbessaType.button),
      ),
    ),
    // secondary: an outlined pill with ink words ("Continue with Google")
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: c.text,
        backgroundColor: Colors.transparent,
        minimumSize: const Size(48, AnbessaSize.button),
        side: BorderSide(color: c.border, width: 1.5),
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
        shape: pill,
        textStyle: f(AnbessaType.button),
      ),
    ),
    // links: amber words ("Hide details", "Enter custom amount", "Sign in")
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: c.accentText,
        minimumSize: const Size(48, 44),
        shape: pill,
        textStyle: f(AnbessaType.body.copyWith(fontWeight: FontWeight.w600)),
      ),
    ),
    iconButtonTheme: IconButtonThemeData(style: IconButton.styleFrom(foregroundColor: c.text, minimumSize: const Size(48, 48))),
    // filled grey, no border, radius 12; amber border when focused
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: c.field,
      isDense: false,
      contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
      border: field(null),
      enabledBorder: field(null),
      disabledBorder: field(null),
      focusedBorder: field(c.accent),
      errorBorder: field(c.danger),
      focusedErrorBorder: field(c.danger),
      labelStyle: f(AnbessaType.body).copyWith(color: c.muted),
      floatingLabelStyle: f(AnbessaType.body2).copyWith(color: c.text, fontWeight: FontWeight.w600),
      hintStyle: f(AnbessaType.body).copyWith(color: c.faint, fontWeight: FontWeight.w400),
      errorStyle: f(AnbessaType.caption).copyWith(color: c.danger),
      prefixIconColor: c.text2,
      suffixIconColor: c.text2,
      prefixIconConstraints: const BoxConstraints(minWidth: 48, minHeight: 24),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: c.page,
      surfaceTintColor: Colors.transparent,
      modalBackgroundColor: c.page,
      showDragHandle: true,
      dragHandleColor: c.borderStrong,
      dragHandleSize: const Size(36, 4),
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(AnbessaRadius.sheet))),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: c.page,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AnbessaRadius.xl)),
      titleTextStyle: text.titleLarge,
      contentTextStyle: text.bodyMedium?.copyWith(color: c.text2),
    ),
    // four items, label under the icon; the selected one amber (the shell gives it the filled icon)
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: c.page,
      indicatorColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      height: AnbessaSize.navBar,
      elevation: 0,
      labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
      labelTextStyle: WidgetStateProperty.resolveWith((s) => f(AnbessaType.label).copyWith(
            fontSize: 11,
            color: s.contains(WidgetState.selected) ? c.accentText : c.muted,
            fontWeight: s.contains(WidgetState.selected) ? FontWeight.w700 : FontWeight.w500,
          )),
      iconTheme: WidgetStateProperty.resolveWith((s) => IconThemeData(color: s.contains(WidgetState.selected) ? c.accent : c.muted, size: 24)),
    ),
    bottomNavigationBarTheme: BottomNavigationBarThemeData(
      backgroundColor: c.page,
      elevation: 0,
      type: BottomNavigationBarType.fixed,
      selectedItemColor: c.accentText,
      unselectedItemColor: c.muted,
      selectedIconTheme: IconThemeData(color: c.accent, size: 24),
      unselectedIconTheme: IconThemeData(color: c.muted, size: 24),
      selectedLabelStyle: f(AnbessaType.label).copyWith(fontSize: 11, fontWeight: FontWeight.w700),
      unselectedLabelStyle: f(AnbessaType.label).copyWith(fontSize: 11, fontWeight: FontWeight.w500),
    ),
    dividerTheme: DividerThemeData(color: c.border, thickness: 1, space: 1),
    // outlined pills; selected ones amber-filled (Activity filters, tip amounts)
    chipTheme: ChipThemeData(
      backgroundColor: c.page,
      selectedColor: c.accent,
      secondarySelectedColor: c.accent,
      disabledColor: c.field,
      side: WidgetStateBorderSide.resolveWith((s) => BorderSide(color: s.contains(WidgetState.selected) ? c.accent : c.border, width: 1.5)),
      labelStyle: f(AnbessaType.body2).copyWith(color: c.text, fontWeight: FontWeight.w600),
      secondaryLabelStyle: f(AnbessaType.body2).copyWith(color: c.onAccent, fontWeight: FontWeight.w600),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      shape: pill,
      showCheckmark: false,
      iconTheme: IconThemeData(color: c.text2, size: 18),
    ),
    // white card with a shadow (dark: lifted grey), ink words, an amber action ("Undo")
    snackBarTheme: SnackBarThemeData(
      backgroundColor: dark ? c.surface2 : c.surface,
      contentTextStyle: f(AnbessaType.body).copyWith(color: c.text),
      actionTextColor: c.accentText,
      behavior: SnackBarBehavior.floating,
      elevation: 6,
      shape: RoundedRectangleBorder(borderRadius: radius),
      insetPadding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 0, AnbessaSpace.page, 12),
    ),
    listTileTheme: ListTileThemeData(
      iconColor: c.text,
      textColor: c.text,
      minVerticalPadding: 12,
      titleTextStyle: f(AnbessaType.body).copyWith(color: c.text, fontWeight: FontWeight.w600),
      subtitleTextStyle: f(AnbessaType.caption).copyWith(color: c.muted),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: c.accent, linearTrackColor: c.border, circularTrackColor: c.border),
    // iOS-like: amber track with a white thumb when on, grey track when off, no outline
    switchTheme: SwitchThemeData(
      thumbColor: const WidgetStatePropertyAll(Colors.white),
      trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.primaryFill : (dark ? c.border : c.borderStrong)),
      trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
      thumbIcon: const WidgetStatePropertyAll(null),
    ),
    radioTheme: RadioThemeData(fillColor: WidgetStatePropertyAll(c.accent)),
    // amber outline when empty, amber with an ink tick when checked; rounded 6
    checkboxTheme: CheckboxThemeData(
      fillColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.primaryFill : Colors.transparent),
      checkColor: WidgetStatePropertyAll(c.onAccent),
      side: BorderSide(color: c.accent, width: 2),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
    ),
    sliderTheme: SliderThemeData(activeTrackColor: c.accent, thumbColor: c.accent, inactiveTrackColor: c.border),
    tabBarTheme: TabBarThemeData(labelColor: c.text, unselectedLabelColor: c.muted, indicatorColor: c.accent, dividerColor: c.border, labelStyle: f(AnbessaType.body).copyWith(fontWeight: FontWeight.w700), unselectedLabelStyle: f(AnbessaType.body)),
    badgeTheme: BadgeThemeData(backgroundColor: c.danger, textColor: Colors.white),
    popupMenuTheme: PopupMenuThemeData(
      color: dark ? c.surface2 : c.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 8,
      shape: RoundedRectangleBorder(borderRadius: radius),
      textStyle: f(AnbessaType.body).copyWith(color: c.text),
    ),
    tooltipTheme: TooltipThemeData(decoration: BoxDecoration(color: c.text, borderRadius: BorderRadius.circular(AnbessaRadius.sm)), textStyle: TextStyle(color: c.canvas)),
  );
}
