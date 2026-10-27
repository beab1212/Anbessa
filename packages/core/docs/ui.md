# Design system

Source: `packages/core/lib/src/ui/`. A map-first ride-hailing look: warm paper surfaces, near-black ink for text, one bold amber (#FFB300) for the main call to action and for the live thing (the car, the active trip), red only for what needs a person now. Generous rounding (16/20/28), soft wide shadows on what floats over the map and on the sheet, hairline borders on list cards. Rider and driver share one palette per brightness.

**Icons.** Meaningful icons are back: rows, tiles, pills, notices, banners, toasts, stats and buttons lead with an icon when the call site gives one (Material Symbols through Flutter's `Icons.*_rounded` variants; no extra icon package). Icons are decoration for sighted people and are excluded from semantics where the words already say the same thing. Every widget that takes an `icon` keeps it optional where it was optional before; the APIs did not change.

**Vehicle art.** Our own flat side-view cars live in `packages/core/assets/vehicles/{economy,comfort,minivan,generic}.svg` (160×64 viewBox; light grey body `#D5D9DE`, shade `#BAC0C7`, windows `#3A434D`, tyres `#23272C`, hubs `#A3AAB2`). `VehicleArt` recolours them for dark mode or paints the body with a tint. The folder is registered in the core pubspec and loaded with `package: 'ride_app_core'`.

## Tokens (`theme/tokens.dart`)

### Spacing, `AnbessaSpace`

| Name | xs | sm | md | lg | xl | xxl | xxxl |
|---|---|---|---|---|---|---|---|
| px | 4 | 8 | 12 | 16 | 20 | 24 | 32 |

### Radius, `AnbessaRadius`

| Name | sm | md | lg | xl | sheet | pill |
|---|---|---|---|---|---|---|
| px | 10 (chips, badges) | 16 (buttons, inputs, list cards) | 20 (cards, tiles, the search bar) | 24 (dialogs) | 28 (bottom sheets, cards over the map) | 999 |

`anbessaRadiusSm`, `anbessaRadius`, `anbessaRadiusLg` (10, 16, 20) are kept for older call sites.

### Motion, `AnbessaMotion`

| Name | Value |
|---|---|
| `fast` | 120 ms |
| `base` | 200 ms |
| `short` | 250 ms (small state changes: a selected card) |
| `slow` | 320 ms |
| `sheet` | 380 ms |
| `medium` | 400 ms (shared-axis steps, cards entering) |
| `long` | 500 ms (screen-sized changes) |
| `camera` | 500 ms (map camera moves) |
| `emphasized` | `Cubic(0.2, 0, 0, 1)` (Material 3 emphasized) |
| `emphasizedDecelerate` | `Cubic(0.05, 0.7, 0.1, 1)` (entering) |
| `emphasizedAccelerate` | `Cubic(0.3, 0, 0.8, 0.15)` (leaving) |
| `spring` | `Curves.easeOutBack` (small overshoot) |
| `springSoft` | `Cubic(0.34, 1.36, 0.64, 1)` (softer overshoot) |
| `standard` | `Curves.easeInOutCubic` |
| `springDescription` | `SpringDescription(mass: 1, stiffness: 420, damping: 34)` for physics-driven motion |

`AnbessaMotion.of(context, d)` returns `Duration.zero` when `MediaQuery.disableAnimationsOf(context)` is true (the system's reduce-motion setting); `AnbessaMotion.reduced(context)` tells the same as a bool. `AnbessaMotion.sharedAxis(child, animation, {axis, reverse, outgoing, distance = 30})` builds a shared-axis transition (slide along the axis + fade through) for `AnimatedSwitcher`-style builders; `SharedAxisSwitcher` wraps it.

### Elevation, `AnbessaElevation`

`card(brightness)` is empty (list cards are separated by hairline borders). `floating(brightness)` is a soft two-layer shadow (blur 24 at y 8 plus blur 4 at y 1; ink at 10 %/5 % in light, black at 40 %/20 % in dark) for what floats over the map: map buttons, chips, banners, toasts, the search bar, round buttons, the recenter pill. `raised(brightness)` (blur 16, y 6) lifts a selected card. `sheet(brightness)` (blur 28, pointing up) is for the bottom sheet. In dark mode floating things also keep a hairline border so they separate from charcoal maps.

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

Derived: `isDark` (canvas luminance < 0.2), `brightness`, `primaryFill` (the fill of the main call to action: `accent`, amber, in both modes), `onAccent` (what reads on `primaryFill`: ink #17191D in both modes, about 10:1), `onAmber` (ink, for text on `accent`). `lerp` interpolates every colour, so theme changes animate.

`test/theme_test.dart` checks that the text colours reach 4.5:1 on every surface in both palettes, that ink on amber reaches 7:1, and that filled buttons are amber and outlined buttons ink.

## Theme (`anbessaTheme`)

```dart
ThemeData anbessaTheme({Brightness brightness = Brightness.light, String? fontFamily = 'Inter', List<String> fontFamilyFallback = const ['NotoSansEthiopic']})
```

Material 3, `ColorScheme.fromSeed(accent)` overridden with the palette (primary = `primaryFill` = amber, onPrimary = ink, surface, outline, error…). The app passes no arguments except `brightness` (`apps/phone-app/lib/app.dart`). The fonts are bundled by the app (`apps/phone-app/pubspec.yaml`: Inter 400–800, Noto Sans Ethiopic 400 and 700).

What it sets:

- Text theme from `AnbessaType` (display, headline, title, body, label), all in `text` colour with the Ethiopic fallback.
- Page transitions: `FadeForwardsPageTransitionsBuilder` on Android, Linux, macOS, Windows; Cupertino on iOS. (Routes that use the app's own `fadeThroughPage` / `slideUpPage` override this.)
- App bar on `canvas`, no elevation, not centred.
- Cards: `surface`, no elevation, radius 20, 1 px `border` side, anti-aliased clip.
- Filled buttons: amber (`primaryFill`) with ink (`onAccent`) text, 56 tall, radius 16, 17 px semibold label (`PrimaryButton` adds an optional leading icon). Disabled: `border` (light) / `surface2` (dark) with muted text. Outlined: ink text, 56 tall, `surface` fill, 2 px `border` side. Text buttons: ink, 48×44.
- Icon buttons min 48×48.
- Inputs: filled with `surface`, radius 16, 2 px `border` sides that turn ink when focused, `danger` error border.
- Bottom sheets: `surface`, drag handle shown, top radius 28. Dialogs: radius 24.
- Navigation bar: `surface`, no indicator: the selected tab's icon and label are ink and bold, the others muted; height 64.
- Chips, snack bars (floating), list tiles, progress indicators, switches, radios, checkboxes, sliders, tab bars, badges (`danger`), tooltips.
- Chips: radius 10, selected chips ink-filled with canvas-coloured words. Progress, radios, sliders, tab indicators: ink. Switches and checkboxes: amber when on (white thumb, ink check).
- `InkRipple` splash.

## Widgets (`ui/widgets/`)

All exported from `widgets.dart`. They take their words as parameters; none of them knows about Riverpod or localisation.

### Basics (`basics.dart`)

| Widget | Purpose | Main parameters |
|---|---|---|
| `Tone` (enum) | amber, green, red, blue, grey. `tone.colorsOf(c)` gives `(fg, bg)`: amber → warning, green → success, red → danger, blue → info, grey → text2 on surface2 | |
| `StatusPill` | a rounded tinted pill with the `icon` in the tone colour, or a dot (pulsing when `pulse`) | `label`, `tone = grey`, `pulse`, `icon` |
| `PulsingDot` | a repeating pulse dot | `color`, `size = 7` |
| `MoneyText` | minor units as birr with tabular figures | `minor`, `style`, `locale = 'en'`, `signed` (prefix "+") |
| `MonoText` | monospace text (ids, plates) | `text`, `style` |
| `SectionCard` | a card with an optional title row | `title`, `trailing`, `child`, `padding = 16` |
| `NoticeTone` (enum) | info, ok, warning, error | |
| `Notice` | a tinted panel led by the tone's icon (info, check, warning, error; rounded) | `text`, `tone = info`, `action` |
| `Problem` | an error as a `Notice` (error tone); renders nothing when `error` is null; a non-`AppError` becomes code `unknown`; the retry button shows only when `onRetry` is set and the error is `retryable` | `error`, `describe(AppError)`, `onRetry`, `retryLabel = 'Try again'` |
| `CountdownRing` | time left on a ring (offers, quotes, waiting) | `remaining`, `total`, `size = 64`, `child`, `strokeWidth = 5`, `invert` (fill up instead) |
| `EmptyState` | the icon in a 64 px amber-soft circle, title, body, action | `title`, `body`, `icon = inbox_rounded`, `action` |
| `PrimaryButton` | the main amber button with a busy state and an optional leading icon (hidden while busy) | `label`, `onPressed`, `busy`, `icon`, `danger`, `trailing` (text on the right, e.g. the price) |
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
| `AppSheetController` | drives an `AppSheet` (the rider map shell changes the sheet's snap points per stage and calls `animateTo` after the frame) | `animateTo(snapIndex)`, `collapse()`, `expand()`, `size` |
| `FloatingCard` | a non-draggable card over the map with the floating shadow | `child`, `padding = 16`, `radius = 24` |

### Feedback (`feedback.dart`)

| API | Purpose |
|---|---|
| `HapticKind` | selection, light, medium, heavy, success, error, offer |
| `Haptics` | static calls `selection()`, `light()`, `medium()`, `heavy()`, `success()`, `error()`, `offer()`; each goes to `Haptics.sink`. The default sink, `Haptics.platform`, maps selection → `selectionClick`, light/medium → the impacts, heavy/success/offer → `heavyImpact`, error → `vibrate`. The app replaces the sink (`apps/phone-app/lib/core/ux/haptics.dart`) |
| `showToast(context, text, {tone, duration = 2.5 s, icon})` | a message that slides in from the top on the root overlay and leaves on its own; it leads with `icon` (or the tone's icon) in a soft circle |

### Banners (`floating_banner.dart`)

| Widget | Purpose | Main parameters |
|---|---|---|
| `FloatingBanner` | a banner floating over the map (maintenance, reconnecting, announcements, balance state), led by `icon` (or the tone's icon) in a soft circle; `pulse` shows a pulsing dot instead | `text`, `title`, `tone`, `action` + `actionLabel`, `onDismiss`, `pulse`, `icon` |
| `FloatingBannerStack` | stacks banners under the status bar with animated insert/remove and reports the stack height | `children`, `onHeightChanged`, `safeTop = true` |

### Images and illustrations

| Widget | File | Purpose | Main parameters |
|---|---|---|---|
| `AvatarImage` | `avatar_image.dart` | a person's picture from a data URL or an https URL, or amber initials. A data URL is decoded once into a `MemoryImage` kept in a 32-entry LRU keyed by the string's hash (`memoryImageOf`), so rebuilds neither decode the base64 again nor hand Flutter a new provider. `AvatarImage.networkBuilder(url, size, fallback)` lets the app install a cached builder (the phone app sets a `CachedNetworkImage` in `main.dart`; `fallback` is the initials for a failed download); `decodeDataUrl`, `initialsOf` (skips words that start with a digit or "+") | `src`, `name`, `size = 44`, `ring` |
| `AnbessaIllustration` (enum) | `illustrated_empty.dart` | noTrips, noConnection, searchEmpty, carWaiting, documents, celebrate, locationOff, wallet → `assets/illustrations/<snake_name>.svg` | |
| `Illustration` | same | one SVG with the theme's colours substituted | `kind`, `size = 140` |
| `IllustratedEmpty` | same | empty and error states: a small illustration (112 px, 72 when `compact`), heading, line, action | `illustration`, `title`, `body`, `action`, `compact` |
| `VehicleArt` / `vehicleArtName(code)` | `vehicle_card.dart` | side-view car art per class: economy/eco/standard/basic/hatchback/lite → economy, comfort/premium/business/sedan/executive → comfort, minivan/van/minibus/xl/family → minivan, else generic; recoloured for dark mode; falls back to the `VehicleGlyph` icon if the asset fails | `code`, `width = 120`, `height` (default width × 0.4), `tint` |
| `PlateBadge` | same | a licence plate: bordered in ink, monospace, bold, upper case; optional region `code` in a left segment | `plate`, `code`, `large` |
| `VehicleGlyph` / `vehicleIcon(code)` | `vehicle_glyph.dart` | an icon per vehicle code: minivan/van/minibus, comfort/premium/business, bajaj/tuktuk/three_wheeler, moto/motorbike/bike, electric/ev; anything else gets the plain car | `code`, `size = 44`, `selected`, `plain` |

### Map overlays (`map_controls.dart`, `eta_badge.dart`)

| Widget | Purpose | Main parameters |
|---|---|---|
| `MapControlButton` | a rounded-square button over the map with the floating shadow | `icon`, `onTap`, `tooltip`, `active`, `size = 44`, `child` (replaces the icon) |
| `MapControlColumn` | a column of those | `children`, `gap = 10` |
| `MapChip` | a pill chip with a shadow: the `icon` in the `tone` colour, or a tone dot when there's no icon (pulsing with `pulse`) | `label`, `icon`, `tone`, `onTap`, `pulse` |
| `RoundIconButton` (`floating_buttons.dart`) | a 44 px circular floating button with the floating shadow (back, share; `danger` = red fill for SOS) | `icon`, `onTap`, `tooltip`, `danger`, `size = 44` |
| `RecenterPill` (same) | a floating "Recenter" pill with an icon; scales and fades in/out with `visible` and leaves the tree when hidden | `label`, `onTap`, `visible = true`, `icon = near_me_rounded` |
| `EtaBadge` | "4 min" in a rounded pill, led by `icon` when given; `onDark` adds the floating shadow | `seconds` (null shows "—"), `minuteLabel(int)`, `approximate`, `onDark`, `large`, `icon` |

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
| `IconTile` | `icon_tile.dart` | a shortcut tile (Home, Work, add): the icon in a 26 px tinted square before the label (keeps the 96 px strip height), sublabel below; selected = amber ring | `icon`, `label`, `sublabel`, `onTap`, `onLongPress`, `selected`, `dashed` (an "add" tile, grey square), `width = 96` |

### Settings lists (`section_group.dart`)

| Widget | Purpose | Main parameters |
|---|---|---|
| `SectionGroup` | a titled group of rows in one rounded card; hairlines start after the icon column | `title`, `children`, `margin = bottom 16`, `dividerIndent = 64` (16 for rows without icons) |
| `SettingsIcon` | the leading icon of a row: a 36 px soft rounded square (canvas in light, border grey in dark; tinted 12 % when a colour is given) | `icon`, `color` |
| `SettingsTile` | a row with icon, title, subtitle, chevron | `icon`, `title`, `subtitle`, `trailing`, `onTap`, `destructive` (danger-tinted icon and title), `iconTone` (tints the icon square), `chevron = true`, `badge` |
| `SettingsSwitchTile` | a row with a switch | `icon`, `title`, `subtitle`, `value`, `onChanged` |
| `SettingsValueTile` | a row showing the current value | `icon`, `title`, `value`, `onTap` |
| `ChoiceRow` | one of several choices (language, theme, provider); an `Icon` as `leading` goes into a `SettingsIcon` square, any other widget (an avatar) is drawn as is; selected = amber disc with an ink check | `title`, `subtitle`, `selected`, `onTap`, `leading` |

### Numbers and progress

| Widget | File | Purpose | Main parameters |
|---|---|---|---|
| `AnimatedCounter` | `animated_counter.dart` | a number that rolls to its new value | `value`, `format(num)`, `style`, `duration = 600 ms` |
| `AnimatedMoney` | same | the same for minor units, formatted with `birr()` | `minor`, `style`, `locale` |
| `StatTile` / `StatRow` | `stat_tile.dart` | small stats in a row (today's earnings, trips, time online); the label is led by `icon` (in the tone colour) or a tone bar | `label`, `value` (widget), `icon`, `tone`, `sub`; row: `children`, `gap = 8` |
| `StepperHeader` | `stepper_header.dart` | progress across named steps (driver onboarding) | `steps`, `current`, `done` (set of indexes) |
| `Skeleton.box` / `.line` / `.circle` | `skeleton.dart` | loading placeholders with a shimmer; no shimmer when motion is reduced | box: `width`, `height = 16`, `radius = 8`; line: `width`, `height = 14`; circle: `size` |
| `SkeletonList` | same | rows of avatar + two lines | `rows = 5`, `avatar = true` |
| `SkeletonCard` | same | a card-sized block | `height = 96` |

### Ride shortcuts and search (`quick_actions.dart`, `search_widgets.dart`)

| Widget | Purpose | Main parameters |
|---|---|---|
| `QuickActionCircle` | a round 56 px tinted icon with its label below and a ripple (Trips, Support, Places, Settings); amber-soft with an ink icon by default | `icon`, `label`, `onTap`, `tone`, `badge` (a count), `width = 76` |
| `ServiceTile` | a rounded ~104×88 card with an icon or art over a label; selected = amber ring on amber-soft | `label`, `icon` or `art`, `selected`, `onTap`, `badge`, `width = 104`, `height = 88` (min) |
| `SearchBarButton` | the big rounded "Where to?" bar: search icon, hint, optional trailing chip ("Now ▾") with its own tap; floating shadow (or flat with `elevated: false`); `heroTag` wraps it in a `Hero` | `hint`, `onTap`, `trailingLabel`, `trailingIcon = schedule_rounded`, `onTrailingTap` (defaults to `onTap`), `heroTag`, `elevated = true` |
| `SuggestionRow` | a place suggestion: 40 px icon circle, title, subtitle, distance on the right, ripple | `title`, `subtitle`, `icon = place_rounded`, `distance`, `onTap`, `onLongPress`, `trailing`, `highlight` (amber circle) |
| `placeIcon(category, type)` | the icon for a place by its Nominatim class and kind (`Place.category` / `Place.type`): airport, church (places of worship), hotel, bus stop, train, hospital (clinics, doctors, pharmacies), school (universities, colleges), shopping bag (any shop), food (restaurants, cafés, bars), bank, fuel, museum, park; `place_rounded` otherwise | |

### Vehicle classes (`vehicle_card.dart`)

| Widget | Purpose | Main parameters |
|---|---|---|
| `VehicleClassCard` | a class in the choose-ride carousel (~132 wide): `VehicleArt`, name, seats, `EtaBadge`, price (the fare struck through above the payable amount, in green, when discounted); selected = 2 px amber ring, `raised` shadow and a 1.03 spring scale | `code`, `name`, `fareMinor`, `payableMinor`, `seats`, `etaSeconds`, `minuteLabel`, `selected`, `onTap`, `locale`, `width = 132`, `badge` |

### Motion (`motion.dart`)

Each one collapses to no motion when the system asks for less. The newer animated widgets (`VehicleClassCard`, `ServiceTile`, `RecenterPill`, `SharedAxisSwitcher`) do too.

| Widget | Purpose | Main parameters |
|---|---|---|
| `FadeSlideIn` | fade + slide up on first build | `child`, `delay`, `offset = 0.08`, `duration = slow` |
| `PopIn` | scale in with a small overshoot | `child`, `delay` |
| `Pulse` | a gentle repeating pulse | `child`, `scale = 1.06` |
| `Shake` | shake sideways once when `trigger` changes (wrong code) | `child`, `trigger` |
| `AnimatedSwitcherX` | cross-fade with a size change, keyed by the child | `child`, `duration = slow`, `alignment = topCenter` |
| `SharedAxisSwitcher` | a shared-axis switch between keyed children: the new one slides in along `axis` while the old one slides out the other way, fading through (`AnbessaMotion.sharedAxis`); `reverse` for going back; a plain swap when motion is reduced | `child`, `axis = horizontal`, `reverse`, `duration = medium`, `distance = 30`, `alignment = topCenter` |
| `RadarPulse` | expanding rings (finding a driver, going online) | `color`, `size = 120`, `rings = 3` |

### Ticking texts (`ticking.dart`)

Small widgets that rebuild only themselves once a second, so a countdown never rebuilds its screen. The timer pauses while the widget sits in a muted `TickerMode` (an offstage tab or route). All take `now` (a clock, for tests).

| Widget | Purpose | Main parameters |
|---|---|---|
| `TickingBuilder` | calls `builder(context, now)` every `interval`; stops once `stopWhen(now)` is true | `builder`, `interval = 1 s`, `now = DateTime.now`, `stopWhen` |
| `Countdown` | the time left until `until` as text (never negative); stops at zero; `onDone` once when it gets there (not if it started at zero) | `until`, `format(Duration)` (e.g. `mmss`), `style`, `onDone`, `textAlign` |
| `ElapsedText` | the time since `since` as text | `since`, `format(Duration)`, `style`, `textAlign` |

`Pulse`, `PulsingDot` and `RadarPulse` repeat forever, so widget tests that show them cannot use `pumpAndSettle` (see `apps/phone-app/docs/testing.md`).
