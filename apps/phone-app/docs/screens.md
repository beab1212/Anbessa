# Screens

Every screen in `apps/phone-app/lib/features`, rider first, then driver, then shared. Paths are under `lib/features/` unless stated. Routes are listed in [architecture.md](architecture.md#route-table); endpoints in [api-usage.md](api-usage.md).

Common patterns:

- Errors are shown with `Problem(error, describe: describeError)`; a retry button appears only for retryable errors.
- Loading uses `Skeleton*` placeholders rather than spinners, except where noted.
- Map screens stack `AnbessaMap` + an `AppSheet`; the sheet's height is fed to the map as the `sheetHeight` listenable. The rider's home, search, choose ride and trip share one map in the rider map shell.

## Bootstrap and sign-in

### SplashScreen (`bootstrap/gates.dart`)

The logo (the አ mark on amber), the app name and a small spinner. Shown while `sessionProvider` loads; the router moves on.

When the stored session couldn't be checked (no network at a cold start: `sessionProvider` has an error and no value), the router keeps the person here instead of sending them to Welcome. The spinner is replaced by the offline text (`offlineBanner`) and a "Try again" button (`retry`) that invalidates `sessionProvider`.

### IntroScreen (`intro/intro_screen.dart`)

Three pages on first launch (illustrations `carWaiting`, `wallet`, `celebrate`; titles `introTitle1–3`), a page indicator, "Skip" and "Next" / "Start". Finishing or skipping calls `introSeenProvider.markSeen()` (prefs `intro_seen`) and goes to `/welcome`. Shown only when signed out and the intro was never seen.

### UpdateRequiredScreen (`bootstrap/gates.dart`)

An empty state ("update required") with "Open store": the Play Store URL for `com.anbessa.phone_app`, or `https://apps.apple.com/app/anbessa` on iOS. Shown when `updateRequiredProvider` is true.

### WelcomeScreen (`auth/auth_screens.dart`)

- Shows: a language pill switcher (English / አማርኛ, sets `localeProvider`), the logo, title and lede, a notice when the last session ended (`errorSessionEnded`) or the account was suspended (`errorSuspended`).
- Actions: "Sign in with phone" → `/sign-in`; "Drive with Anbessa" → `/sign-in?driver=1`.
- In debug builds with `DEV_LOGIN=on`: a collapsed "dev sign-in" section with `DevSignInPanel`.

### DevSignInPanel (`auth/auth_screens.dart`)

Lists `GET /api/dev/accounts` entries whose `app` is `phone`. Unseeded accounts are disabled. Tapping one runs `send-otp`, `GET /api/dev/code`, `verify`, then `SessionController.signIn`. Loading: skeleton list; error: a warning notice with Retry.

### PhoneScreen (`auth/auth_screens.dart`)

- Shows: a fixed "🇪🇹 +251" prefix and a phone field (digits, spaces, `+`, max 16 chars).
- "Send code" is enabled when `toE164` accepts the input (or the input with a leading 0). An invalid number shakes the field and shows `phoneInvalid`.
- Calls `POST /api/auth/phone-number/send-otp`, then pushes `/sign-in/verify?phone=<e164>[&driver=1]`.

### OtpScreen (`auth/auth_screens.dart`)

- Shows: 6 `PinBoxes`, "change number" (back), a 30 s resend countdown ring, and after 20 s a notice that the code was also sent by SMS.
- Completing the 6 digits calls `POST /api/auth/phone-number/verify`, then `SessionController.signIn` (`GET /api/auth/token`, profile from the verify response). With `driver=1` the mode is set to driver. A 400/401 (other than rate-limited) is shown as "wrong code" and clears the boxes.
- "Resend" calls `send-otp` again.

### ModeSwitcherScreen (`auth/auth_screens.dart`)

Two cards, Ride and Drive. Tapping sets `modeProvider`. Shown when the person can drive and has not chosen.

## Overlays in both shells

### Banners (`bootstrap/gates.dart`)

Floating under the status bar on every shell page (`shell/shells.dart`), in this order:

1. maintenance (`config.maintenance.newTripsPaused`), with the server message or `newTripsPaused`;
2. "Reconnecting…" (pulsing) while signed in and the socket is `reconnecting`;
3. each announcement whose `audiences` contains the shell's audience (`rider` / `driver`) and that was not dismissed. Dismissing stores the id (prefs `dismissed_announcements`, last 50 kept).

The client does not filter announcements by `cities`, `startsAt` or `endsAt`.

## Rider

### The rider map shell (`rider/shell/rider_map_shell.dart`, `rider/shell/map_intent.dart`)

Home, search, choose ride and the trip are **stages of one screen** with **one map**: a go_router `ShellRoute` (`riderMapShellRoute`) inside the rider's Home tab, whose child routes `/rider/home`, `/rider/book/route`, `/rider/book/quote` and `/rider/trip/:id` are empty pages. `RiderMapShell` reads the stage from the location (`RiderMapStage.fromUri`) and stacks:

- the map: one `AnbessaMap` fed by the stage's `MapIntent` (pins, routes, the car, nearby cars, follow or fit, callouts, the radar pulse), each derived by its own provider from app state (`homeMapIntentProvider`, `searchMapIntentProvider`, `quoteMapIntentProvider`, `tripMapIntentProvider(id)`). The camera fits again only when an intent's `fitKey` changes; a gesture frees it and shows the Recenter pill.
- the stage's floating bar (`_StageOverlays`): the home bar and the nearby chip, a back button (choose ride, pin mode), share and SOS (trip).
- `RiderSheet`: one `AppSheet` driven by an `AppSheetController`. Each stage has its snap points (`sheetStopsFor`: home 40/62/92 %, search 50/94 % resting at 94 %, pin mode 30/50 %, choose ride 52/94 %, trip 42/86 %); on a stage change the sheet glides to the new resting size (380 ms) and the content switches with a shared-axis transition (`SharedAxisSwitcher`), header and footer with a fade. The sheet height goes to the map as a `ValueListenable` (`sheetHeight`), never through a screen rebuild.
- the completion confetti.

The tab bar is hidden on the booking and trip stages (`riderTabsHiddenAt`), as when these were separate pages. Pay and rate stay full-screen pages on the root navigator with a slide-up transition; the driver's photo is a `Hero` (`driverAvatarHeroTag(tripId)` = `driver-avatar-<tripId>`) from the trip sheet to Pay and Rate. Moving animations (nearby cars, the trip's car) are owned by the shell (`CarsAnimator`, one `MarkerAnimator` per trip) and reach the stages through `RiderMapScope`. The rider's position is a stream while the shell is on screen (`riderLocationProvider`, `LocationProfile.rider`), so the blue dot moves.

