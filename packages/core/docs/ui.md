# Design system

Source: `packages/core/lib/src/ui/`. The tokens and palettes come from the web app's `apps/web/src/styles/tokens.css` (per the file header of `anbessa_theme.dart`): neutral surfaces, amber for the active thing, red only for what needs a person now. Rider and driver share one palette per brightness.

## Tokens (`theme/tokens.dart`)

### Spacing, `AnbessaSpace`

| Name | xs | sm | md | lg | xl | xxl | xxxl |
|---|---|---|---|---|---|---|---|
| px | 4 | 8 | 12 | 16 | 20 | 24 | 32 |

### Radius, `AnbessaRadius`

| Name | sm | md | lg | xl | sheet | pill |
|---|---|---|---|---|---|---|
| px | 8 | 12 | 16 | 24 | 28 (bottom sheets, cards over the map) | 999 |

`anbessaRadiusSm`, `anbessaRadius`, `anbessaRadiusLg` (8, 12, 16) are kept for older call sites.

### Motion, `AnbessaMotion`

| Name | Value |
|---|---|
| `fast` | 120 ms |
| `base` | 200 ms |
| `slow` | 320 ms |
| `sheet` | 380 ms |
| `camera` | 500 ms (map camera moves) |
| `emphasized` | `Curves.easeOutCubic` |
| `spring` | `Curves.easeOutBack` |
| `standard` | `Curves.easeInOutCubic` |

