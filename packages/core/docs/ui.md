# Design system

Source: `packages/core/lib/src/ui/`. A flat, text-first look: warm paper surfaces, near-black ink for text and for primary actions, one amber for the live thing (the car, the active trip), red only for what needs a person now. Hairline borders instead of shadows; no illustrations and no decorative icons (icons stay only where they help someone act: back, close, tabs, map controls, chevrons, stars). Rider and driver share one palette per brightness.

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

`card(brightness)` is empty (cards are separated by borders, not shadows). `floating(brightness)` (blur 16) and `sheet(brightness)` (blur 20, pointing up) are kept for what floats over the map.

### Type, `AnbessaType`

| Style | Size | Weight | Height |
|---|---|---|---|
| `display` | 30 | 800 | 1.2, letter spacing −0.6 |
| `h1` | 24 | 700 | 1.25, −0.4 |
| `h2` | 20 | 700 | 1.3, −0.2 |
| `title` | 17 | 600 | 1.35 |
| `body` | 16 | 400 | 1.5 |
| `body2` | 14 | 400 | 1.45 |
| `label` | 12 | 600 | 1.25 |
| `caption` | 12.5 | 400 | 1.4 |

`AnbessaType.tabular` is `[FontFeature.tabularFigures()]` for money and ids. `monoFamilyFallback` lists JetBrains Mono, Roboto Mono, DejaVu Sans Mono, Menlo, monospace.

## Palettes (`theme/anbessa_theme.dart`, `theme/dark_palette.dart`)

`AnbessaColors` is a `ThemeExtension` with 20 colours. Read it with `context.colors`; `context.isDark` tells the brightness.

| Token | Light | Dark |
|---|---|---|
| `canvas` | #F6F5F1 (paper) | #111214 |
| `surface` | #FFFFFF | #1A1C1F |
| `surface2` | #FBFAF7 | #222428 |
| `border` | #D9D6CF | #2F3237 |
| `borderStrong` | #BDB8AE | #45494F |
| `text` | #17191D (ink) | #F3F1EC |
| `text2` | #3B4048 | #CAC7C0 |
| `muted` | #5C636D | #9E9B93 |
| `faint` | #8F8B83 | #6E6B65 |
| `accent` | #FFB300 | #FFB300 |
| `accentStrong` | #E59E00 | #FFC53D |
| `accentSoft` | #FFF4D6 | #FFB300 at 18 % |
| `success` / `successSoft` | #007956 / #E3F2EC | #45C99A / at 15 % |
| `warning` / `warningSoft` | #A35F00 / #FFF4D6 | #FFC53D / #FFB300 at 15 % |
| `danger` / `dangerSoft` | #D40013 / #FEF2F2 | #FF6B6B / at 15 % |
| `info` / `infoSoft` | #1F5FD6 / #E6EEFC | #7AA7FF / at 15 % |

Derived: `isDark` (canvas luminance < 0.2), `brightness`, `primaryFill` (the fill of primary controls: ink, i.e. `text`: near-black in light mode, near-white in dark), `onAccent` (what reads on `primaryFill`: white in light, ink in dark), `onAmber` (ink, for text on `accent`). `lerp` interpolates every colour, so theme changes animate.

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
- Filled buttons: ink (`primaryFill`) with `onAccent` text, 56 tall, radius 12, 17 px semibold label, no icons. Outlined: 56 tall, `surface` fill, 2 px `border` side. Text buttons: ink, 48×44.
- Icon buttons min 48×48.
- Inputs: filled with `surface`, radius 12, 2 px `border` sides that turn ink when focused, `danger` error border.
- Bottom sheets: `surface`, drag handle shown, top radius 24. Dialogs: radius 24.
- Navigation bar: `surface`, no indicator: the selected tab's icon and label are ink and bold, the others muted; height 64.
- Chips, snack bars (floating), list tiles, progress indicators, switches, radios, checkboxes, sliders, tab bars, badges (`danger`), tooltips.
- Chips: square-ish (radius 8), selected chips ink-filled. Progress, radios, sliders, tab indicators: ink.
- `InkRipple` splash.

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

### Prices and progress (`price_and_progress.dart`)

| Widget | Purpose | Main parameters |
|---|---|---|
| `PriceTag` | what the person pays (animated like `AnimatedMoney`, green when discounted) with the undiscounted fare struck through above it when a promo lowered it; just the amount otherwise | `fareMinor`, `payableMinor`, `style`, `locale = 'en'` |
| `ProgressMeter` | a thin flat bar from 0 to 1: ink on a hairline track, green once full; semantics value in percent | `value`, `height = 6`, `semanticsLabel` |

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
| `IllustratedEmpty` | same | empty and error states: heading, line, action. The `illustration` is no longer drawn (text-first design); `Illustration` and the SVGs remain for any future use | `illustration`, `title`, `body`, `action`, `compact` |
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
