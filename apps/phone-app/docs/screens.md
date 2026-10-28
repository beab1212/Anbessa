# Screens

Every screen in `apps/phone-app/lib/features`, rider first, then driver, then shared. Paths are under `lib/features/` unless stated. Routes are listed in [architecture.md](architecture.md#route-table); endpoints in [api-usage.md](api-usage.md).

Common patterns:

- Errors are shown with `Problem(error, describe: describeError)`; a retry button appears only for retryable errors.
- Loading uses `Skeleton*` placeholders rather than spinners, except where noted.
- Map screens stack `AnbessaMap` + an `AppSheet`; the sheet's height is fed to the map as the `sheetHeight` listenable. The rider's home, search, choose ride and trip share one map in the rider map shell.

## Bootstrap and sign-in

### SplashScreen (`bootstrap/gates.dart`)

"Headlights in the dark": the whole screen ink `#17191D` (both themes), an animated intro (`SplashIntro`, `bootstrap/splash_intro.dart`) that ends on the app icon ("Lion Grille") with the name under it. No spinner. Shown while `sessionProvider` loads and until the intro's icon has settled.

- Layout: the icon 200×200 (corner radius 46) centred horizontally with its centre at 42% of the screen's height; "Anbessa" (Urbanist ExtraBold 40, letter spacing −0.5, paper `#F6F5F1`, not scaled with the text size; the brand name, never translated) centred 32 px under it.
- Timeline (`SplashTimeline`, `SplashFrame.at(t)`, pure and unit tested; the prototype's 0–100% played once over 3.2 s): 0–10% dark (only the ink car, invisible on ink); 10–22% the headlights (paper circles with ink pupils) flicker on (0 → 1 → 0.15 → 1 → 0.4 → 1) and stay; 20–52% a warm glow (`#FFE7A3`, radius 150) blooms around them (0.55 at scale 1.25 at 30%, 0.35 / 1.1 at 44%, gone at 52%); 32–50% an amber disc grows from the icon's centre over the whole screen, revealing the ink car, holds to 58%, then 58–70% shrinks and morphs into the rounded square (curve `Cubic(.65,0,.2,1)`), overshoots to 212 / 48 at 74% and settles at 200 / 46 at 78%; 48–56% the windshield, nose and grille fade in; 76–86% the name fades in and rises 18 px (`Cubic(.2,0,0,1)`). After the intro, while the app still loads, the headlights' glow breathes (opacity 0 → 0.25 → 0 every 1.6 s).
- The glyph is painted part by part by `LionGrilleArt.paintGlyph` (core, `brand_mark.dart`): the same shapes and coordinates as `packages/core/assets/brand/anbessa_icon.svg`, kept in sync by a core test.
- Routing: `splashHoldProvider` holds the router on `/splash` (only there) until the icon has settled (78%, ≈ 2.5 s); `SplashIntro` releases it, at once with reduced motion. So a fast start waits for the icon, a slow one leaves as soon as the session is known; the redirect's other rules are unchanged.
- Cheap: one `AnimationController` (its value is seconds, linear) drives one `CustomPainter` (the amber disc / square and the glyph) inside a `RepaintBoundary`; the name is a `Text` under a `FadeTransition` / `SlideTransition` on the same controller. Reduced motion (`MediaQuery.disableAnimations`): the final frame (icon and name), nothing moving.
- Semantics: the art is an image labelled "Anbessa" in a live region labelled "Loading" (`accLoading`).
- The native launch screen is the same plain ink with no icon (Android `launch_background.xml` with `@color/splash_ink`, `values*/styles.xml`, and on Android 12+ `values-v31` / `values-night-v31` with `windowSplashScreenBackground` ink and an empty `windowSplashScreenAnimatedIcon`; iOS `LaunchScreen.storyboard` ink with no image), so the hand-off to the animation doesn't flash. The launcher icon's background stays amber.

When the stored session couldn't be checked (no network at a cold start: `sessionProvider` has an error and no value), the router keeps the person here instead of sending them to Welcome. The offline text (`offlineBanner`, paper) and an amber "Try again" pill with ink text (`retry`) that invalidates `sessionProvider` appear under the name (in a region of their own, so the art doesn't move); the glow keeps breathing.

### IntroScreen (`intro/intro_screen.dart`)

The kit's onboarding (pp. 16–18): an amber top with a phone mock-up, a page-coloured panel with a curved top edge over the phone's lower part, the title (`introTitle1–3`, display style, centred), the text (`introBody1–3`), page dots (amber pill for the current page), and `PillButtonPair` Skip (tonal) | Continue in a `BottomActionBar`; the last page shows one "Let's Get Started" pill. The phone's screens are drawn with our own widgets (not kit images): a painted city map with `TopDownCar`s and the rider's `MapAvatarPin`; the payment choices as `SelectableCard`s; a driver's online card with `StatTriple` over a map with a route. Finishing or skipping calls `introSeenProvider.markSeen()` (prefs `intro_seen`) and goes to `/welcome`. Shown only when signed out and the intro was never seen.

### UpdateRequiredScreen (`bootstrap/gates.dart`)

An empty state ("update required") with "Open store": the Play Store URL for `com.anbessa.phone_app`, or `https://apps.apple.com/app/anbessa` on iOS. Shown when `updateRequiredProvider` is true.

### WelcomeScreen (`auth/auth_screens.dart`)

The kit's "Let's Get Started!" (p. 19) without the social sign-in buttons (we sign in by phone and code).

- Shows: a language pill switcher (English / አማርኛ, sets `localeProvider`), the logo, "Let's Get Started!" and its line (centred), a notice when the last session ended (`errorSessionEnded`) or the account was suspended (`errorSuspended`), and at the bottom "Privacy Policy · Terms of Service" (opens `https://<APP_LINK_HOST>/privacy|terms`).
- Actions: "Sign up" (primary) → `/sign-in?new=1`; "Sign in" (tonal) → `/sign-in`; "Drive with Anbessa" (text) → `/sign-in?driver=1`.
- In debug builds with `DEV_LOGIN=on`: a collapsed "dev sign-in" section with `DevSignInPanel`.

### DevSignInPanel (`auth/auth_screens.dart`)

Lists `GET /api/dev/accounts` entries whose `app` is `phone`. Unseeded accounts are disabled. Tapping one runs `send-otp`, `GET /api/dev/code`, `verify`, then `SessionController.signIn`. Loading: skeleton list; error: a warning notice with Retry.

### PhoneScreen (`auth/auth_screens.dart`)

The kit's sign up / sign in (pp. 20–21). `signUp` (`?new=1`) picks the copy: "Join Anbessa Today ✨" with the terms checkbox, or "Welcome Back! 👋".

- Shows: ← only (`AppTopBar`), the display title and a line, "Phone number" as `FilledField.phone` (🇪🇹 +251; digits, spaces, `+`, max 16 chars), the Telegram/SMS hint, (sign up) "I agree to Anbessa Terms & Conditions." with a checkbox, and "Already have an account? Sign in" / "Don't have an account? Sign up" (replaces the page with the other variant, keeping `driver`).
- The pinned "Sign up" / "Sign in" pill is enabled when `toE164` accepts the input (or the input with a leading 0) and, when signing up, the terms are ticked. An invalid number shakes the field and shows `phoneInvalid`.
- Calls `POST /api/auth/phone-number/send-otp`, then pushes `/sign-in/verify?phone=<e164>[&driver=1]`.

### OtpScreen (`auth/auth_screens.dart`)

The kit's OTP page (p. 22) with the system keyboard (no custom keypad).

- Shows: "Enter OTP Code 🔐", "Check your messages! We've sent a one-time code to … ", "Change number" (back), 6 `PinBoxes` sized to the width, "You can resend the code in N seconds" (N in amber text, a 30 s countdown), "Resend code" (grey until the countdown ends), and after 20 s a notice that the code was also sent by SMS.
- Completing the 6 digits calls `POST /api/auth/phone-number/verify`, then `SessionController.signIn` (`GET /api/auth/token`, profile from the verify response). With `driver=1` the mode is set to driver. A 400/401 (other than rate-limited) is shown as "wrong code" and clears the boxes.
- "Resend code" calls `send-otp` again.

### ModeSwitcherScreen (`auth/auth_screens.dart`)

The logo, "How are you using Anbessa today?", and two `SelectableCard`s (Ride, Drive; circle icon turns amber when selected; Ride preselected), then "Continue" in a `BottomActionBar`, which sets `modeProvider`. Shown when the person can drive and has not chosen.

### EnableLocationDialog (`bootstrap/location_prompt.dart`)

The kit's "Enable Location" (p. 42): a white dialog card (radius 24) over the page blurred and dimmed, an amber location `ResultBadge`, "Enable Location", why we ask, "Grant Permission" (primary) and "Maybe Later" (tonal). `app.dart` sets it as `GeolocatorSource.rationale`: the first time in a run that the location permission has not been given, `ensurePermission` shows it before the system prompt; "Maybe Later" returns `denied` without asking the system that time. Later requests in the same run go straight to the system prompt, as before.

## Overlays in both shells

### Banners (`bootstrap/gates.dart`)

Floating under the status bar on every shell page (`shell/shells.dart`), in this order:

1. maintenance (`config.maintenance.newTripsPaused`), with the server message or `newTripsPaused`;
2. "Reconnecting…" (pulsing) while signed in and the socket is `reconnecting`;
3. each announcement whose `audiences` contains the shell's audience (`rider` / `driver`) and that was not dismissed. Dismissing stores the id (prefs `dismissed_announcements`, last 50 kept).

The client does not filter announcements by `cities`, `startsAt` or `endsAt`.

## Rider

### The rider map shell (`rider/shell/rider_map_shell.dart`, `rider/shell/map_intent.dart`)

The rider flow follows the GoRide kit (pages 43–67, dark 69–93, 105) with our colours. Home, search, choose ride and the trip are **stages of one screen** with **one map**: a go_router `ShellRoute` (`riderMapShellRoute`) inside the rider's Home tab, whose child routes `/rider/home`, `/rider/book/route`, `/rider/book/quote` and `/rider/trip/:id` are empty pages. `RiderMapShell` reads the stage from the location (`RiderMapStage.fromUri`) and stacks:

- the map: one `AnbessaMap` fed by the stage's `MapIntent` (pins, routes, the car, nearby cars, follow or fit, callouts, the "finding a driver" rings, whether the rider shows as their avatar pin or a dot or not at all), each derived by its own provider from app state (`homeMapIntentProvider`, `searchMapIntentProvider`, `quoteMapIntentProvider`, `tripMapIntentProvider(id)`). It passes `person` (the session's photo and name: the pickup pin and, on home, "you" are the kit's avatar pin) and `roundControls` (round white recenter button bottom right; the layers button is the shell's, top right on home). The camera fits again only when an intent's `fitKey` changes; a gesture frees it and shows the Recenter pill. On choose ride and the trip the top inset leaves room for the route card and a pin's label.
- the stage's floating pieces (`_StageOverlays`): the layers button (and the announcements bell when riders have announcements; its dot only for unread ones) on home; back on "Select from map"; the `RoutePointsCard` (pickup amber dot, destination red pin; a tap edits that place) with a round "‹" above the sheet on choose ride; the route card with Share and SOS under it on a trip.
- `RiderSheet`: one `AppSheet` driven by an `AppSheetController`. `sheetStopsFor` sizes short stages to their content in pixels, scaled with the text (home ≈ 212 px, "Searching your location…" ≈ 172, "Set pickup location" ≈ 262, finding a driver ≈ 292, a driver on the trip ≈ 300 px or 88 %), choose ride 56/92 %. On a change the sheet glides to its resting size (380 ms), the content switches with a shared-axis transition, and the map is told the height even when the sheet doesn't move (so its insets are right from the first frame).
- what covers the map for a while, in an `AnimatedSwitcher` (fade + small rise): the search page while searching, and the end of a trip (`TripEndLayer`). Both start under the floating banners (`bannerHeightProvider`).
- "Searching your location…": on home before the first position (`riderLocatingProvider`: no fix yet and permission not refused), `RadarRings` around the rider's avatar in the middle of the map and `LocatingSheet` ("Searching your location..." over `LocatingDot`). The kit's "Enable Location" card itself is `bootstrap/location_prompt.dart` (the location source's rationale); the shell records the answer in `riderLocationPermissionProvider`.
- the completion confetti.

The tab bar is hidden on the booking and trip stages (`riderTabsHiddenAt`). Pay and rate stay full-screen pages on the root navigator with a slide-up transition; the driver's photo is a `Hero` (`driverAvatarHeroTag(tripId)`) from the trip sheet to Pay and Rate. Moving animations (nearby cars, the trip's car) are owned by the shell (`CarsAnimator`, one `MarkerAnimator` per trip) and reach the stages through `RiderMapScope`. The rider's position is a stream while the shell is on screen (`riderLocationProvider`).