Stage changes are logged with `Perf.mark('rider stage <name>')` in debug and profile builds.

### Home (`rider/home/rider_home_screen.dart`: `HomeSheet`, `HomeTopBar`, `NearbyChip`)

- Map: the rider's live dot, followed at zoom 15 until they move the map; the nearby cars gliding (`CarsAnimator`), with "N min" over the nearest when the nearby response has an ETA. Nearby cars are polled (`GET /api/locations/nearby`, every 10 s and when the rider moves 150 m) and animated only on the home stage while it is on screen and the app is in the foreground.
- Top bar: the avatar and a greeting by time of day (→ Account tab), and a bell (`RoundIconButton`, dot when riders have announcements) opening the announcements list (closed ones dimmed; an illustrated empty state).
- Above the sheet: "3 cars nearby · ~4 min" (`MapChip`), "…" while the first poll loads, nothing when none.
- Sheet: `SearchBarButton` "Where to?" → search (drop-off focused). Its "Now ▾" chip opens the pickup time picker (`chooseRideTime`: Now or a day and time in the booking window, Addis time) when the flag `scheduledRides` is on, and shows the chosen time; otherwise it opens the search. `ServiceTile`s: Ride (→ search), Later (flag `scheduledRides`: `startScheduling`), Places (→ `/account/places`). Then `SuggestionRow`s: Home and Work ("Set home/work" when empty → the account's place picker, then saved), other saved places (star), and up to 5 recent places (their category icon, or a clock; swipe left to forget), each with the distance from the rider. Tapping a place calls `bookTo`: it becomes the drop-off; with a pickup (the one chosen, or the rider's position inside a served city) straight to choose ride, else the search with the pickup focused. Long-press a saved place → `/account/places`.
- Providers: `homePlaceProvider`, `workPlaceProvider`, `savedPlacesProvider`, `recentPlacesProvider`, `bookingProvider`, `nearbyCarsProvider`, `riderLocationProvider`, `featureProvider`, `configProvider`, `currentSessionProvider`.

### Search (`rider/booking/search_sheet.dart`: `SearchHeader`, `SearchSuggestions`, `PinCard`; `pin_picker.dart`)

- The sheet rises to 94 % (the map stays behind it). Header: back, the pickup field (amber dot) and the drop-off field (ink square) joined by a line, and a swap button whose arrows turn with a spring (`BookingController.swap()`, which re-quotes when both are set). The pickup defaults to "Current location" when the rider is inside a served city. The field that opens focused comes from `?focus=pickup|dropoff`.
- Typing ≥ 2 characters searches `GET /api/maps/search` (300 ms debounce, in the served city that contains the rider: `riderCityProvider`, else the first city; UI language); an answer for an older query is dropped. Rows (`SuggestionRow` in a `ListView.builder` with a key per row): "Use my location", "Choose on the map", then saved places (home, work, star), recent places, the city's common places and the search results, each led by `placeIcon(category, type)` (airport, church, hotel, bus stop, train, hospital, school, shop, food, bank, fuel, museum, park; a pin otherwise) and the distance from the pickup (from the rider while the pickup itself is chosen), haversine on the phone, written by `formatDistance` ("850 m", "2.4 km", "14 km"). States: skeletons while searching, "search down" warning, illustrated "no results".
- Picking a place for one field moves the focus to the other; with both set, `BookingController.quote()` and choose ride **replaces** the search. Drop-offs go to the recent places (with their category, so the icon comes back).
- "Choose on the map" (`PinPicker`): the sheet becomes a small card, the map loses its insets so the camera centre is the place under the pin. The pin lifts while the map is dragged and drops with a spring when it stops; 350 ms after the map settles the centre is checked against the served cities (`outsideServiceArea`), snapped to the road for a pickup (`GET /api/maps/snap`) and named (`GET /api/maps/reverse`); a lookup for a centre the rider has since left is dropped. The card shows the place (its icon, name, address; skeletons while looking) and "Confirm pickup / drop-off". Back (the button or the system back) returns to the list.

