# Design system

Source: `packages/core/lib/src/ui/`. The look follows the licensed **GoRide – Ride-Hailing App UI Kit** (see "GoRide-based design" below) with our colours: one amber (#FFB300, ink #17191D on it) where GoRide uses green, our warm neutrals for its greys, red for destructive actions and the destination. Urbanist type, fully rounded pill buttons, filled borderless fields, white pages with hairline cards (dark: charcoal pages with lifted grey cards). Rider and driver share one palette per brightness.

**Icons.** Meaningful icons are back: rows, tiles, pills, notices, banners, toasts, stats and buttons lead with an icon when the call site gives one (Material Symbols through Flutter's `Icons.*_rounded` variants; no extra icon package). Icons are decoration for sighted people and are excluded from semantics where the words already say the same thing. Every widget that takes an `icon` keeps it optional where it was optional before; the APIs did not change.

**Vehicle art.** Our own flat side-view cars (drawn for this project in the kit's chunky flat style, not traced) live in `packages/core/assets/vehicles/{economy,comfort,minivan,generic}.svg` (160×64 viewBox; amber body `#FFB300`, lower band `#E59E00`, white windows, tyres `#2B2F36`, hubs `#E6E3DC`; economy carries a taxi roof sign). `VehicleArt` paints the body with `tint` and greys the hubs in dark mode. The folder is registered in the core pubspec and loaded with `package: 'ride_app_core'`.

**Font.** Urbanist (SIL OFL 1.1, from google/fonts `ofl/urbanist`; static 400/500/600/700/800 instances cut from the variable font with fontTools) is bundled in this package: `assets/fonts/Urbanist-*.ttf`, licence `assets/fonts/OFL-Urbanist.txt`. Use it through `anbessaFontFamily` (`'packages/ride_app_core/Urbanist'`); `anbessaTheme` does. Noto Sans Ethiopic (bundled by the app) is the fallback for Amharic.

## Tokens (`theme/tokens.dart`)

### Spacing, `AnbessaSpace`

| Name | xs | sm | md | lg | xl | xxl | xxxl | page |
|---|---|---|---|---|---|---|---|---|
| px | 4 | 8 | 12 | 16 | 20 | 24 | 32 | 20 (screen gutter) |

### Sizes, `AnbessaSize`

| Name | button | buttonCompact | field | rowIcon | segmented | chip | topBar | navBar |
|---|---|---|---|---|---|---|---|---|
| px | 56 | 40 | 56 | 48 | 44 | 40 | 64 | 68 |

### Radius, `AnbessaRadius`

| Name | sm | md | lg | xl | sheet | pill |
|---|---|---|---|---|---|---|
| px | 8 (segmented tabs, badges) | 12 (inputs, list cards, ride tiles, route card) | 16 (big cards) | 24 (dialogs) | 28 (bottom sheets) | 100 (buttons, chips) |

`anbessaRadiusSm`, `anbessaRadius`, `anbessaRadiusLg` (8, 12, 16) are kept for older call sites.

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

The kit's sizes (430 pt frames) scaled ×0.89 to phones, Urbanist, no letter spacing.

| Style | Size | Weight | Height | Kit use |
|---|---|---|---|---|
| `display` | 28 | 700 | 1.25 | hero headlines ("Welcome Back! 👋", onboarding titles) |
| `h1` | 24 | 700 | 1.3 | sheet / result headlines ("Driver is heading to your location…", "You have arrived!") |
| `h2` | 20 | 700 | 1.3 | app bar titles, dialog and sheet titles, "Where to?" |
| `title` | 16 | 700 | 1.35 | list and card titles ("GoRide Car", "Theo Holland"), list values |
| `body` | 16 | 500 | 1.45 | body text, field values, key–value rows |
| `body2` | 14 | 500 | 1.45 | secondary text, chips |
| `label` | 12 | 600 | 1.25 | nav labels (11), badges |
| `caption` | 13 | 400 | 1.4 | grey subtitles ("New York, NY 10012…", "3–5 mins") |
| `button` | 16 | 700 | 1.2 | pill button labels |

`AnbessaType.tabular` is `[FontFeature.tabularFigures()]` for money and ids. `monoFamilyFallback` lists JetBrains Mono, Roboto Mono, DejaVu Sans Mono, Menlo, monospace.

## Palettes (`theme/anbessa_theme.dart`, `theme/dark_palette.dart`)

`AnbessaColors` is a `ThemeExtension` with 20 colours. Read it with `context.colors`; `context.isDark` tells the brightness.

| Token | Light | Dark |
|---|---|---|
| `canvas` | #F6F5F1 (paper) | #111214 |
| `surface` | #FFFFFF | #1A1C1F |
| `surface2` | #FAF9F6 (filled fields) | #222428 |
| `border` | #EEECE7 (hairlines) | #2F3237 |
| `borderStrong` | #D9D6CF (handles, off switches) | #45494F |
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

GoRide roles (getters; screens should prefer these names): `page` (screens, sheets, nav bar: `surface`, i.e. white / #1A1C1F), `groupedPage` (a page of white cards such as Account or Payment methods: `canvas` in light, `page` in dark), `field` (filled inputs, segmented track, OTP boxes: `surface2`), `cardFill` / `cardBorder` (white + `border` hairline in light; `surface2` with no visible border in dark), `neutralFill` (dark-mode "Skip"/"Call"/"Cancel": `border` in dark, `canvas` in light), `tonalFill` / `onTonal` (light: `accentSoft` with `accentText`; dark: `neutralFill` with `text`, as the kit greys its tonal buttons in dark), `accentText` (amber that reads as text: #8F5B00 on light surfaces, 5.7:1 on white; `accent` in dark), `selectedFill` (selected card tint: #FFF8E5 / amber at 12 %).

Derived: `isDark` (canvas luminance < 0.2), `brightness`, `primaryFill` (the fill of the main call to action: `accent`, amber, in both modes), `onAccent` (what reads on `primaryFill`: ink #17191D in both modes, about 10:1), `onAmber` (ink, for text on `accent`). `lerp` interpolates every colour, so theme changes animate.

`test/theme_test.dart` checks that the text colours reach 4.5:1 on every surface in both palettes, that ink on amber reaches 7:1, that `accentText`, tonal and neutral labels and field text reach 4.5:1, that filled buttons are amber pills and outlined buttons ink, and that the font is Urbanist.

## Theme (`anbessaTheme`)

```dart
ThemeData anbessaTheme({Brightness brightness = Brightness.light, String? fontFamily = anbessaFontFamily, List<String> fontFamilyFallback = const ['NotoSansEthiopic']})
```

Material 3, `ColorScheme.fromSeed(accent)` overridden with the palette (primary = amber, onPrimary = ink, surface = `page`, surfaceContainerHighest = `field`…). The app passes no arguments except `brightness` (`apps/phone-app/lib/app.dart`). Urbanist is bundled by this package; Noto Sans Ethiopic by the app (Inter is no longer bundled).

What it sets:

- Text theme from `AnbessaType`, all in `text` colour with the Ethiopic fallback (`displayLarge` 32, `displayMedium`/`headlineLarge` = display, `headlineMedium` = h1, `titleLarge` = h2, `titleMedium` = title, `bodyLarge` = body, `bodyMedium` = body2, `bodySmall` = caption in `muted`, `labelLarge` = button).
- Scaffold and canvas: `page` (white / #1A1C1F).
- Page transitions: `FadeForwardsPageTransitionsBuilder` on Android, Linux, macOS, Windows; Cupertino on iOS.
- App bar: `page`, no elevation or tint, **centred** 20/700 title, 64 tall, 24 px ink icons (use `AppTopBar`).
- Cards: `cardFill`, radius 12, 1 px `cardBorder`.
- Filled buttons: amber stadium, ink 16/700 label, 56 tall, 24 px side padding; disabled grey. Outlined: stadium, 1.5 px `border`, ink label ("Continue with Google"). Text buttons: `accentText` 16/600 (links: "Sign in", "Hide details").
- Inputs: filled `field`, **no border**, radius 12, padding 20×18, 1.5 px amber border when focused, red on error, `faint` 16/400 hint, `text2` icons.
- Bottom sheets: `page`, 36×4 `borderStrong` handle, top radius 28. Dialogs: `page`, radius 24.
- Navigation bar: `page`, 68 tall, no indicator, labels always shown (11 px); selected icon amber and label `accentText` bold; others `muted`. Same for `BottomNavigationBar`.
- Chips: stadium, 1.5 px `border` outline; selected = amber fill, ink label.
- Snack bars: floating white card (dark: `surface2`) with shadow (elevation 6), ink 16 px text, `accentText` action, radius 12.
- Switch: amber track + white thumb when on, `borderStrong` (dark: `border`) track when off, no outline. Checkbox: 2 px amber outline when empty, amber fill with ink tick when checked, radius 6. Radio, slider, progress, tab indicator: amber.
- Popup menus: white / `surface2` card, radius 12, elevation 8 (the kit's Edit / Delete menu).
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
| `PrimaryButton` | the main amber pill (a `PillButton`, `danger` → `PillVariant.danger`) with a busy state and an optional leading icon (hidden while busy) | `label`, `onPressed`, `busy`, `icon`, `danger`, `trailing` (text on the right, e.g. the price) |
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
| `PillTabs<T>` | `pill_tabs.dart` | the older name of `SegmentedTabs` (same look); `expand: false` wraps it in `IntrinsicWidth` | `items: [(value, label)]`, `selected`, `onChanged`, `expand = true` |
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

## GoRide-based design

The phone app follows the licensed **GoRide – Ride-Hailing App UI Kit** (commercial licence; the kit's files must not be committed or redistributed: keep the PDF and renders outside the repo). Everything is the kit's except the colours:

| GoRide | Anbessa |
|---|---|
| green primary (#0CC25E), white labels | amber `accent` #FFB300, **ink** labels `onAccent` #17191D |
| green text and links | `accentText` (#8F5B00 light, amber dark) |
| pale green tonal buttons ("Skip", "Sign in") | `tonalFill` (`accentSoft` #FFF4D6) with `onTonal`; **grey** `neutralFill` in dark mode, as the kit does |
| pale green selected card fill (#EDFAF1) + green border | `selectedFill` (#FFF8E5 / amber 12 %) + 1.5 px `accent` |
| white page / sheet / nav (#FFFFFF) | `page` (#FFFFFF) |
| field fill #FAFAFA | `field` (#FAF9F6) |
| grouped page #F5F5F5 behind white cards | `groupedPage` (`canvas` #F6F5F1) |
| hairlines #EEEEEE | `border` #EEECE7 |
| dark page #181A20 / fields and cards #1F222A / grey buttons #35383F | `page` #1A1C1F / `field`, `cardFill` #222428 / `neutralFill` #2F3237 |
| red (cancel, destination, delete) | `danger` |

The kit's frames are 430 × 932 pt; our sizes are its sizes ×~0.89 so a 360–412 dp phone shows the same proportions (`AnbessaType`, `AnbessaSize`, `AnbessaRadius`, `AnbessaSpace.page` = 20 gutter). Measured from the kit: buttons 58 pt → 56, fields ~58 pt → 56, app bar title 24 pt → 20, hero 32 → 28, list titles 18 → 16, subtitles 14 → 13, row icon circles 52 → 48, card / field radius ~12, segmented tab radius ~8, buttons and chips fully rounded.

Rules the screens follow:

- Background `page`; lists of cards on `groupedPage` (Account, Payment methods, Saved addresses); never `canvas` directly.
- Top bar: `AppTopBar` (← + centred title; ✕ + start-aligned title for "Where do you want to go?"; tab roots: logo leading + ⋮ action).
- The main action lives in a `BottomActionBar` (hairline above) at the bottom of form/result screens.
- Forms: `FilledField` with the label above, 24 px between fields.
- Amber is for the main action, selection and live things; text in amber uses `accentText`.
- Icons are outlined (Material `*_outlined` / `*_rounded`), 20–24 px, ink; the selected nav item uses the filled variant.

### Components

All in `lib/src/ui/widgets/`, exported from `ride_app_core`. In the tables, `PillButton.tonal` etc. means `PillButton(variant: PillVariant.tonal)`. `PinBoxes` now draws the kit's OTP boxes (filled `field`, no border; the focused box tinted with a 1.5 px amber border).

| Component | File | What | Main parameters |
|---|---|---|---|
| `PillButton` | `pill_button.dart` | the kit's buttons: 56 tall stadium, 16/700 label, press-scale 0.97 + ripple, busy spinner, disabled grey | `label`, `onPressed`, `variant` (`primary`, `tonal`, `outline`, `outlineDanger`, `neutral`, `outlineNeutral`, `danger`), `icon` / `leading`, `trailing` (price), `busy`, `compact` (40 tall), `expand` |
| `PillButtonPair` | same | two pills side by side ("Skip \| Continue", "Call \| Chat", "Cancel \| Yes, Delete") | `first`, `second`, `gap = 12` |
| `PressScale` | same | the press-in scale on anything (no scale with reduced motion) | `child`, `enabled`, `scale = 0.97` |
| `BottomActionBar` | same | pinned footer: page colour, top hairline, gutter, safe area | `child`, `divider = true` |
| `PrimaryButton` | `basics.dart` | the old API, now a primary (or `danger`) `PillButton` | unchanged |
| `AppTopBar` | `app_top_bar.dart` | back/close + 20/700 title, centred or start, actions, 64 tall | `title` / `titleWidget`, `leadingKind` (`back`, `close`, `none`), `leading` (logo), `onLeading`, `actions`, `centerTitle = true`, `background`, `bottom` |
| `FilledField` / `FieldLabel` | `filled_field.dart` | bold label above a filled, borderless radius-12 field; amber focus border | `label`, `hint`, `controller` / `initialValue`, `icon` (leading), `suffix` (chevron, calendar), `prefix`, `onTap` + `readOnly` (pickers), `validator`, `keyboardType`, `obscureText`, `errorText`… |
| `FilledField.phone` | same | flag + ⌄ + dial code before the number | `dialCode`, `flag`, `onCountryTap`, `controller`, `hint` |
| `SegmentedTabs<T>` | `segmented_tabs.dart` | grey track, equal parts, selected part amber with ink bold label | `items: [(value, label)]`, `selected`, `onChanged`, `height = 44` |
| `OutlineChip` / `ChipRow` | same | outlined stadium chips, optional leading icon (amber text colour), selected = amber fill; a scrolling row with the page gutter | `label`, `icon`, `selected`, `onTap`; row: `children`, `gap = 8`, `padding` |
| `AppCard` | `kit_cards.dart` | the card (white + hairline / lifted grey), radius 12 | `child`, `padding = 16`, `onTap`, `color`, `radius`, `border` |
| `CircleIcon` | same | an ink icon in a hairline circle (48) | `icon`, `size`, `color`, `borderColor`, `fill` |
| `ListRowTile` | same | circle icon, bold title, grey subtitle, right value (+ small sub line), trailing widget, chevron, optional hairline below | `title`, `subtitle`, `icon` / `leading`, `value`, `valueSub`, `valueSubColor`, `trailing`, `chevron`, `onTap`, `divider`, `titleColor` (red "Logout") |
| `SelectableCard` | same | tinted fill + 1.5 amber border + ✓ when selected (payment methods, promos, top-up methods) | `selected`, `child`, `onTap`, `padding`, `showCheck` |
| `KeyValueCard` | same | "label …… value" rows in a card, optional total under a hairline, widgets after values | `rows: [KeyValueCard.row(label, value)]`, `total`, `trailing: {index: widget}` |
| `StatTriple` | same | three circle-icon stats with value + caption in a card | `items: [StatTriple.item(icon, value, caption)]` |
| `OutlineBadge` | same | small outlined badge ("Completed", promo code) | `text`, `danger` |
| `SuccessDialog` / `showSuccessDialog` | `kit_dialogs.dart` | centred card, 72 px amber check circle (red ✕ with `danger`), title, message, OK (optional tonal secondary) | `title`, `message`, `okLabel`, `icon`, `danger`, `secondaryLabel` |
| `ResultBadge` | same | the big round badge alone | `icon`, `danger`, `size = 72`, `ring` |
| `ResultSheet` / `showResultSheet` | same | a sheet whose badge overlaps its top edge ("Promo Code Applied!", "Whoops!", "You have arrived!", "We've found the driver!", "Ride scheduled!") | `title`, `message`, `icon`, `danger`, `badge` (any widget, e.g. avatar or a blue calendar), `child`, `actions` |
| `HandleSheet` / `showHandleSheet` / `SheetHandle` | same | modal sheet frame: 36×4 handle, centred title over a hairline, body | `title`, `titleColor`, `child` |
| `ConfirmSheet` / `showConfirmSheet` | same | red title (destructive), question, optional content, Cancel (tonal) \| Yes (primary); resolves bool | `title`, `message`, `child`, `confirmLabel`, `cancelLabel`, `destructive` |
| `RideClassTile` | `ride_kit.dart` | vertical choose-ride row: art 56, name, ⏱ eta · 👥 seats, price right; discount = amber seal + struck old price; selected = tint + amber border | `code`, `name`, `fareMinor`, `payableMinor`, `etaLabel`, `seatsLabel`, `selected`, `onTap`, `locale`, `art` |
| `RoutePointsCard` | same | pickup (amber dot) / destination (red pin) rows with dotted connector and hairlines in a floating card; + on the last row | `points: [RoutePointsCard.pickup(label), RoutePointsCard.destination(label)]`, `onAdd`, `addTooltip`, `floating` |
| `DriverRow` | same | avatar 52, name 18/700, ★ rating + phone (or `subtitle`), outlined amber chat + call circles | `name`, `photo`, `rating`, `phone`, `subtitle`, `onChat`, `onCall`, `onTap` |
| `CircleActionButton` | same | round outlined amber icon button (or amber-filled `filled`, e.g. chat send) | `icon`, `onTap`, `tooltip`, `size = 44`, `filled` |
| `MapAvatarPin` / `paintAvatarPin` / `avatarPinSize` | `map_markers.dart` | the person: avatar in an amber ring with a tail (widget; painter takes a `ui.Image` photo or initials) | `photo`, `name`, `diameter = 52`, `ringColor` |
| `DestinationPin` / `paintDestinationPin` / `destinationPinSize` | same | red ring pin with a white face and red dot (or a photo) | `diameter = 40`, `color` |
| `TopDownCar` / `paintTopDownCar` / `topDownCarSize` / `topDownCarBody` / `paintTopDownCarShadow` | same | our top-down car: a white body shaded towards its sides, small mirrors, one dark cabin (windscreen, side and rear glass) under the roof, small lights, a soft centred shadow (or none with `shadow: false`; the map draws `paintTopDownCarShadow` as its own layer); broad shapes that read flat and tilted; points north | `width = 22`, `heading` (deg), `body`, `glass` |
| `markerImage` / `markerPngBytes` | same | rasterise any painter above at a pixel ratio (`ui.Image` or PNG bytes) for the map style's `addImage`; the tip of the pins is at the bottom centre (`icon-anchor: bottom`) | `(logicalSize, (canvas, size) => paintX(canvas, size, …), pixelRatio: 3)` |
| `RadarRings` | same | still translucent amber rings + two expanding waves around a child ("Searching your location…", "Finding you a nearby driver…"); still with reduced motion | `size = 240`, `color`, `child`, `period = 2.4 s` |
| `LocatingDot` | same | amber dot in a pale ring (under "Searching…") | `size = 40` |
| `VehicleArt` | `vehicle_card.dart` | the new flat amber side-view classes (economy taxi, comfort sedan, minivan, generic) | unchanged |
| `AppSheet` | `app_sheet.dart` | unchanged API; 36×4 handle, `page` surface, radius 28 | |
| `PillTabs` | `pill_tabs.dart` | now renders `SegmentedTabs` | unchanged |

Theme-only pieces (no widget needed): the bottom `NavigationBar` (4 items, label under icon, selected amber; pass `selectedIcon` filled variants), `Switch` (iOS-like amber), `Checkbox` (amber outline / fill), `Radio` (amber; the cancel-reason list on p. 98 is a `RadioListTile` list), snack bars (white floating card with an amber action, p. 161), popup menus (p. 159).

### Kit page → component map

Page numbers are the kit PDF's (light frame first; the dark twin is listed when it adds something). Use them to place components; layout and spacing come from the frame.

| Kit pages | Screen | Components |
|---|---|---|
| 15, 25 | splash | brand mark on amber, white spinner |
| 16–18, 26–28 | onboarding carousel | `AnbessaType.display` title, `PillButtonPair` (tonal Skip \| Continue), `BottomActionBar` |
| 19, 29 | Let's Get Started | `PillButton.outlineNeutral` with brand `leading` (social), primary "Sign up", tonal "Sign in" |
| 20–21, 30–31, 36–39 | sign up / sign in by phone | `AppTopBar` (← only), display title, `FilledField.phone`, `Checkbox` + `TextButton` links, "or" divider, `BottomActionBar` |
| 22, 32 | OTP | `PinBoxes` (filled boxes, amber focused), countdown in `accentText`, `TextButton` "Resend code" |
| 23–24, 33–34, 168, 173 | Fill Personal Info / Personal Info | `AppTopBar` centred, avatar + edit badge, `FilledField` (`icon`, `.phone`, `readOnly` + `suffix` chevron / calendar) |
| 42, 68 | Enable Location dialog | `SuccessDialog` look with a location `ResultBadge`, primary + tonal |
| 43, 69 | Searching your location | `RadarRings` around `MapAvatarPin`, sheet with `LocatingDot`, `NavigationBar` |
| 44–45, 70–71 | Home "Where to?" | map with `TopDownCar` markers + `MapAvatarPin`, sheet: `AnbessaType.h2` "Where to?", `FilledField` (location icon, read-only), `ChipRow` of `OutlineChip`s, `NavigationBar` |
| 46–47, 72–73 | Where do you want to go? | `AppTopBar(leadingKind: close, centerTitle: false)`, route card of `FilledField`s with a + `CircleActionButton`, `ChipRow` ("Select from map" with map icon), `SegmentedTabs` Recent \| Suggested, `ListRowTile` (pin circle icon, distance `value`, bookmark `trailing`, `divider`) |
| 48, 74 | Set pickup location | map pin, sheet with `ListRowTile` + edit icon, primary "Next" |
| 49–50, 53–54, 75–76, 79–80, 95, 101 | Choose ride | `RoutePointsCard` (with +), `DestinationPin`, route line, `RideClassTile` list (discounted variant 53–54), "Payment … Wallet ›" `ListRowTile`s, `OutlineBadge` promo code, calendar `CircleActionButton` + primary "Book" |
| 51, 77 | Promos / Vouchers picker | `groupedPage`, `AppCard` with field + compact "Redeem", `SelectableCard` promo rows |
| 52, 78 | Choose Payment Method | `groupedPage`, `SelectableCard` rows (logo + name + sub), `BottomActionBar` "OK" |
| 55, 81 | Finding a driver | `RadarRings`, sheet h1 title + grey line, `LocatingDot`, `PillButton.outlineDanger` "Cancel Ride" |
| 56–57, 62, 82–83, 88 | Driver heading / Heading to destination | `TopDownCar` on route, sheet h1 + caption, plate line, `DriverRow`, `KeyValueCard` ×2 (total row), `outlineDanger` Cancel |
| 58, 84, 13 | Driver Information | `AppCard` profile header, `StatTriple`, `KeyValueCard`, `PillButtonPair` (tonal/neutral Call \| primary Chat) |
| 59, 85 | Chat | `AppTopBar` with call/video actions, bubbles (`field` / amber), `FilledField` + `CircleActionButton(filled)` send |
| 60–61, 86–87 | calls | full-bleed photo, round call controls (red hang-up) |
| 63, 89 | You have arrived | `ResultSheet` (red pin badge), `StatTriple`, mood row, primary "Finish" |
| 64–66, 90–92 | Rate driver / tip | `AppTopBar(close)`, avatar, `RatingStars`, `KeyValueCard`s, `TextButton` "Hide details", tip amounts as `OutlineChip`s (selected amber), `PillButtonPair` |
| 14, 67, 93, 99, 105 | Thanks / Ride canceled | `ResultBadge` + display title + message, `BottomActionBar` "OK" |
| 94, 100 | Schedule a Ride | `HandleSheet(title)`, `SegmentedTabs` Today \| Tomorrow \| Select Date, wheel picker (amber selected, hairlines), `PillButtonPair` |
| 96–97, 102–103 | Scheduling / Ride scheduled | `RadarRings` small, `ResultSheet` with a custom blue calendar `badge` |
| 98, 104 | Cancel Ride reasons | `AppTopBar(close)`, `RadioListTile`s (amber), primary "Confirm" |
| 108, 113 | Promos tab | logo-leading `AppTopBar` + ⋮, `AppCard` row with promo icon + chevron, `ChipRow` filters (selected amber), banner cards |
| 109–112, 114–117 | Redeem promo | big code `FilledField` (centred text), `ResultSheet` success / `danger` "Whoops!", `PillButtonPair` (tonal Use Later \| Use Now) |
| 122–124, 128, 132, 135, 138, 140, 142, 144 | Activity tabs | logo `AppTopBar`, `ChipRow` (Ongoing, Scheduled, Completed, Canceled, Top Up), `ListRowTile` (car/scooter circle icon, title, date subtitle, `value` price, `valueSub` method or red "Canceled & Refunded"), ongoing card = `AppCard` + `RoutePointsCard(floating: false)` + `PillButton.outline` "Track Route" |
| 126, 130 | We've found the driver | `ResultSheet` with person badge, `DriverRow(subtitle: car · plate)` |
| 134, 137 | Share Receipt | `HandleSheet(title)`, file row in `field`, avatar strip, social icons |
| 143, 145 | Top Up Details | `AppCard` (+ circle, amount, wallet), `KeyValueCard` with `OutlineBadge` "Completed" and copy icon, `PillButton.outline` "Share Receipt" |
| 148, 152 | Account | `groupedPage`, `AppCard` profile + wallet row with compact `PillButton.outlineNeutral` "Top Up", `AppCard` of `ListRowTile(icon, chevron)` rows (plain icons, no circle: pass `leading: Icon(...)`), red "Logout" |
| 149–150, 153–154 | Top Up / method | amount `AppCard`, amount `OutlineChip`s grid, keypad, `SelectableCard` methods, primary "Confirm Top Up - 250 ETB" |
| 151, 155 | Top Up Successful | `SuccessDialog` |
| 156–167 | Saved Addresses | `AppCard` per address (pin + bold name, share + ⋮, hairline, address), popup menu Edit / red Delete, `ConfirmSheet(destructive)`, snack bar with check + "Undo" compact pill, "Add an Address" sheet with `FilledField`s and `PillButtonPair` |
| 169, 174 | Notifications | `AppCard` of rows with `Switch`es |
| 170, 175 | Account & Security | rows with switches / chevrons / grey descriptions, red "Delete Account" |
| 171–172, 176–177 | Linked accounts / Data & analytics | `AppCard` rows, status text right (`accentText` "Connect") |
| 178–183 | Payment methods / Add payment | `AppCard` rows with logo + "Connected", `FilledField`s in a two-column row, `BottomActionBar` "+ Add New Payment" |

## Brand mark and app icon

The app icon is "Lion Grille": the front of a car whose headlights, nose and grille read as a lion's face, ink on an amber rounded square. Masters live in `packages/core/assets/brand/`: `anbessa_icon.svg` (rounded, in-app logo and web favicon), `anbessa_icon_square.svg` (full-bleed, iOS icons), `anbessa_icon_foreground.svg` (transparent, Android adaptive foreground). `AnbessaMark(size:)` draws it in the app (`AnbessaLogo` in the phone app wraps it). Launcher PNGs were rendered from these masters with ImageMagick: Android `mipmap-*/ic_launcher.png` and `ic_launcher_foreground.png` with `mipmap-anydpi-v26/ic_launcher.xml` (amber `ic_launcher_background`), iOS `AppIcon.appiconset`, web `apps/web/public/favicon.svg` and `apple-touch-icon.png`. Shapes avoid curved strokes so every SVG renderer draws them the same. Re-render after changing a master.