`AnbessaMotion.of(context, d)` returns `Duration.zero` when `MediaQuery.disableAnimationsOf(context)` is true (the system's reduce-motion setting).

### Elevation, `AnbessaElevation`

`card(brightness)`, `floating(brightness)`, `sheet(brightness)` return shadow lists (blur 12 / 24 / 28; stronger alpha in dark mode; the sheet shadow points up).

### Type, `AnbessaType`

| Style | Size | Weight | Height |
|---|---|---|---|
| `display` | 32 | 800 | 1.15, letter spacing −0.5 |
| `h1` | 24 | 700 | 1.2, −0.3 |
| `h2` | 20 | 700 | 1.25 |
| `title` | 17 | 600 | 1.3 |
| `body` | 15 | 400 | 1.4 |
| `body2` | 14 | 400 | 1.4 |
| `label` | 12 | 600 | 1.2 |
| `caption` | 12 | 400 | 1.3 |

`AnbessaType.tabular` is `[FontFeature.tabularFigures()]` for money and ids. `monoFamilyFallback` lists JetBrains Mono, Roboto Mono, DejaVu Sans Mono, Menlo, monospace.

## Palettes (`theme/anbessa_theme.dart`, `theme/dark_palette.dart`)

`AnbessaColors` is a `ThemeExtension` with 20 colours. Read it with `context.colors`; `context.isDark` tells the brightness.

| Token | Light | Dark |
|---|---|---|
| `canvas` | #F5F6F8 | #0B1220 |
| `surface` | #FFFFFF | #111A2B |
| `surface2` | #F8FAFC | #172238 |
| `border` | #E4E7EC | #243049 |
| `borderStrong` | #CBD2DC | #34425E |
| `text` | #0F172A | #E6EAF2 |
| `text2` | #475569 | #B4BCCB |
| `muted` | #64748B | #8A94A6 |
| `faint` | #94A3B8 | #5E6879 |
| `accent` | #D97706 | #F59E0B |
| `accentStrong` | #B45309 | #FBBF24 |
| `accentSoft` | #FEF3C7 | #F59E0B at 20 % |
| `success` / `successSoft` | #15803D / #DCFCE7 | #4ADE80 / #22C55E at 16 % |
| `warning` / `warningSoft` | #B45309 / #FEF3C7 | #FBBF24 / #F59E0B at 16 % |
| `danger` / `dangerSoft` | #DC2626 / #FEE2E2 | #F87171 / #EF4444 at 16 % |
| `info` / `infoSoft` | #2563EB / #DBEAFE | #60A5FA / #3B82F6 at 16 % |

Derived: `isDark` (canvas luminance < 0.2), `brightness`, `primaryFill` (the fill of filled controls: `accentStrong` in light mode so white text reads at 4.5:1, `accent` in dark mode), `onAccent` (white in light, #1A1200 in dark). `lerp` interpolates every colour, so theme changes animate.

`test/theme_test.dart` checks that the text colours reach 4.5:1 on every surface in both palettes.

## Theme (`anbessaTheme`)

```dart
ThemeData anbessaTheme({Brightness brightness = Brightness.light, String? fontFamily = 'Inter', List<String> fontFamilyFallback = const ['NotoSansEthiopic']})
```

Material 3, `ColorScheme.fromSeed(accent)` overridden with the palette (primary = `primaryFill`, surface, outline, error…). The app passes no arguments except `brightness` (`apps/phone-app/lib/app.dart`). The fonts are bundled by the app (`apps/phone-app/pubspec.yaml`: Inter 400–800, Noto Sans Ethiopic 400 and 700).

What it sets:

- Text theme from `AnbessaType` (display, headline, title, body, label), all in `text` colour with the Ethiopic fallback.
- Page transitions: `FadeForwardsPageTransitionsBuilder` on Android, Linux, macOS, Windows; Cupertino on iOS. (Routes that use the app's own `fadeThroughPage` / `slideUpPage` override this.)
- App bar on `canvas`, no elevation, not centred.
- Cards: `surface`, no elevation, radius 16, 1 px `border` side.
- Filled buttons: `primaryFill` on `onAccent`, min size 48×52, radius 16, bold body text. Outlined: 48×52, `borderStrong` side. Text buttons: `accentStrong`, 48×44.
- Icon buttons min 48×48.
- Inputs: filled with `surface`, radius 12, 2 px `accent` focus border, `danger` error border.
- Bottom sheets: `surface`, drag handle shown, top radius 28. Dialogs: radius 24.
- Navigation bar: `surface`, `accentSoft` stadium indicator, height 64, selected icons `accentStrong`.
- Chips, snack bars (floating), list tiles, progress indicators, switches, radios, checkboxes, sliders, tab bars, badges (`danger`), tooltips.
- `InkSparkle` splash.

## Widgets (`ui/widgets/`)

All exported from `widgets.dart`. They take their words as parameters; none of them knows about Riverpod or localisation.

### Basics (`basics.dart`)

| Widget | Purpose | Main parameters |
|---|---|---|
| `Tone` (enum) | amber, green, red, blue, grey. `tone.colorsOf(c)` gives `(fg, bg)`: amber → warning, green → success, red → danger, blue → info, grey → text2 on surface2 | |
| `StatusPill` | a pill with a dot, like the web's `.pill` | `label`, `tone = grey`, `pulse`, `icon` |
| `PulsingDot` | a repeating pulse dot | `color`, `size = 7` |
| `MoneyText` | minor units as birr with tabular figures | `minor`, `style`, `locale = 'en'`, `signed` (prefix "+") |
| `MonoText` | monospace text (ids, plates) | `text`, `style` |
| `SectionCard` | a card with an optional title row | `title`, `trailing`, `child`, `padding = 16` |
| `NoticeTone` (enum) | info, ok, warning, error | |
| `Notice` | a banner with an icon | `text`, `tone = info`, `action` |
| `Problem` | an error as a `Notice` (error tone); renders nothing when `error` is null; a non-`AppError` becomes code `unknown`; the retry button shows only when `onRetry` is set and the error is `retryable` | `error`, `describe(AppError)`, `onRetry`, `retryLabel = 'Try again'` |
| `CountdownRing` | time left on a ring (offers, quotes, waiting) | `remaining`, `total`, `size = 64`, `child`, `strokeWidth = 5`, `invert` (fill up instead) |
| `EmptyState` | icon, title, body, action | `title`, `body`, `icon = inbox_outlined`, `action` |
| `PrimaryButton` | the main filled button with a busy state | `label`, `onPressed`, `busy`, `icon`, `danger`, `trailing` (text on the right, e.g. the price) |
| `KeyValue` | a label/value row | `label`, `value` (widget) |
| `Stat` | a big number with a label | `label`, `value`, `sub`, `alert` |

### Sheets and cards (`app_sheet.dart`)

| Widget | Purpose | Main parameters |
|---|---|---|
| `AppSheet` | the draggable bottom sheet of every map screen (a `DraggableScrollableSheet`) with snap points, a handle, a fixed header and footer, and its height reported so the map can keep its subject above it | `builder(context, scrollController)` (required), `snaps = [0.35, 0.7]` (fractions, ascending), `initialSnap = 0`, `header`, `footer`, `controller`, `onHeightChanged(px)`, `padding = (20, 4, 20, 20)`, `showHandle = true`, `expandOnKeyboard = true` |
| `AppSheetController` | drives an `AppSheet` | `animateTo(snapIndex)`, `collapse()`, `expand()`, `size` |
| `FloatingCard` | a non-draggable card over the map | `child`, `padding = 16`, `radius = 24` |

### Feedback (`feedback.dart`)

| API | Purpose |
|---|---|
| `HapticKind` | selection, light, medium, heavy, success, error, offer |
| `Haptics` | static calls `selection()`, `light()`, `medium()`, `heavy()`, `success()`, `error()`, `offer()`; each goes to `Haptics.sink`. The default sink, `Haptics.platform`, maps selection → `selectionClick`, light/medium → the impacts, heavy/success/offer → `heavyImpact`, error → `vibrate`. The app replaces the sink (`apps/phone-app/lib/core/ux/haptics.dart`) |
| `showToast(context, text, {tone, duration = 2.5 s, icon})` | a message that slides in from the top on the root overlay and leaves on its own |

### Banners (`floating_banner.dart`)

| Widget | Purpose | Main parameters |
|---|---|---|
| `FloatingBanner` | a banner floating over the map (maintenance, reconnecting, announcements, balance state) | `text`, `title`, `tone`, `action` + `actionLabel`, `onDismiss`, `pulse`, `icon` |
| `FloatingBannerStack` | stacks banners under the status bar with animated insert/remove and reports the stack height | `children`, `onHeightChanged`, `safeTop = true` |

### Images and illustrations

| Widget | File | Purpose | Main parameters |
|---|---|---|---|
| `AvatarImage` | `avatar_image.dart` | a person's picture from a data URL or an https URL, or amber initials. `AvatarImage.networkBuilder` lets the app install a cached builder (the app does not set it); `decodeDataUrl`, `initialsOf` (skips words that start with a digit or "+") | `src`, `name`, `size = 44`, `ring` |
| `AnbessaIllustration` (enum) | `illustrated_empty.dart` | noTrips, noConnection, searchEmpty, carWaiting, documents, celebrate, locationOff, wallet → `assets/illustrations/<snake_name>.svg` | |
| `Illustration` | same | one SVG with the theme's colours substituted | `kind`, `size = 140` |
| `IllustratedEmpty` | same | empty and error states with an illustration | `illustration`, `title`, `body`, `action`, `compact` |
| `VehicleGlyph` / `vehicleIcon(code)` | `vehicle_glyph.dart` | an icon per vehicle code: minivan/van/minibus, comfort/premium/business, bajaj/tuktuk/three_wheeler, moto/motorbike/bike, electric/ev; anything else gets the plain car | `code`, `size = 44`, `selected`, `plain` |

### Map overlays (`map_controls.dart`, `eta_badge.dart`)

| Widget | Purpose | Main parameters |
|---|---|---|
| `MapControlButton` | a round button over the map | `icon`, `onTap`, `tooltip`, `active`, `size = 44`, `child` (replaces the icon) |
| `MapControlColumn` | a column of those | `children`, `gap = 10` |
| `MapChip` | a chip with icon and text ("3 cars nearby", "GPS weak") | `label`, `icon`, `tone`, `onTap`, `pulse` |
| `EtaBadge` | "4 min" in a pill | `seconds` (null shows "—"), `minuteLabel(int)`, `approximate`, `onDark`, `large`, `icon` |

### Inputs and choices

| Widget | File | Purpose | Main parameters |
|---|---|---|---|
| `PinBoxes` | `pin_boxes.dart` | code entry as boxes (6-digit sign-in code, 4-digit trip PIN), on `pinput`, numeric keyboard, SMS autofill hooks | `length`, `onCompleted`, `controller`, `focusNode`, `autofocus = true`, `error`, `enabled`, `smsRetriever`, `size = 56` |
| `PinDisplay` | same | the rider's PIN, big enough to read out | `pin`, `size = 52` |
| `SwipeToConfirm` | `swipe_to_confirm.dart` | drag the thumb to the end to confirm; long-press also confirms (accessibility) | `label`, `onConfirmed` (async), `icon = arrow_forward`, `tone = amber`, `busy`, `enabled`, `height = 60`, `threshold = 0.85`, `semanticsHint` |
| `PillTabs<T>` | `pill_tabs.dart` | segmented pills (today/week/month, rider/driver) | `items: [(value, label)]`, `selected`, `onChanged`, `expand = true` |
| `RatingStars` | `rating.dart` | 1–5 stars, tappable when `onChanged` is set | `value`, `onChanged`, `size = 40`, `gap = 6` |
| `RatingSummary` | same | "4.9 · 128" with a star | `average`, `count`, `style`, `newLabel` (shown with no average) |
| `TagChips` | same | rating tag chips | `tags`, `selected`, `onToggle`, `label(tag)` |
| `IconTile` | `icon_tile.dart` | a square shortcut tile (Home, Work, add) | `icon`, `label`, `sublabel`, `onTap`, `onLongPress`, `selected`, `dashed` (an "add" tile), `width = 96` |

### Settings lists (`section_group.dart`)

| Widget | Purpose | Main parameters |
|---|---|---|
| `SectionGroup` | a titled group of rows in one rounded card | `title`, `children`, `margin = bottom 16` |
| `SettingsTile` | a row with icon, title, subtitle, chevron | `icon`, `title`, `subtitle`, `trailing`, `onTap`, `destructive`, `iconTone`, `chevron = true`, `badge` |
| `SettingsSwitchTile` | a row with a switch | `icon`, `title`, `subtitle`, `value`, `onChanged` |
| `SettingsValueTile` | a row showing the current value | `icon`, `title`, `value`, `onTap` |
| `ChoiceRow` | one of several choices (language, theme, provider) | `title`, `subtitle`, `selected`, `onTap`, `leading` |

### Numbers and progress

| Widget | File | Purpose | Main parameters |
|---|---|---|---|
| `AnimatedCounter` | `animated_counter.dart` | a number that rolls to its new value | `value`, `format(num)`, `style`, `duration = 600 ms` |
| `AnimatedMoney` | same | the same for minor units, formatted with `birr()` | `minor`, `style`, `locale` |
| `StatTile` / `StatRow` | `stat_tile.dart` | small stats in a row (today's earnings, trips, time online) | `label`, `value` (widget), `icon`, `tone`, `sub`; row: `children`, `gap = 8` |
| `StepperHeader` | `stepper_header.dart` | progress across named steps (driver onboarding) | `steps`, `current`, `done` (set of indexes) |
| `Skeleton.box` / `.line` / `.circle` | `skeleton.dart` | loading placeholders with a shimmer; no shimmer when motion is reduced | box: `width`, `height = 16`, `radius = 8`; line: `width`, `height = 14`; circle: `size` |
| `SkeletonList` | same | rows of avatar + two lines | `rows = 5`, `avatar = true` |
| `SkeletonCard` | same | a card-sized block | `height = 96` |

### Motion (`motion.dart`)

Each one collapses to no motion when the system asks for less.

| Widget | Purpose | Main parameters |
|---|---|---|
| `FadeSlideIn` | fade + slide up on first build | `child`, `delay`, `offset = 0.08`, `duration = slow` |
| `PopIn` | scale in with a small overshoot | `child`, `delay` |
| `Pulse` | a gentle repeating pulse | `child`, `scale = 1.06` |
| `Shake` | shake sideways once when `trigger` changes (wrong code) | `child`, `trigger` |
| `AnimatedSwitcherX` | cross-fade with a size change, keyed by the child | `child`, `duration = slow`, `alignment = topCenter` |
| `RadarPulse` | expanding rings (finding a driver, going online) | `color`, `size = 120`, `rings = 3` |

`Pulse`, `PulsingDot` and `RadarPulse` repeat forever, so widget tests that show them cannot use `pumpAndSettle` (see `apps/phone-app/docs/testing.md`).