Map credits: no text strip over any map. A small round "i" (`MapInfoButton`, 28 px, semi-transparent, bottom left above the sheet, clear of the system insets) opens "Map data", a sheet listing the sources of the tiles or imagery on screen (`mapAttributionsOf`: "© OpenFreeMap", "© OpenMapTiles", "© OpenStreetMap contributors"; Esri's line on satellite; the raster tiles' `TILE_ATTRIBUTION`) with links to their terms. MapLibre's own logo and attribution button are off in the plugin on Android and iOS.

Map art (`maps/scene/scene_images.dart`, native `addImage` layers drawn at the device pixel ratio up to 3×, with the core painters): the followed car and the cars around the rider are the kit's white top-down car (`paintTopDownCar`, grey when stale; painted at its largest shown width and only scaled down, its soft contact shadow a separate image and layer under it), the pickup and "you" on home are `paintAvatarPin` (the rider's photo decoded off the frame by `loadAvatarImage`, else initials on amber-soft, else a person glyph), the drop-off is `paintDestinationPin` (red). The person's dot (and heading cone) is still used where the avatar isn't (walking to the car). The road is amber with a thin deeper-amber edge (ink on dark and satellite maps). The raster engine (desktop, tests) uses the matching widgets (`TopDownCar`, `MapAvatarPin`, `DestinationPin`).

Stage changes are logged with `Perf.mark('rider stage <name>')` in debug and profile builds.

### Home (`rider/home/rider_home_screen.dart`: `HomeSheet`, `HomeTopBar`, `LocatingSheet`) — kit p. 43–45, 69–71