### Choose ride (`rider/booking/quote_screen.dart`: `QuoteHeader`, `QuoteSheet`, `QuoteFooter`)

- Map: the road from the estimate draws from the pickup over 600 ms (a growing prefix of the line, `routePrefix`; at once with reduced motion), the camera fits the whole road above the sheet; callouts "4 min" at the pickup (the shortest pickup ETA among the classes) and "Arrive 14:32" at the drop-off (now + the chosen class's pickup ETA + the ride's duration, local time: `arriveAt`); none when booking for later. While re-quoting (a place changed), the previous road stays on the map dimmed (`lastQuoteRouteProvider`) and the cards are skeletons.
- Header: both places, "distance · time", Edit (→ the search, replacing this stage).
- A horizontal carousel of `VehicleClassCard`s entering one after another: our car art per class (`VehicleArt`), seats, the pickup ETA (hidden when booking for later), the payable price with the undiscounted fare struck through when a promo lowered it; the chosen class has the amber ring.
- "Fare breakdown" folds out: distance and time, base, distance and time fares, the promo discount, "minimum fare applied".
- Rows: pickup time (flag `scheduledRides`, `chooseRideTime`: out-of-window times give `errorTooSoon` / `errorTooFarAhead`), payment method, promo code (flag `promos`; the promo sheet, `applyPromo` checks the format first so a malformed code is never sent; the outcome line under the row), the company ride's purpose (method "Company account": "Your company asks for this" when the policy says `requirePurpose`, the button disabled while empty).
- "Quote expires in m:ss" is a `Countdown`: only that text ticks; when it reaches zero the sheet shows "Price expired" and the button becomes "Get a new price".
- Footer: a maintenance notice when new trips are paused (the button disabled); the amber "Request <class>" or "Schedule <class>" button with the payable price; a `policy_violation` shows the server's sentence and "Pay personally instead".
- Request: `POST /api/trips` (quote id, method, org id, purpose, the booking's idempotency key, reused after a failure), then the trip stage. `active_trip_exists` goes to the active trip; `quote_expired` / `invalid_quote` / `quote_used` fetch a new quote. Schedule: `POST /api/trips/scheduled` with `scheduledFor`, a toast, then Activity.
- Quoting: `POST /api/pricing/estimates` for the vehicle types offered where the pickup is, with the promo code in use; the first estimate runs after the first frame. Payment methods: `GET /api/payments/methods` for the city (fallback cash), plus "Company account" when the flag `corporateBooking` is on and the JWT has an org id (`billingOrgId` = the first org id).

### Trip (`rider/trip/rider_trip_screen.dart`: `TripSheet`, `TripTopBar`)

The sheet content follows `riderStageOf(trip)` with a shared-axis switch, and the sheet settles at its resting size on every stage change.

| Stage | Map (`tripMapIntentProvider`) | Sheet |
|---|---|---|
| finding | radar pulse at the pickup, the trip's road | "Requested" pill with the time searching (`ElapsedText`), "Finding your driver", drop-off and estimate, Cancel |
| driverAssigned | the car gliding along its road to the pickup (`MarkerAnimator` snapped to the road from `tripEtaProvider`, else a straight line), "N min" over it, the trip's road as a dashed secondary leg | progress (matched → on the way → arrived → riding), "<driver> is on the way" with the ETA, "live" or "position stale" (checked every 5 s), the driver card: photo (`Hero`), name, `RatingSummary`, colour, make and model, `PlateBadge`; the PIN (flag `tripPin`), fare and method, Cancel (the fee note appears by itself when the free window closes) |
| driverArrived | car and pickup | the same card, "<driver> has arrived" (and a toast) |
| inTrip | the road split where the car is: driven in grey, ahead in amber; "Arrive HH:MM" at the drop-off | "On the way to <drop-off>", an "Arrive HH:MM" pill, driver and plate, fare and method |
| completed | both pins and the road | the driver's photo, the total (`AnimatedMoney`), the promo line, "paid by", Pay or Receipt → `/rider/trip/<id>/pay`; confetti |
| cancelled | both pins | "No driver found" or "cancelled by <side>", the fee, Done |

- No call button: the trip parties carry no phone number.
- Top: back once the trip ended; Share (a `RoundIconButton`; active and not `requested`; on → "share again / stop sharing") and SOS (red `RoundIconButton`, flag `sos`, while `sosAvailable`).
- The camera fits each stage once (and again when the car's road or its first position arrives), never as the car moves; after a gesture it stays free with the Recenter pill.
- When dispatch gives the trip to another driver, "Your driver changed" once.
- Cancel: `showCancelSheet` (free for 2 min after the match, `_cancelFeeMinor` = 30 ETB after), `POST /api/trips/:id/cancel` with a new key.
- Providers: `tripViewProvider(id)` (trip, stage, last car sample, ETA), `tripPartiesProvider(id)`, `driverLiveProvider(id)`, `tripEtaProvider(id)`, `featureProvider`.

### PlacePicker (`rider/booking/route_editor_screen.dart`, `/account/places/pick?label=home|work|other`)

The account's full-screen place picker for saving places (`RouteEditorScreen` in saved-place mode): one search field (`SuggestionRow`s with category icons), "Use my location", "Choose on the map" with its own map; the chosen place is returned with `pop`. Older links `/rider/book/route?mode=savedPlace&label=…` are sent here.

### PayScreen (`rider/payments/pay_screen.dart`)

- Opens full-screen over the map shell (slide-up), with the driver's photo (the `Hero` from the trip sheet), name and plate on top.
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
- Amounts are `fare.payableMinor` (cash instruction, the big number). A receipt card (`ReceiptCard`, also on the receipt screen): fare, waiting fee, the promo discount ("Promo code CODE", green, negative) when there is one, total (= payable), method, pickup, drop-off, short trip id.
- "Rate" (once settled: not digital, paid or owed) → `/rider/trip/<id>/rate`; Done clears the ended trip and goes home.
- When the fare stops being open or owed, `paymentDueProvider` is invalidated (clears the Activity dot).

### RatingScreen (`rider/rating/rating_screen.dart`, both sides)

- Rider side: opens full-screen over the map shell (slide-up) and the driver's photo is the `Hero` from the trip sheet or Pay.
- Shows the other side's name (`tripPartiesProvider`), 1–5 stars, tag chips (`RatingTags.ofDriver` for riders, `ofRider` for drivers; positive tags first for 4–5 stars, negative first otherwise), a comment (max 500), and for riders a "Add a tip" row marked "Coming soon" (`kTipsEnabled` is false).
- Submit: `POST /api/trips/:id/rating`; `already_rated` counts as done. Then a "thanks" illustration with Done. "Skip" finishes without rating.
- Finishing clears the ended trip and goes to `doneRoute` (`/rider/home` or `/driver/home`).

### HistoryScreen (`rider/history/history_screens.dart`, both sides)

- `tripHistoryProvider(as)` = `GET /api/trips?as=rider|driver` (20 per page), next page when scrolled within 400 px of the end, pull to refresh.
- People who can drive see a Rider / Driver switch. A period filter: all, this week (7 days), this month (one calendar month back from today), applied on the loaded trips.
- Riders (flag `scheduledRides`): "Upcoming" above the past trips (`UpcomingRidesSection`, nothing when empty), one `ScheduledRideTile` per booking: pickup time (Addis), status pill (Booked, Finding a driver, Driver search started, Cancelled, Couldn't book), drop-off, pickup, "vehicle · booked price · method", "Driver search starts at hh:mm" while booked, and "Cancel booking" while `cancellable` (status SCHEDULED): a confirmation dialog ("free until we start looking for a driver"), then `POST /api/trips/scheduled/:id/cancel` and "Booking cancelled"; a failure shows the error and refreshes the list. Pull to refresh reloads both lists.
- Trips grouped by day ("Today", "Yesterday", or the date). The grouping and the period filter run in `historyDaysProvider((as, period))` (`groupTripsByDay`, by the day in Addis Ababa), once per page loaded or filter change, not in `build`; the list is a `ListView.builder` (upcoming rides, one card per day, the "loading more" spinner) with a key on every day card and trip row. Tap → the receipt route. Rows show what the rider paid (`payableMinor`) on the rider side and the fare on the driver side.
- States: skeleton list, error with Retry, illustrated empty state.

### ReceiptScreen (`rider/history/history_screens.dart`, both sides)

- A small non-interactive map with both pins and the trip line (straight if none), status pill and date, the driver (photo, name, car, plate) when known, a timeline (requested, started, completed, cancelled, distance), the money.
- Drivers also see the settlement from `GET /api/payments/trips/:tripId`: commission, VAT and "your balance change" (green or red).
- A share button sends a text receipt through the share sheet (the payable amount for riders, the fare for drivers).
- "Help with this trip" (flag `support`): for the rider, the existing lost-item report about this trip (status pill → the report), else "I left something" while `lostItemReportable` (completed ≤ 7 days ago) → `/support/lost-items/report?trip=<id>`; for both sides "Report a problem with this trip" → `/support/new?trip=<id>`. The rider's reports come from `myLostItemsProvider` (`GET /api/support/me/lost-items`).

## Driver

### DriverHomeScreen (`driver/shift/driver_home_screen.dart`)

- Map: the driver's own car animated between fixes (`MarkerAnimator`, the screen does not rebuild per fix), followed at zoom 15 until a gesture (then the "Recenter" pill). With an offer: fit to the car, pickup and drop-off once per offer; the way to the pickup dashed (secondary) and the offer's road solid (`GET /api/maps/route` for pickup → drop-off). The screen watches the raw position only while an offer is shown.
- Top chips (with icons): Online (pulsing) / Offline; the balance (wallet icon, amber when `warning`, red when blocked; tap → top up); while online "GPS good" / "GPS poor" and "Reconnecting" when the socket is not connected; "Dev tools" with fake location.
- A balance banner when the state is `warning`, `cashBlocked` or `blocked`, with "Top up" → `/driver/earnings/top-up`.
- Sheet offline (snaps 32 %, 60 %):
  - "You were taken offline: <reason>" when the last session ended for a reason other than `DRIVER`;
  - today's stats (`GET /api/payments/earnings/me?period=today`), each with an icon: net earnings, trips, and time online when a session exists (its own `TickingBuilder`, every 30 s);
  - the car (last used, from prefs `last_vehicle_id`, else the first drivable) with Ready / Not eligible and the denial text; tapping opens the vehicle picker (`GET /api/fleet/drivers/me/vehicles`);
  - "No vehicles" notice with "Add vehicle" → onboarding;
  - location errors with "Open settings";
  - amber "Slide to go online" (enabled when the car may drive): asks for notification permission, location permission (`driverOnline`), then `POST /api/fleet/sessions` with an idempotency key kept across network failures; `already_online` refreshes the driver home.
- Sheet online: "Waiting for offers" with a radar, the car, the stats, "Slide to go offline" (`DELETE /api/fleet/sessions/current`; a 404 counts as offline).
- `OfferSheet` (`driver/offers/offer_sheet.dart`) replaces the sheet while there is an offer or an "expired/cancelled" notice (shown 4 s). It springs up (`SpringSlideIn`, `AnbessaMotion.springDescription`; a fade when motion is reduced): "New trip" over the fare as the hero, the payment pill and pickup ETA, the class with its `VehicleArt` and the trip distance and time, pickup and drop-off, an `OfferRing` (its own `AnimationController` running down smoothly to `expiresAt`; only the ring repaints, and the sheet rebuilds once at zero to disable the slide), "Slide to accept" (`POST /api/trips/:id/accept` with a key; `offer_closed` / `invalid_state` show "expired"), "Decline" (`POST /api/trips/:id/decline`, errors ignored). Accepting sets the active trip, and the router opens the trip screen.
- `ShiftController` follows the server's session: every 60 s while online it refreshes `GET /api/fleet/drivers/me`; when the session closes on the server, it stops streaming and keeps the end reason.
- Socket: `trip:offer`, `trip:offer_expired`, `trip:offer_cancelled` (offers), `location:update` (pings).

### VehiclePickerSheet (`driver/shift/vehicle_picker_sheet.dart`)

A bottom sheet listing the cars; ineligible ones are dimmed with the denial message and cannot be picked; fleet cars are labelled.

### DriverTripScreen (`driver/trip/driver_trip_screen.dart`)

- Keeps the screen on while open when the "Keep screen on" preference is on (`wakelock_plus`).
- Guidance runs from the location stream, never from `build`: `navigationProvider(NavTarget)` listens to `lastPositionProvider` itself; the screen `ref.listen`s to its state and hands the car animator the position matched to the route and the road's bearing, the voice guide the state, and the map a tick when the route or the ETA minute changes. A widget test counts the screen's builds over 40 s of fixes (at most one).
- Map: the car glides along the guidance route (`MarkerAnimator` with the nav route); the camera drives with it in navigate mode (`FollowMode.driverBearing`: tilted, turned, car in the lower third, zoom by speed; `driver` when "Turn the map the way I'm driving" is off); a gesture frees the camera and shows the "Recenter" pill; the "Overview" chip fits the car and the target. The driven part (grey) and the rest (amber) split at the animated car's position (re-split every 3 m; only the map subtree rebuilds). An ETA callout at the target. Without a route yet: a straight line. The trip line is drawn as a secondary leg on the way to the pickup.
- Top: `TurnBanner` (tap → `TurnListSheet`, live) while navigating; back (ended trips) and SOS (flag `sos`, while `sosAvailable`, so also for 30 min after drop-off) as `RoundIconButton`s; chips "Follow / Overview" and "Directions" (external app, asking which one when the preference is "ask"); a mute / unmute `RoundIconButton` for voice guidance (prefs `nav_voice`).
- Sheet: the rider card (`AvatarImage`, name, the target address with an icon, the fare and payment pill, scaled down rather than squeezing the name at large text); a call button only if `kMaskedCallsEnabled` (false; the parties API has no rider rating, so none is shown). While navigating: time left, distance left and "Arrive 14:32" (`NavSummaryBar`); within 40 m of the target "You have arrived" with what to do next (slide when stopped / slide to complete). All slides are amber.

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

- Period pills: today, week, month (`GET /api/payments/earnings/me?period=`). Net earnings hero, trips, gross fares, cash collected; a bar chart (`EarningsChart`) when the period has more than one day; "where the fare went" (gross, −commission, −VAT, net).
- Incentives (when there are any; `incentivesProvider` = `GET /api/payments/incentives/me?cityId=<current city>`): per program the name, "Earn X", "<vehicle> trips only" when limited, a `ProgressMeter` (green once reached), "N of M trips", and "Ends <time>" / "Starts <time>" / "Ended. Counting your trips." / "Earned X" / "Ended. Target not reached."; a note that trips count once settled and rewards land when the program ends. A failed load hides the section. Pull to refresh reloads it.
- Balance card (`GET /api/payments/balances/me?cityId=`): "balance zero", "you owe X" (red) or "we owe you X", the state text, prepaid minimum or the warning / cash / hard limits, open dues ("overdue" in red), "Top up", "Statement" (needs an account), the suggested top-up.
- Payout method (needs an account), the bank reference code, "Top-ups" list, "payouts weekly above X".
- Pull to refresh reloads the balance and the summary. Loading skeletons; errors with Retry.
- Balance updates on `balance:topped_up` and 3 s after a `trip:status` completed or cancelled.

### TopUpScreen

Amount (prefilled with the suggested top-up), a provider list from `GET /api/payments/methods` (providers that take mobile money; "simulated" shown), "Pay X". If the balance has no account yet it is opened first (`GET /api/payments/balances/me?open=true`). Then `POST /api/payments/balances/:accountId/top-ups` with a key, opens the `checkoutUrl`, and polls `GET /api/payments/top-ups/:id` every 5 s until it is no longer open. Result states: credited (illustration), failed, or in progress with the instructions and a button to reopen the page.

### PayoutMethodScreen

Provider choice: telebirr, CBE Birr, "Bank account (Chapa)"; a destination field (at least 6 digits). Save → `PUT /api/payments/balances/:accountId/payout-method`, refresh the balance, pop.

### StatementScreen

`GET /api/payments/balances/:accountId/statement` (30 per page, more on scroll), grouped by day, signed amounts with the entry kind in words. Skeleton, error with Retry, illustrated empty state.

### TopUpsScreen

`GET /api/payments/balances/:accountId/top-ups` once; channel and provider, amount, status. Empty state when there is no account or no top-up.

### OnboardingHubScreen (`driver/onboarding/onboarding_screens.dart`)

- A `StepperHeader` (Apply → Documents → Vehicle → Review) from `OnboardingProgress`, a progress ring (apply + required documents + a car + submitted), and "next step" with one button: Apply, Upload, Add vehicle, or Submit (`POST /api/fleet/drivers/me/submit`, enabled when nothing is missing for submit).
- Pending review: "waiting for review". Active: an approved celebration.
- The review note (warning), the application (name, licence, status), the driver documents checklist (→ documents screen), the vehicles (→ vehicle screen; fleet cars are not tappable) and "Add vehicle".
- Pull to refresh: `GET /api/fleet/drivers/me` and a forced JWT refresh (roles may have changed).

### ApplyScreen

Full name (≥ 3 chars), licence number (≥ 4), city (from the config, default the current city). `POST /api/fleet/drivers/apply`, refresh, pop.

### DocumentsScreen

One card per kind from `GET /api/fleet/documents?subjectType=&subjectId=`: thumbnail (`GET /api/fleet/documents/:id/url`, images only, via `cached_network_image`), status, reject reason, expiry. Upload: camera or gallery (max width 2000, quality 85), refused above 10 MB, an expiry date picker for kinds that expire, then sha256 → `POST /api/fleet/documents/upload-url` → `PUT` the bytes to the ticket URL with progress → `POST /api/fleet/documents {ticket, expiresAt}`.

### VehicleFormScreen

Plate, vehicle type (from the config), make, model, year, colour, seats. `POST /api/fleet/vehicles` (always `ownerType: INDIVIDUAL`), then replaces itself with the vehicle screen.

### VehicleScreen

`GET /api/fleet/vehicles/:id` twice (once as `Vehicle`, once as `Checklist`): label, year, seats, status, review note, the document checklist (→ documents screen, reloads on return), "Submit for review" (`POST /api/fleet/vehicles/:id/submit`).

### VehiclesScreen (`driver/vehicles/vehicles_screen.dart`)

The cars from `driverHomeProvider` (own and fleet), add button → `/driver/onboarding/vehicle/new`, own cars → vehicle screen. Pull to refresh. Empty state with "Add vehicle".

## Shared (account)

### AccountScreen (`profile/account_hub_screen.dart`)

A GoRide/Yango-style hub on the canvas, under a pinned "Account" app bar. Every row leads with a rounded Material icon in a `SettingsIcon` square.

- **Header** (its own widget, so the rating and count arriving rebuild only it): the photo at 72 px with an amber ring inside a `Hero` tagged `me-avatar` (`meAvatarHeroTag`; `ProfileScreen` carries the same tag, so the photo flies into the profile), the name (h1, one line), the phone, then "★ 4.9 · 128 · 12 trips" (rating from `GET /api/trips/me/rating`). Tap anywhere → `/account/profile`.
- **Trip count** (`tripCountProvider(as)`): there is no count endpoint, so it is one light page, `GET /api/trips?as=…&limit=20`, shown as "N trips", or "20+ trips" when the page has a `next` cursor. If the Activity list (`tripHistoryProvider`) is already loaded its numbers are reused without a request. The hub never watches the full history list, so paging through Activity doesn't rebuild it. It re-counts when a trip ends (the same key as the payment badge).
- **Quick actions** (`QuickActionCircle` row): Trips → the mode's Activity tab; Help → `/support` (flag `support`); rider: Places → `/account/places`, driver: Earnings → the Earnings tab; Settings → `/account/appearance`.
- **Mode**: "Switch to driver", "Become a driver" (with its lede), or "Switch to rider" (amber icon).
- **Ride** (rider): saved places, payment preferences, scheduled rides (flag `scheduledRides`) → `/scheduled`.
- **Drive** (driver): vehicles, navigation, earnings, and "Lost items" (flag `support`) → `/support/lost-items`.
- **Preferences**: language (current value), appearance (current value), notifications. **Safety**: emergency contact (red icon, the contact's name or "Not set"). **Account**: organisations (names, invitation count badge), signed-in devices, delete account (flag `accountDeletion`, "Coming soon"). **Help** (flag `support`) → `/support`.
- **Sign out**: its own card, danger tone, no chevron; a confirmation dialog. Then the version footer ("Version 1.0.0+7").

### ProfileScreen (`profile/profile_screen.dart`)

Avatar (112 px, the `me-avatar` Hero from the account header) with a camera button: take a photo, choose from gallery, or remove. The image is picked at 256 px, quality 70, sent as a JPEG data URL; if it is over 48 KB the gallery picker opens again at 160 px, quality 50. Name field (≥ 2 chars, Save enabled when changed). Phone shown read-only. `POST /api/auth/update-user`.

### LanguageScreen (`profile/account_screens.dart`)

English or Amharic; sets `localeProvider`.

### SessionsScreen

`GET /api/auth/list-sessions`: user agent, date and IP of each session; "sign out this device" (`POST /api/auth/revoke-session`) and "sign out everywhere else" (`POST /api/auth/revoke-other-sessions`).

### PaymentPreferencesScreen

The preferred mobile-money provider: `GET` / `PUT /api/payments/me/preferences`, choices from the providers that take mobile money.

### SavedPlacesScreen (`profile/saved_places_screen.dart`)

Home, Work and other places (`GET /api/trips/places`). Set or change opens the place picker (`/account/places/pick`, `pickAndSavePlace`, also used by the home sheet's "Set home/work"); Home and Work use `PUT /api/trips/places/home|work`, others `POST /api/trips/places`. Swipe or tap the bin to remove (`DELETE /api/trips/places/:id`).

### AppearanceScreen, NotificationsScreen, SafetyScreen, NavigationPrefsScreen, OrganizationsScreen (`profile/preference_screens.dart`)

| Screen | Contents |
|---|---|
| Appearance | System, Light, Dark |
| Notifications | "Offers and news from Anbessa": "By notification" and "By SMS" (`marketingPrefsProvider`: `GET` / `PUT /api/notifications/me/marketing`; a switch flips at once and goes back with a toast if the server refuses; skeleton while loading, error with retry), and "trip, payment and safety messages always come"; then trip updates, sound (stored only); vibrate on new offer, haptic feedback (applied); a note that the first group is kept with the account and the rest on this phone |
| Safety | emergency contact name and phone (validated with `toE164`), save, remove (the remove button uses the "remove place" label) |
| Navigation | "Turn the map the way I'm driving", "Keep the screen on while driving", navigation app: ask every time, Google Maps, Waze, system maps |
| Organisations | pending invitations with Accept / Decline (Better Auth accept/reject; accept refreshes the JWT), the person's organisations with status, and, with more than one company, a choice of the default company (prefs `billing_org_id`) |

## Help and safety (`support/`, support-service)

All of them talk to `SupportRepository` / `SafetyRepository` (`support/support_repository.dart`), whose defaults call `SupportApi` through `apiClientProvider`; tests override the two providers. The routes live under `/sos` and `/support`, which the router lets through in either mode and during an active trip.

### SosScreen (`support/sos_screen.dart`, `/sos?trip=<id>`)

- Entry: the SOS button on both trip screens (flag `sos`). The trip is `?trip`, else the active trip.
- "Call 991" (`tel:991`) is always the first button, before and after an alert.
- "Alert Anbessa safety" is a `HoldToConfirm` button: it fires after a **2 s hold** (the fill drains if the finger lifts early); screen readers trigger it with a long press. Enabled while `sosAvailable(trip)` (a trip that could not be loaded counts as available: the server decides). Otherwise a caption says it works during a trip and 30 min after.
- Sending: the position is the last one seen if under 2 min old, else one fix (permission asked, 8 s at most), else any last position, else the trip's pickup (drop-off once in progress or completed) with a 2 km accuracy and a notice that the area was sent. `POST /api/support/sos` with the trip id, the position, the trip's `cityId` (so the alert is accepted unverified when trip-service is down) and one `Idempotency-Key` per screen, reused by "Send the alert again".
- After sending: a status pill (Alert sent / Safety team on it / Closed), "Help is coming" or "The safety team has your alert", the sent and seen times, a notice for a duplicate alert. `GET /api/support/sos/:id` every 5 s (`sosPollEvery`) until RESOLVED, then the outcome (false alarm, assisted, passed to emergency services). A failed poll shows "Can't refresh the status right now" and keeps polling. While live, a newer `lastPositionProvider` (> 30 m from the last one sent) goes to `POST /api/support/sos/:id/location`.
- Failure: "We couldn't send the alert. If you're in danger, call 991 now.", the error, and "Send the alert again".
- The alert is remembered per trip for the app run (`sosAlertsProvider`), so reopening the screen shows its state and resumes polling.
- The emergency contact (Account → Safety), when set, is offered as a call.

### SupportScreen "Help" (`support/support_screens.dart`, `/support`)

The lede, "Contact support", then "Your requests" (`GET /api/support/me/tickets`, first 50): subject, "#ref · category · updated <time>", a status pill (Received, In progress, Waiting for you, Answered, Closed). Then the rider's lost-item reports (`GET /api/support/me/lost-items`, `viewerRole` RIDER). Pull to refresh; skeleton; error with retry; an empty state; a note to call 991 in danger.

### NewTicketScreen (`/support/new[?trip=<id>]`)

- Category (`ticketCategoriesForApp`: a trip, payment, safety, your account, feedback; LOST_ITEM is not offered and a caption points to the receipt). Safety shows "call 991 first".
- "About a trip": "Not about a trip" or one of the 10 latest trips of the current mode (a bottom sheet over `tripHistoryProvider`); preselected and category "A trip" when opened from a receipt.
- Message (5–5000 characters). The subject is the message's first line, cut to 80 characters.
- Send → `POST /api/support/tickets` with `cityId` = the current city when there is no trip, `as` = `DRIVER` in driver mode for an account with the `DRIVER` role (else `RIDER`) when there is no trip; one key per distinct content (an unchanged retry reuses it). Then the ticket's thread replaces the form.

### TicketScreen (`/support/tickets/:id`)

`GET /api/support/tickets/:id`. Subject, status pill, category and date; "We asked you something" when waiting for the requester; "Our answer" with the resolution note once answered; the thread (the description first, then public messages: yours on the right, "Anbessa support" on the left, system lines centred). While open: a reply box (`POST .../messages`). Answered ≤ 7 days ago: "Reopen" asks for a reason (`POST .../reopen`). Later or closed: "This request is closed" and "Contact support". Pull to refresh.

### ReportLostItemScreen (`support/lost_item_screens.dart`, `/support/lost-items/report?trip=<id>`)

The trip (when, pickup, drop-off), "What did you leave?" (3–2000 characters), a note that the driver sees the text but not the phone number. Disabled with a notice when the trip completed more than 7 days ago. `POST /api/support/lost-items` with a key, then the report replaces the form. `already_reported` / `report_window_closed` are shown as errors.

### LostItemScreen (`/support/lost-items/:id`)

`GET /api/support/lost-items/:id`. Status pill and what happens next for the viewer (rider or driver side), the description and date, then the actions:

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

Account → Scheduled rides. The upcoming bookings (`scheduledRidesProvider`) as `ScheduledRideTile`s (see HistoryScreen), "Schedule a ride" (`startScheduling`, as the home chip) and "Book from 30 minutes to 7 days ahead." Skeleton, error with Retry, an empty state ("No rides booked"). Pull to refresh.

`ScheduledRidesController` (`scheduled_rides_controller.dart`): `GET /api/trips/scheduled?status=upcoming&limit=50` while signed in and the flag is on (else empty, no request); refreshed on every `scheduled:status` and on reconnect. A `scheduled:status` DISPATCHED with a `tripId` also refreshes the active trip, so the router opens the trip being matched. `added` inserts a new booking in time order; `cancel` removes it.

## Flagged modules (`flagged/flagged_modules.dart`)

| Screen | Entry point | What it does |
|---|---|---|
| DeleteAccountScreen | account (flag `accountDeletion`) | a warning and a delete button; `AccountRepository.requestDeletion()` answers `not_available` |

Scheduled rides and promo codes left this file once trip-service and pricing-service had them. There is no rider "promotions" list or redeem endpoint, so the former Promos and Redeem screens (and their home chip, account tile and `/promos` routes) are gone; codes are entered on the quote screen.