- Map: the rider as their avatar pin, followed at zoom 15 until they move the map; the white cars gliding (`CarsAnimator`), "N min" over the nearest. Nearby cars are polled (`GET /api/locations/nearby`) and animated only on the home stage while it is on screen and in the foreground.
- Sheet: "Where to?" (h2), the read-only `FilledField` "Enter location" (pin icon) → the search (drop-off focused), then a `ChipRow` of `OutlineChip`s: Home and Work (→ `bookTo`; when not set, a "+" chip that opens the account's place picker and saves it), the other saved places, and "Later" (flag `scheduledRides`: `startScheduling`).
- Tab bar (`shell/shells.dart`): Home, Activity, Account with outlined icons, the selected one filled amber, small labels, a hairline above.

### Search (`rider/booking/search_sheet.dart`: `SearchPage`, `PinCard`; `pin_picker.dart`) — kit p. 46–48, 72–74

- "Where do you want to go?": a full page over the shell (the map stays alive under it). ✕ (or system back) returns. A card with the pickup field (amber dot; "Current location" by default inside a served city) and the destination field (red pin), then chips: "Select from map", "Use my location" (while the pickup is being filled), Home, Work and the other saved places. The field that opens focused comes from `?focus=pickup|dropoff`. No swap or add-stop button (the kit's + is left out: we have no stops).
- Nothing typed: `SegmentedTabs` Recent | Suggested (Recent: the recent places, swipe left to forget; Suggested: saved places and the city's popular places). Typing ≥ 2 characters searches `GET /api/maps/search` (300 ms debounce, in the rider's served city, UI language; older answers dropped) and lists saved, recent, popular and found places in one list.
- Rows (`ListRowTile`): the place's kind in a hairline circle (`placeIcon`, a pin otherwise), name, address, distance from the pickup (`formatDistance`), and a bookmark that saves the place (`POST /api/trips/places`) or forgets a saved one. States: skeletons while searching, "search down" warning, illustrated "no results".
- Picking a place for one field moves the focus to the other; with both set, `BookingController.quote()` and choose ride **replaces** the search.
- "Select from map" (`PinPicker`): the page gives way to the map with no insets so the camera centre is the place; the centre pin is the rider's avatar pin (pickup) or the red pin (destination), lifting while the map is dragged. 350 ms after it settles the centre is checked against the served cities, snapped to the road for a pickup and named. The sheet (`PinCard`): "Set pickup location" / "Set destination", the place (icon circle, name, address; skeletons while looking), ✎ back to the search, "Next".

### Choose ride (`rider/booking/quote_screen.dart`: `QuoteRouteCard`, `QuoteSheet`, `QuoteFooter`, `ChoosePaymentPage`, `PromoCodePage`) — kit p. 49–54, 75–80

- Map: the road from the estimate draws from the pickup over 600 ms; the camera fits it under the route card and above the sheet; "4 min" at the pickup avatar and "Arrive 14:32" at the red pin (none when booking for later). While re-quoting, the previous road stays dimmed and the rows are skeletons.
- Sheet: `RideClassTile` rows entering one after another (our car art, name, "4 min · 4 passengers", the payable price; a promo price has a seal with the fare struck through; the chosen one tinted with an amber border). Then rows: "Payment … Cash ›" (→ `ChoosePaymentPage`: our methods as `SelectableCard`s with an icon and a line each, OK), "Promos / Vouchers ›" (flag `promos`, the code in use as an `OutlineBadge`; → `PromoCodePage`: the kit's "Have a Promo Code?" card with a field and Redeem, the code in use with Remove; no voucher list), the outcome line, "Pickup time" while booking for later, "Fare details" folding out a `KeyValueCard` (distance, time, base, distance and time fares, discount, total), the company ride's purpose (`FilledField`), "Quote expires in m:ss" (`Countdown`; at zero "Price expired" and "Get a new price").
- Footer: maintenance notice; the round calendar (`CircleActionButton`, flag `scheduledRides`: `chooseRideTime`) and "Book <class>" / "Schedule <class>"; a `policy_violation` shows the server's sentence and "Pay personally instead".
- Request: `POST /api/trips`, then the trip stage (`active_trip_exists` → the active trip; expired or used quotes re-quote). Schedule: `POST /api/trips/scheduled`, a toast, then Activity.

### Trip (`rider/trip/rider_trip_screen.dart`: `TripSheet`, `TripTopBar`, `DriverInfoPage`, `TripEndLayer`) — kit p. 55–58, 62–63, 81–89, 105

The sheet content follows `riderStageOf(trip)` with a shared-axis switch; the sheet settles at the stage's size.

| Stage | Map (`tripMapIntentProvider`) | Sheet |
|---|---|---|
| finding | `RadarRings` with the rider's avatar at the pickup (no pickup pin), the road, the destination pin | "Finding you a nearby driver...", the kit's line, "Searching for m:ss" (`ElapsedText`), `LocatingDot`, "Cancel Ride" (`outlineDanger`) |
| driverAssigned | the white car gliding along its road to the pickup, "N min" over it, the trip's road as a dashed leg, the rider's dot | "Driver is heading to your location...", "Driver will arrive in N min...", "Make Model, Colour · PLATE", the driver row (photo `Hero`, name, ★ rating (count); a tap → Driver Information), the trip PIN card (flag `tripPin`), `KeyValueCard`s Ride/Payment and Trip Fare/Discounts/Total, "Cancel Ride" (the fee note appears by itself when the free window closes) |
| driverArrived | car and pickup | "Your driver is here", "Meet your driver at the pickup point." (and a toast), the same cards |
| inTrip | the road split where the car is (driven grey, ahead amber), "Arrive HH:MM" at the drop-off | "Heading to destination...", "Will arrive at the destination in N min...", "Arrive HH:MM", car line, driver row, cards |
| completed | (covered) | `TripEndLayer`: the dimmed map and the kit's result sheet with a red pin badge: "You have arrived!", the destination, `StatTriple` duration (started → completed), distance, average speed, the ride and fare cards ("Total Paid"), Finish → Pay for mobile money and card, Rate otherwise; confetti |
| cancelled | (covered) | `TripEndLayer`: a page with ✕, a badge, "Ride has been canceled!" (or "No driver this time"), why (the fee when there is one), OK → home |

- Driver Information (`DriverInfoPage`, from the driver row): photo and name, `StatTriple` rating · ratings · class (unknown ones left out), `KeyValueCard` car model, colour, plate. No call or chat: the trip parties carry no phone number and there is no chat.
- Top: the route card; Share (active and not `requested`; on → "share again / stop sharing") and SOS (red, flag `sos`, while `sosAvailable`) as round buttons under it.
- The camera fits each stage once (the rings centred while finding), never as the car moves.
- When dispatch gives the trip to another driver, "Your driver changed" once.
- Cancel: `CancelRideButton` (finding a driver: pinned as the sheet's footer, `TripSheetFooter`, so it is on screen at the sheet's resting size whatever the text size; the driver stages: at the end of the sheet, with the fee note once the free window closes) → `showCancelSheet` (`cancel_sheet.dart`: on the root navigator, `isScrollControlled`, sized to its content up to the screen; the reasons scroll, the title, the fee pill and the red "Cancel trip" / tonal "Keep the trip" pills always show; free for 2 min after the match, 30 ETB after) → `POST /api/trips/:id/cancel` with the reason and an idempotency key (one per trip and reason, so a retry after a dropped reply is the same cancel). The answer replaces the active trip: the stage turns `cancelled` and `TripEndLayer` shows "Ride has been canceled!"; OK clears the ended trip and goes home. A refusal is shown over the button (`Problem`) and the trip stays. A stage change while the reasons sheet is open (the driver arrives) still sends the rider's choice. The driver's cancel uses the same sheet (`driverSide`).
- Providers: `tripViewProvider(id)`, `tripPartiesProvider(id)`, `driverLiveProvider(id)`, `tripEtaProvider(id)`, `featureProvider`.

### PlacePicker (`rider/booking/route_editor_screen.dart`, `/account/places/pick?label=home|work|other`)

The account's full-screen place picker for saving places (`RouteEditorScreen` in saved-place mode): one search field (`SuggestionRow`s with category icons), "Use my location", "Choose on the map" with its own map; the chosen place is returned with `pop`. Older links `/rider/book/route?mode=savedPlace&label=…` are sent here.

### PayScreen (`rider/payments/pay_screen.dart`)

- Opens full-screen over the map shell (slide-up), on a grouped page of the kit's cards: the driver's photo (the `Hero` from the trip sheet), name and plate on top; Rate and Done in a `BottomActionBar`.
- Data: `tripPaymentsProvider(tripId)` = `GET /api/payments/trips/:tripId`, merged with `payment:action_required`, `payment:captured` and `payment:failed` events for this trip; polled every 5 s while the fare payment is open (the provider page has no return URL).
- Cash and corporate trips: an instruction ("pay X in cash to the driver" or "your company pays").
- Digital trips: a three-step tracker (started → approve in <provider> → paid / failed) and, by status:

| Status | Shows |
|---|---|
| pending | progress bar, "starting payment" |
| actionRequired | the event's instructions or "approve in <provider>", "Open payment page" (`checkoutUrl` in an in-app browser view), "waiting for <provider>" |
| retryScheduled | "payment failed, retrying at hh:mm", "Pay now" |
| failed | "you owe this", "Pay now" |
| succeeded / refunded | "paid" (confetti and haptic once) |

- "Pay now": `POST /api/payments/payments/:id/pay` with a new key, then opens the returned `checkoutUrl`.
- "Check status" (while open) refreshes.
- Amounts are `fare.payableMinor` (cash instruction, the big number). The receipt (`ReceiptCard`, two `KeyValueCard`s): trip fare, waiting fee, the promo discount ("Promo code CODE", green, negative) when there is one, total (= payable), method, pickup, drop-off, short trip id.
- "Rate" (once settled: not digital, paid or owed) → `/rider/trip/<id>/rate`; Done clears the ended trip and goes home.
- When the fare stops being open or owed, `paymentDueProvider` is invalidated (clears the Activity dot).

### RatingScreen (`rider/rating/rating_screen.dart`, both sides) — kit p. 64–65, 67

- Rider side: opens full-screen over the map shell (slide-up); the driver's photo is the `Hero` from the trip sheet or Pay.
- ✕ (skip), the photo (104), "How was the driver?" / "How was the rider?", "Help Anbessa do better by rating this trip", five big stars; once rated, "What stood out?" tag chips (`RatingTags.ofDriver` / `ofRider`, positive first for 4–5 stars) and a comment (max 500); the ride and fare cards with "Hide details" / "Show details"; "Give Rate" in a `BottomActionBar`. No tips (unsupported).
- Submit: `POST /api/trips/:id/rating`; `already_rated` counts as done. Then "Thanks for your feedback!" (check badge, "See you on your next trip!", OK).
- Finishing clears the ended trip and goes to `doneRoute` (`/rider/home` or `/driver/home`).

### HistoryScreen "Activity" (`rider/history/history_screens.dart`, both sides) — kit p. 122–124, 128, 132, 135, 138, 140

- Kit layout: `AppTopBar` with the logo on the left, "Activity" centred and ⋮; a scrolling `ChipRow` of `OutlineChip`s **Ongoing / Scheduled / Completed / Cancelled** (selected = amber fill; Scheduled only for riders with flag `scheduledRides`). The first chip with something in it opens (Ongoing, else Scheduled, else Completed) until the person picks one.
- ⋮ menu: the period (all, this week = 7 days, this month = one calendar month back) and, for people who can drive, Rider / Driver. The period filter and day grouping still run in `historyDaysProvider((as, period))` (`groupTripsByDay`), not in `build`.
- Rows (`ActivityTripRow`, a `ListRowTile` with hairlines): the vehicle as an outlined icon in a hairline circle (`TripVehicleIcon`, amber text colour), bold drop-off, grey "28 Oct 2026 · 09:56" (Addis time), the amount on the right with the payment method under it. Riders see what they paid (`payableMinor`), drivers the fare. Cancelled rows show the fee (riders) or the compensation (drivers) over a red line: "Cancellation fee", "Cancelled, no charge", "Cancelled, compensated" or "Cancelled". Tap → the receipt route.
- Ongoing (`OngoingTripCard`): the active trip (`activeTripProvider`, when it belongs to this side) and in-progress trips from the list: the row, a `RoutePointsCard` in a hairline box (`HairlineRouteCard`), and an outline "Track route" pill that opens the live trip (`/rider/trip/:id` or `/driver/trip/:id`).
- Scheduled: `ScheduledRideList` (see Scheduled rides).
- `tripHistoryProvider(as)` = `GET /api/trips?as=rider|driver` (20 per page); the next page loads near the end of the list and when the "loading more" row is shown (a short filtered list still pages). Pull to refresh reloads both lists. A lazily built `ListView.builder` with a key per row.
- States: skeleton, error with Retry, an illustrated empty state per chip ("No trip in progress", "No trips yet", "No cancelled trips").

### ReceiptScreen "Ride details" (`rider/history/history_screens.dart`, both sides) — kit p. 126, 130, 134 (structure)

- `AppTopBar` "Ride details" with a share icon (a text receipt through the share sheet; the kit's share sheet is not built).
- A small non-interactive map with both pins and the trip line; a headline card (drop-off, date, an `OutlineBadge` status: Completed / Cancelled in red / Ongoing); the class row (`VehicleArt`, class, distance · time, the amount and payment method on the right); the route (`HairlineRouteCard`); the other person (`DriverRow`: the driver with rating and car · plate for riders, the rider for drivers).
- `KeyValueCard`s: the times (requested, started, completed, cancelled), distance and trip id; the fare (fare, waiting, promo in green, cancellation fee, payment method) with the total under a hairline. Drivers also get the settlement from `GET /api/payments/trips/:tripId` (commission, VAT, "your balance" in green or red).
- "Help with this trip" (flag `support`), an `AppCard` of `ListRowTile`s: the rider's existing lost-item report (status as the row's small coloured right-hand line), else "I left something" while `lostItemReportable` → `/support/lost-items/report?trip=<id>`; "Report a problem with this trip" → `/support/new?trip=<id>`.

## Driver

### DriverHomeScreen (`driver/shift/driver_home_screen.dart`)

- Map: the driver's own car animated between fixes (`MarkerAnimator`, the screen does not rebuild per fix), followed at zoom 15 until a gesture (then the "Recenter" pill). With an offer: fit to the car, pickup and drop-off once per offer; the way to the pickup dashed (secondary) and the offer's road solid (`GET /api/maps/route` for pickup → drop-off). The screen watches the raw position only while an offer is shown.
- Top chips (with icons): Online (pulsing) / Offline; the balance (wallet icon, amber when `warning`, red when blocked; tap → top up); while online "GPS good" / "GPS poor" and "Reconnecting" when the socket is not connected; "Dev tools" with fake location.
- A balance banner when the state is `warning`, `cashBlocked` or `blocked`, with "Top up" → `/driver/earnings/top-up`.
- The sheet follows the kit (snaps 42 %, 66 %): a headline (h2 + grey line; online adds a radar and a green "Online" pill), today's numbers as a `StatTriple` (net earned, trips, time online ticking every 30 s), and the action pinned in the sheet's footer so it is always visible: the amber `SwipeToConfirm` pill (56 tall) to go online, the grey one to go offline.
- Sheet offline:
  - "You were taken offline: <reason>" when the last session ended for a reason other than `DRIVER`;
  - today's stats (`GET /api/payments/earnings/me?period=today`), each with an icon: net earnings, trips, and time online when a session exists (its own `TickingBuilder`, every 30 s);
  - "Your car", an `AppCard` row (last used, from prefs `last_vehicle_id`, else the first drivable) with Ready / Not eligible and the denial text; tapping opens the vehicle picker (`GET /api/fleet/drivers/me/vehicles`);
  - "No vehicles" notice with "Add vehicle" → onboarding;
  - location errors with "Open settings";
  - amber "Slide to go online" (enabled when the car may drive): asks for notification permission, location permission (`driverOnline`), then `POST /api/fleet/sessions` with an idempotency key kept across network failures; `already_online` refreshes the driver home.
- Sheet online: while searching (online, no offer, no live trip), the rider's "finding a driver" look from the driver's seat: amber `RadarRings` (220 px, key `driver-radar`) pulse around the driver's own position on the map (a `MapOverlay` at the last fix) and the headline is "Looking for trips…" (`drv3LookingForTrips`) with the `LocatingDot` (key `driver-searching`), "Searching for riders near you. Offers appear here." and the car; still rings when motion is reduced. Going offline, an offer arriving or a trip starting stops it (otherwise "Waiting for trips nearby…" with the small radar). Then the stats and "Slide to go offline" (`DELETE /api/fleet/sessions/current`; a 404 counts as offline).
- `OfferSheet` (`driver/offers/offer_sheet.dart`) replaces the sheet while there is an offer or an "expired/cancelled" notice (shown 4 s), laid out like the kit's choose-ride sheet. It springs up (`SpringSlideIn`, `AnbessaMotion.springDescription`; a fade when motion is reduced): handle, "New trip" over the fare as the hero, the route (`HairlineRouteCard`), a class card (`VehicleArt`, class, trip distance and time, minutes to the pickup, the payment pill), an `OfferRing` (its own `AnimationController` running down smoothly to `expiresAt`; only the ring repaints, and the sheet rebuilds once at zero to disable the slide), "Slide to accept" as the amber pill (`POST /api/trips/:id/accept` with a key; `offer_closed` / `invalid_state` show "expired"), a tonal "Decline" pill (`POST /api/trips/:id/decline`, errors ignored). Accepting sets the active trip, and the router opens the trip screen.
- `ShiftController` follows the server's session: every 60 s while online it refreshes `GET /api/fleet/drivers/me`; when the session closes on the server, it stops streaming and keeps the end reason.
- Socket: `trip:offer`, `trip:offer_expired`, `trip:offer_cancelled` (offers), `location:update` (pings).

### VehiclePickerSheet (`driver/shift/vehicle_picker_sheet.dart`)

A `HandleSheet` ("Car") of `SelectableCard`s with each car's `VehicleArt`, plate and model; ineligible ones are dimmed with the denial message in red and cannot be picked; fleet cars are labelled.

### DriverTripScreen (`driver/trip/driver_trip_screen.dart`)

- Keeps the screen on while open when the "Keep screen on" preference is on (`wakelock_plus`).
- Guidance runs from the location stream, never from `build`: `navigationProvider(NavTarget)` listens to `lastPositionProvider` itself; the screen `ref.listen`s to its state and hands the car animator the position matched to the route and the road's bearing, the voice guide the state, and the map a tick when the route or the ETA minute changes. A widget test counts the screen's builds over 40 s of fixes (at most one).
- Map: the car glides along the guidance route (`MarkerAnimator` with the nav route); the camera drives with it in navigate mode (`FollowMode.driverBearing`: tilted, turned, car in the lower third, zoom by speed; `driver` when "Turn the map the way I'm driving" is off); a gesture frees the camera and shows the "Recenter" pill; the "Overview" chip fits the car and the target. The driven part (grey) and the rest (amber) split at the animated car's position (re-split every 3 m; only the map subtree rebuilds). An ETA callout at the target. Without a route yet: a straight line. The trip line is drawn as a secondary leg on the way to the pickup.
- Top: `TurnBanner` (tap → `TurnListSheet`, live) while navigating; back (ended trips) and SOS (flag `sos`, while `sosAvailable`, so also for 30 min after drop-off) as `RoundIconButton`s; chips "Follow / Overview" and "Directions" (external app, asking which one when the preference is "ask"); a mute / unmute `RoundIconButton` for voice guidance (prefs `nav_voice`).
- Sheet, like the kit's "Driver is heading to your location…" from the driver's seat (snaps 42 %, 80 %): a centred h2 headline per stage ("Trip accepted", "Head to the pickup", "Waiting for the rider", "Driving to the destination", "Trip done", "Trip cancelled") with the address under it, fixed in the sheet's header; the stage's actions as pills in the footer (always visible); in between the nav summary (time and distance left, "Arrive 14:32"; "You have arrived" within 40 m), the rider (`DriverRow`: avatar, name, "method · amount"; a call button only if `kMaskedCallsEnabled`, which is false), and under the fold the route (`HairlineRouteCard`) and a `KeyValueCard` (fare, promo, payment method, trip length). The slides keep `SwipeToConfirm` (amber pills, 56 tall); cancel and no-show are red outline pills.

| Stage | Actions |
|---|---|
| accepted | "Slide: on my way" → `POST /api/trips/:id/en-route`; "Cancel trip" |
| toPickup | straight-line distance to the pickup (green within 150 m; its own widget, rounded to 10 m), "Slide: arrived" → `POST /api/trips/:id/arrive` (the server checks the position); "Cancel trip" |
| waitingAtPickup | waiting timer on a ring (its own `TickingBuilder`, the screen doesn't tick), "free until 3:00" then "rider is waiting"; "Slide to start" → PIN sheet when `tripPin` is on (4 `PinBoxes`), then `POST /api/trips/:id/start {pin}`; "No-show" enabled after 5 min (counts down before) → cancel with `NO_SHOW` |
| inTrip | "Slide to complete" → `POST /api/trips/:id/complete` with a key kept across retries |
| completed | "Collect X cash" (cash; X is `fare.payableMinor`, the fare minus the rider's promo discount, which the platform covers), "Company pays", or "Rider pays digitally"; "Rate rider" → `/driver/trip/<id>/rate`; "Back to driving" |
| cancelled | "cancelled by <side>", the compensation earned if any, "Back to driving" |

- Driver cancel reasons: noShow, wrongPickup, safety, other (no fee shown). The cancel key is kept for the screen's lifetime.
- Each action replaces the active trip with the response; errors are shown in the sheet.
- `trip:reassigned` for this trip (dispatch moved it to another driver): `ActiveTripController` drops the active trip and sets `tripReassignedProvider`; the screen shows "This trip was moved to another driver.", clears it and goes to `/driver/home`.
- APIs: the transitions above, `GET /api/trips/:id/parties`, `GET /api/maps/route?steps=1` (navigation).

### EarningsScreen (`driver/earnings/earnings_screens.dart`)

- Kit language: logo `AppTopBar` "Earnings", `SegmentedTabs` today / this week / this month (`GET /api/payments/earnings/me?period=`); a centred hero card (net earnings, the bar chart `EarningsChart` when the period has more than one day); a `StatTriple` (trips, gross fares, cash collected); "Where it went" as a `KeyValueCard` (fares, −commission and −VAT in red, net as the total).
- Incentives (`incentivesProvider` = `GET /api/payments/incentives/me?cityId=<current city>`, hidden when empty or failing): a titled card; per program the name, "Earn X" in amber, "<vehicle> trips only" when limited, a `ProgressMeter`, "N of M trips", and "Ends <time>" / "Starts <time>" / "Ended. Counting your trips." / "Earned X" / "Ended. Target not reached."; the settle note under it.
- "Balance" with the state pill on the right, then a card (`GET /api/payments/balances/me?cityId=`): "balance zero", "you owe X" (red) or "we owe you X", the state text, prepaid minimum or the limits, open dues, a `PillButtonPair` "Statement" (needs an account) | "+ Top up", the suggested top-up.
- A card of rows: payout method (needs an account), the bank reference code (on the right), "Top-ups"; "payouts weekly above X" under it.
- Pull to refresh reloads the balance and the summary. Skeletons; errors with Retry. The balance updates on `balance:topped_up` and 3 s after a `trip:status` completed or cancelled.

### TopUpScreen — kit p. 149–151

The kit's Top Up: the amount big and centred in a card (prefilled with the suggested top-up) with "Balance: X" under it, amount `OutlineChip`s, "Choose a top-up method" as `SelectableCard`s (providers from `GET /api/payments/methods` that take mobile money; "simulated" shown), "Pay X" in the `BottomActionBar`. If the balance has no account yet it is opened first (`GET /api/payments/balances/me?open=true`). Then `POST /api/payments/balances/:accountId/top-ups` with a key, opens the `checkoutUrl`, and polls `GET /api/payments/top-ups/:id` every 5 s until it is no longer open. Result: an amber ✓ `ResultBadge` with "X added", a red ✕ "Whoops!" with the failure, or in progress with the instructions and an outline pill to reopen the page; "Done" in the footer.

### PayoutMethodScreen

Provider as `SelectableCard`s (telebirr, CBE Birr, "Bank account (Chapa)"), a `FilledField` destination (at least 6 digits), "Save" in the `BottomActionBar` → `PUT /api/payments/balances/:accountId/payout-method`, refresh the balance, pop.

### StatementScreen

`GET /api/payments/balances/:accountId/statement` (30 per page, more on scroll) as Activity-style rows: the entry kind's icon in a circle (red for money out), the kind in words, "date · time · memo", the signed amount. Skeleton, error with Retry, illustrated empty state.

### TopUpsScreen — kit p. 142

`GET /api/payments/balances/:accountId/top-ups` once, as the kit's Top Up rows: + in a circle, channel and provider, date · time, the amount with the status under it (green / amber / red). Empty state when there is no account or no top-up.

### OnboardingHubScreen (`driver/onboarding/onboarding_screens.dart`)

- `AppTopBar` (back only when there is somewhere to go back to). A card with the `StepperHeader` (Apply → Documents → Vehicle → Review) from `OnboardingProgress`, a progress ring and "next step" with one pill: Apply, Upload, Add a car, or Submit (`POST /api/fleet/drivers/me/submit`, enabled when nothing is missing).
- Pending review: "waiting for review". Active: an approved celebration with "Go online".
- The review note, then titled cards of `ListRowTile`s (`KitGroup`, `core/ux/kit_group.dart`): the application (name, licence, status as the row's small coloured right-hand line), the driver documents checklist (✓ / upload / pending circle icons → documents screen), the vehicles (→ vehicle screen; fleet cars are not tappable) and "Add a car".
- Pull to refresh: `GET /api/fleet/drivers/me` and a forced JWT refresh (roles may have changed).

### ApplyScreen

Stepper, the lede, `FilledField`s with labels above (full name ≥ 3 chars, licence number ≥ 4), the city (a filled dropdown, default the current city), "Apply" in the `BottomActionBar`. `POST /api/fleet/drivers/apply`, refresh, pop.

### DocumentsScreen

One `AppCard` per kind from `GET /api/fleet/documents?subjectType=&subjectId=`: thumbnail (`GET /api/fleet/documents/:id/url`, images only, via `cached_network_image`), status, reject reason, expiry, compact pills "View" / "Upload" (amber) / "Replace" (tonal). Upload: a `HandleSheet` with camera and gallery rows, max width 2000, quality 85, refused above 10 MB, an expiry date picker for kinds that expire, then sha256 → `POST /api/fleet/documents/upload-url` → `PUT` the bytes with progress → `POST /api/fleet/documents {ticket, expiresAt}`.

### VehicleFormScreen

`FilledField`s (plate; make | model and year | colour side by side, as the kit's card form), the vehicle type as cards with the class's `VehicleArt` (selected = tint + amber border), seats as `OutlineChip`s, "Register the car" in the `BottomActionBar`. `POST /api/fleet/vehicles` (always `ownerType: INDIVIDUAL`), then replaces itself with the vehicle screen.

### VehicleScreen

`GET /api/fleet/vehicles/:id` twice (once as `Vehicle`, once as `Checklist`): a card with the `VehicleArt`, plate, label, year, seats, status; the review note; the document checklist (→ documents screen, reloads on return); "Submit for review" (`POST /api/fleet/vehicles/:id/submit`).

### VehiclesScreen (`driver/vehicles/vehicles_screen.dart`)

The cars from `driverHomeProvider` (own and fleet) as cards like the kit's ride-class tile (`VehicleArt`, plate · model, status pill, "Fleet car" badge, › for own cars → vehicle screen); + in the top bar → `/driver/onboarding/vehicle/new`. Pull to refresh. Empty state with "Add a car".

## Shared (account)

### AccountScreen (`profile/account_hub_screen.dart`)

The kit's Account (p. 148 light, p. 152 dark) on `groupedPage`, in a relaxed layout: `AppTopBar` with the logo on the left, "Account" centred and ⋮ (Personal Info, the mode switch, Sign out). A 20 px page gutter, 12 px above the first card, 24 px between sections and 32 px at the end.

- **Profile card** (`AppCard`, its own widget so the rating, count and balance arriving rebuild only it, roomy: 18 px sides, 16 px above and below the row): the photo (64 px, `Hero` tagged `me-avatar`, `meAvatarHeroTag`; Personal Info carries the same tag), the name, ☏ phone, "★ 4.9 (128) · 12 trips" (rating from `GET /api/trips/me/rating`), chevron; tap → `/account/profile`. **Drivers** (who can drive) get a hairline and the balance row: wallet circle, the balance (`balanceProvider`, red when negative), "Available balance", and a compact outlined "Top up" pill → `/driver/earnings/top-up`.
- **Trip count** (`tripCountProvider(as)`): there is no count endpoint, so it is one light page, `GET /api/trips?as=…&limit=20`, shown as "N trips", or "20+ trips" when the page has a `next` cursor. If the Activity list (`tripHistoryProvider`) is already loaded its numbers are reused without a request. The hub never watches the full history list, so paging through Activity doesn't rebuild it. It re-counts when a trip ends (the same key as the payment badge).
- **Small titled cards** (`AccountSection`: a small muted title, `relaxSection*`, over an `AppCard`; hairlines between rows start past the icon) of `AccountRow`s (at least 60 px tall: the icon in a soft 40 px circle, neutral, or tinted by `tone`; bold title, optional grey line / value / badge, chevron):
  - **Ride** (rider): the mode row ("Switch to driver", or "Become a driver" with its lede; amber tint), Saved Addresses, Scheduled rides (flag `scheduledRides`), Payment Methods. **Driving** (driver): "Switch to rider" (amber), Vehicles, Navigation, Earnings, Lost items (flag `support`).
  - **Preferences**: Notifications, App Appearance, Language (current value).
  - **Safety & support**: Emergency contact (red tint, the name or "Not set"), Help & Support (flag `support`) → `/support`.
  - **Account**: Account & Security (`/account/security`), Organizations (names, invitation badge).
  - Then Logout on its own quiet card (red tint, no chevron) asking with a `ConfirmSheet` (red title, Cancel | Yes, Sign out), and the version footer.
- The sub-screens share the relaxed spacing: `AccountPage` (20 px gutter, 12 above, 32 below), `CardColumn` (switch rows of at least 60 px with soft hairlines, 20 px under each card), `OptionCard` / payment cards (18 px inside, 14 px apart), `AccountLede` (20 px under it), Account & Security rows (18 px, a hairline between them), Saved Addresses (12 px above, 32 below).
- The quick-action circles of the previous design are gone; Activity is the nav bar's tab.

### ProfileScreen "Personal Info" (`profile/profile_screen.dart`)

The kit's Personal Info (p. 168): ← "Personal Info", the photo (104 px, `me-avatar` Hero) with an amber edit badge; tap → a `HandleSheet` with take a photo, choose from gallery, remove (red). The image is picked at 256 px, quality 70, sent as a JPEG data URL; if it is over 48 KB the gallery picker opens again at 160 px, quality 50. "Full Name" `FilledField` (≥ 2 chars), "Phone number" as a disabled `FilledField.phone` with a note that it is the sign-in number, "Save" pinned (enabled when the name changed). `POST /api/auth/update-user`. Email, gender and date of birth from the kit are left out (no backend fields).

### LanguageScreen (`profile/account_screens.dart`)

English or Amharic as `OptionCard`s (`SelectableCard` with a circle icon); sets `localeProvider`. `AccountPage` (grouped page, kit top bar, optional pinned footer), `AccountLede` and `OptionCard` are the shared pieces of these pages.

### AccountSecurityScreen (`/account/security`)

The kit's Account & Security (p. 170) with what we have: "Device Management" with its grey line → `/account/sessions`; "Delete Account" in red with its line (flag `accountDeletion`) → `/account/delete`. The kit's biometric/2FA/password/deactivate rows are left out (no backend).

### SessionsScreen "Device Management"

`GET /api/auth/list-sessions`: one card per session (device icon, user agent, date and IP, a red "Sign out" → `POST /api/auth/revoke-session`), "Sign out everywhere else" pinned as an outlined red pill (`POST /api/auth/revoke-other-sessions`).

### PaymentPreferencesScreen "Payment Methods"

The kit's Payment Methods (p. 178): the providers that take mobile money as `SelectableCard`s (circle icon, name, "simulated" when so); the preferred one is tinted with "Preferred" in amber text, the others say "Choose". `GET` / `PUT /api/payments/me/preferences`. No "Add New Payment" (cards are not stored).

### SavedPlacesScreen "Saved Addresses" (`profile/saved_places_screen.dart`)

The kit's Saved Addresses (pp. 156–161) on `groupedPage` (`GET /api/trips/places`):

- A card per place: amber pin, bold name, share (a text with the address and an OpenStreetMap link) and ⋮ (Edit / red Delete), a hairline, the address. Home and Work always show; when unset the card says "Not set. Tap to add." with a + instead of the actions.
- "+ Add Address" pinned at the bottom → the place picker (`/account/places/pick`) → the "Add an Address" sheet (p. 157): the picked place in a card (tap → choose again on the map), Name (other places only), Address Details ("e.g. Floor, unit number", appended to the address), Cancel | Save Address. Home and Work save with `PUT /api/trips/places/home|work`, others with `POST /api/trips/places`; editing another place adds the new one and removes the old (there is no update endpoint).
- Delete: a `ConfirmSheet` (red "Delete Address", "Sure you want to delete this address?", the card, Cancel | Yes, Delete) → `DELETE /api/trips/places/:id`, then a snack bar "Address deleted!" with an amber "Undo" pill that saves it again.
- `pickAndSavePlace` (pick and save in one go) stays for the home sheet's "Set home/work".

### AppearanceScreen, NotificationsScreen, SafetyScreen, NavigationPrefsScreen, OrganizationsScreen (`profile/preference_screens.dart`)

| Screen | Contents |
|---|---|
| App Appearance | System, Light, Dark as `OptionCard`s |
| Notifications | the kit's p. 169: one card of `SwitchRow`s (title, optional grey line, switch): trip updates, sound (stored only), vibrate on new offer, haptic feedback (applied), then "By notification" and "By SMS" for offers and news (`marketingPrefsProvider`: `GET` / `PUT /api/notifications/me/marketing`; a switch flips at once and goes back with a toast if the server refuses; skeleton while loading, error with retry); grey notes under the card |
| Emergency contact | a red-badge header and the lede, "Contact name" and "Contact phone" `FilledField`s (validated with `toE164`), Save pinned, a red "Remove" when one is set |
| Navigation | a card of switches ("Turn the map the way I'm driving", "Keep the screen on while driving"), then the navigation app as `OptionCard`s: ask every time, Google Maps, Waze, system maps |
| Organisations | pending invitations as cards with Decline (tonal) \| Accept (Better Auth accept/reject; accept refreshes the JWT), the person's organisations as cards with status, and, with more than one company, a choice of the default company (prefs `billing_org_id`) |

## Help and safety (`support/`, support-service)

All of them talk to `SupportRepository` / `SafetyRepository` (`support/support_repository.dart`), whose defaults call `SupportApi` through `apiClientProvider`; tests override the two providers. The routes live under `/sos` and `/support`, which the router lets through in either mode and during an active trip.

### SosScreen (`support/sos_screen.dart`, `/sos?trip=<id>`)

- Entry: the SOS button on both trip screens (flag `sos`). The trip is `?trip`, else the active trip.
- Kit result layout: ✕ `AppTopBar` "Emergency", a red SOS `ResultBadge`, the lede centred. "Call 991" (`tel:991`) is the red pill pinned in the `BottomActionBar`, before and after an alert. The page is a `SingleChildScrollView` (built whole), not a lazy list.
- "Alert Anbessa safety" is a `HoldToConfirm` pill (red outline, fills red while held): it fires after a **2 s hold** (the fill drains if the finger lifts early); screen readers trigger it with a long press. Enabled while `sosAvailable(trip)` (a trip that could not be loaded counts as available: the server decides). Otherwise a caption says it works during a trip and 30 min after.
- Sending: the position is the last one seen if under 2 min old, else one fix (permission asked, 8 s at most), else any last position, else the trip's pickup (drop-off once in progress or completed) with a 2 km accuracy and a notice that the area was sent. `POST /api/support/sos` with the trip id, the position, the trip's `cityId` (so the alert is accepted unverified when trip-service is down) and one `Idempotency-Key` per screen, reused by "Send the alert again".
- After sending: a badge (red shield, amber once seen, ✓ when closed), a status pill (Alert sent / Safety team on it / Closed), "Help is coming" or "The safety team has your alert", the sent and seen times, a notice for a duplicate alert. `GET /api/support/sos/:id` every 5 s (`sosPollEvery`) until RESOLVED, then the outcome (false alarm, assisted, passed to emergency services). A failed poll shows "Can't refresh the status right now" and keeps polling. While live, a newer `lastPositionProvider` (> 30 m from the last one sent) goes to `POST /api/support/sos/:id/location`.
- Failure: "We couldn't send the alert. If you're in danger, call 991 now.", the error, and "Send the alert again".
- The alert is remembered per trip for the app run (`sosAlertsProvider`), so reopening the screen shows its state and resumes polling.
- The emergency contact (Account → Safety), when set, is a card row with a call `CircleActionButton`.

### SupportScreen "Help" (`support/support_screens.dart`, `/support`)

A lead card (support circle icon, "How can we help?", the lede, amber "Contact support" pill), then `KitGroup` cards: "Your requests" (`GET /api/support/me/tickets`, first 50: chat icon, subject, "#ref · category · updated <time>", the status as the row's small coloured right-hand line: Received, In progress, Waiting for you, Answered, Closed) and the rider's lost-item reports (`GET /api/support/me/lost-items`, `viewerRole` RIDER). Pull to refresh; skeleton; error with retry; an empty state; a warning notice to call 991 in danger.

### NewTicketScreen (`/support/new[?trip=<id>]`)

- Category as `SelectableCard`s with outlined circle icons (`ticketCategoriesForApp`: a trip, payment, safety, your account, feedback; LOST_ITEM is not offered and a caption points to the receipt). Safety shows "call 991 first".
- "About a trip": "Not about a trip" or one of the 10 latest trips of the current mode (a filled row opening a `HandleSheet` over `tripHistoryProvider`, ✓ on the chosen one); preselected and category "A trip" when opened from a receipt.
- Message: a `FilledField` (5–5000 characters); "Send" in the `BottomActionBar`; a failure opens the kit's red "Whoops!" `ResultSheet` (`showWhoops`, `support_widgets.dart`). The subject is the message's first line, cut to 80 characters.
- Send → `POST /api/support/tickets` with `cityId` = the current city when there is no trip, `as` = `DRIVER` in driver mode for an account with the `DRIVER` role (else `RIDER`) when there is no trip; one key per distinct content (an unchanged retry reuses it). Then the ticket's thread replaces the form.

### TicketScreen (`/support/tickets/:id`)

`GET /api/support/tickets/:id`. Subject, status pill, category and date; "We asked you something" when waiting for the requester; "Our answer" with the resolution note once answered; the thread (the description first, then public messages: yours on the right, "Anbessa support" on the left, system lines centred). While open: a reply box (`POST .../messages`). Answered ≤ 7 days ago: an outline "Reopen" pill asks for a reason (`POST .../reopen`). Later or closed: "This request is closed" and "Contact support". Pull to refresh.

### ReportLostItemScreen (`support/lost_item_screens.dart`, `/support/lost-items/report?trip=<id>`)

The trip as a route card and a "When" `KeyValueCard`, "What did you leave?" (`FilledField`, 3–2000 characters), "Send to the driver" in the `BottomActionBar`, a lock note that the driver sees the text but not the phone number. Disabled with a notice when the trip completed more than 7 days ago. `POST /api/support/lost-items` with a key, then the report replaces the form. `already_reported` / `report_window_closed` are shown as errors.

### LostItemScreen (`/support/lost-items/:id`)

`GET /api/support/lost-items/:id`. A headline card (bag icon, what was left, the date, the status pill), what happens next for the viewer (rider or driver side), then the actions as pills (the note is a `FilledField`). A successful action opens the kit's amber ✓ "Sent!" sheet (`showSuccessSheet`) with what happens next:

| Viewer | Status | Action |
|---|---|---|
| rider | found | "I got it back" → `POST .../status {status: RETURNED}` |
| driver / fleet | reported | an optional note, "I found it" and "It's not in the car" → `POST .../respond {found, note?}` |
| driver / fleet | not found | "I found it" |
| driver / fleet | found | "It's not in the car" |

The messages (no names or numbers; "You", "Driver", "Rider", "Car owner", "Anbessa support") and a reply box until the report is closed (`POST .../messages`).

### DriverLostItemsScreen (`/support/lost-items`)

Account → Lost items in driver mode: the reports whose `viewerRole` is DRIVER or FLEET, with description, date and status → the report. Pull to refresh, skeleton, retry, empty state.

## Scheduled rides (`rider/scheduled/`)

### ScheduledRidesScreen (`scheduled_rides_screen.dart`, `/scheduled`)

Account → Scheduled rides: `AppTopBar`, the bookings as `ScheduledRideList` (the rows of Activity's Scheduled chip), "Schedule a ride" (`startScheduling`, as the home chip) and "Book from 30 minutes to 7 days ahead." in the `BottomActionBar`. Skeleton, error with Retry, an empty state ("No rides booked"; in Activity it carries its own "Schedule a ride" pill). Pull to refresh.

`ScheduledRideTile` (kit p. 124/128): the vehicle circle, the drop-off, "class · booked price · method", the pickup time on the right with the day under it; under the row the status pill (Booked, Finding a driver, Driver search started, Cancelled, Couldn't book), "Driver search starts at hh:mm" while booked, and a red "Cancel booking" while `cancellable` (status SCHEDULED): the kit's `ConfirmSheet` (red title, "free until we start looking for a driver", Keep it | Cancel booking), then `POST /api/trips/scheduled/:id/cancel` and "Booking cancelled"; a failure shows the error and refreshes the list.

`ScheduledRidesController` (`scheduled_rides_controller.dart`): `GET /api/trips/scheduled?status=upcoming&limit=50` while signed in and the flag is on (else empty, no request); refreshed on every `scheduled:status` and on reconnect. A `scheduled:status` DISPATCHED with a `tripId` also refreshes the active trip, so the router opens the trip being matched. `added` inserts a new booking in time order; `cancel` removes it.

## Flagged modules (`flagged/flagged_modules.dart`)

| Screen | Entry point | What it does |
|---|---|---|
| DeleteAccountScreen | account (flag `accountDeletion`) | a warning and a delete button; `AccountRepository.requestDeletion()` answers `not_available` |

Scheduled rides and promo codes left this file once trip-service and pricing-service had them. There is no rider "promotions" list or redeem endpoint, so the former Promos and Redeem screens (and their home chip, account tile and `/promos` routes) are gone; codes are entered on the quote screen.
