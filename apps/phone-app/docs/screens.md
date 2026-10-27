# Screens

Every screen in `apps/phone-app/lib/features`, rider first, then driver, then shared. Paths are under `lib/features/` unless stated. Routes are listed in [architecture.md](architecture.md#route-table); endpoints in [api-usage.md](api-usage.md).

Common patterns:

- Errors are shown with `Problem(error, describe: describeError)`; a retry button appears only for retryable errors.
- Loading uses `Skeleton*` placeholders rather than spinners, except where noted.
- Map screens stack `AnbessaMap` + an `AppSheet`; the sheet's height is fed to the map as `bottomInset`.

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

### RiderHomeScreen (`rider/home/rider_home_screen.dart`)

- Map: the person's dot (from one location fix at open, `LocationProfile.once`), the nearby cars animated by `CarsAnimator`, follow mode `me` at zoom 15 until the person moves the map, a callout "N min away" over the nearest car when the nearby response has an ETA.
- Top: a pill with the avatar and a greeting by time of day (morning < 12 h, afternoon < 18 h, evening), tapping it goes to Account; a "N cars nearby" chip when there are drivers (or "…" while the first poll loads).
- Sheet (snaps 34 %, 62 %, 92 %):
  - "Where to?" (with a "Now" pill) → `/rider/book/route?focus=dropoff`.
  - Tiles: Home and Work (dashed "Set home/work" when empty, which opens the route editor in saved-place mode), other saved places, and "Add place" → `/account/places`. Tapping a set tile sets it as the drop-off and opens the route editor focused on the pickup. Long-press any tile → `/account/places`. Skeleton tiles while saved places load.
  - Up to 5 recent places; swipe left to forget one; tap to book.
  - A "Schedule a ride" chip (flag `scheduledRides`): `startScheduling` resets the booking, sets a suggested pickup time (`ScheduleWindow.suggested`: the next quarter hour at least 45 min away) and opens the route editor focused on the drop-off.
- Providers: `lastPositionProvider`, `locationSourceProvider`, `nearbyCarsProvider`, `savedPlacesProvider`, `homePlaceProvider`, `workPlaceProvider`, `recentPlacesProvider`, `bookingProvider`, `featureProvider`, `bannerHeightProvider`, `currentSessionProvider`.
- API: `GET /api/locations/nearby` every 10 s (stopped while the app is paused), `GET /api/trips/places`.

### RouteEditorScreen (`rider/booking/route_editor_screen.dart`)

Two modes: **book** (pickup and drop-off fields, a swap button) and **savedPlace** (one search field; the chosen place is returned to the caller with `pop`).

- On open in book mode with no pickup: if the last position is inside a served city, the pickup becomes "Current location".
- Typing ≥ 2 characters searches `GET /api/maps/search` (300 ms debounce, current city, UI language). Results are grouped: saved places (book mode only), recent places (4, or 8 when typing), well-known places for the city from `commonPlaces` (6, or 8), then remote results not already listed.
- States: skeleton while searching; a warning when search fails ("search down", local lists still shown); an illustrated "no results".
- "Use my location": permission check (`locationServiceOff` / `locationPermissionNeeded` errors), a fix, then resolve.
- "Choose on map": a full-screen map with a centre pin that lifts while dragging; when the map stops, the centre is checked against the served cities (`outsideServiceArea`), snapped to the road with `GET /api/maps/snap` (pickups in book mode only), and named with `GET /api/maps/reverse` (falls back to "lat, lng"). A card shows the name and "Confirm pickup / drop-off / Save place".
- Choosing a place for one field moves the focus to the other; when both are set it calls `BookingController.quote()` and replaces itself with `/rider/book/quote`. Choosing a drop-off adds it to recent places (max 8).
- Swap calls `BookingController.swap()`, which re-quotes when both are set.

### QuoteScreen (`rider/booking/quote_screen.dart`)

- Map: pickup and drop-off pins with name callouts, the road line from the estimate (`route.polyline6`), or a straight line.
- Sheet (snaps 48 %, 92 %): a header with both places, "distance · time" and "Edit" (back to the route editor); one card per quote (name, max seats, pickup ETA badge (hidden when booking for later), distance and time, the price as a `PriceTag`: the payable amount, with the undiscounted fare struck through above it when a promo lowered it); the fare breakdown (base, distance, time, the promo discount, "minimum fare applied") for the selected quote, collapsible; then a group of rows:
  - "Pickup time" (flag `scheduledRides`): "Now" or the chosen time. Tapping offers Now / "Pick a time"; the latter opens the date picker (from the earliest to the latest bookable day) and the time picker, reads the result as Addis time, and checks it against `ScheduleWindow.tripService` (30 min to 7 days ahead, mirroring trip-service's `DEFAULT_SCHEDULE`, since client-config doesn't publish the window). Out of the window: a toast with `errorTooSoon` / `errorTooFarAhead`.
  - Payment method.
  - "Promo code" (flag `promos`): "Add", or the code in use. Tapping opens a sheet with a code field, "Apply" and, when a code is in use, "Remove code". `BookingController.applyPromo` upper-cases and checks the format (`isValidPromoCode`: 3–32 letters, digits, `_`, `-`; a malformed code would make pricing-service refuse the whole estimate, so it is never sent and `promoInvalidFormat` is shown), then fetches a new estimate with `promoCode`. Under the row: "CODE applied · You save X" (green) when the selected quote is discounted, "CODE doesn't discount this vehicle type" when only others are, or the refusal (`promoRejectionText`: unknown, not active, not started, expired, used up, not in this city, not for these vehicle types, already used). A refused code is dropped from the following estimates; the refusal stays until the rider acts.
- Company rides (method "Company account"): a "Trip purpose or cost centre" field (max 200), with "Your company asks for this" when `GET /api/trips/corporate/:orgId/policy` says `requirePurpose` (the request button is disabled while it's empty), else "Optional". The purpose is sent only for company rides and only when not empty. A policy that can't be read counts as no requirement (the server still checks).
- When booking for later: "We check the price again shortly before pickup. You pay the lower one." Then "Quote expires in m:ss".
- Footer: a maintenance notice when new trips are paused (the button is disabled); "Request <type>" or, with a pickup time, "Schedule <type>", with the payable price; "Get a new price" when the quote expired. A `policy_violation` (422) shows the server's sentence naming the rule (in English; `errorPolicyViolation` in Amharic) and "Pay personally instead", which switches to the first non-company method.
- States: three skeleton cards while quoting; an error with Retry; an info notice when the estimate is `approximate`.
- Payment methods offered: `GET /api/payments/methods` for the current city (fallback cash only), minus corporate, plus "Company account" when the flag `corporateBooking` is on and the JWT carries an org id. If the remembered method is not offered, the first offered one is selected. Choosing corporate sets `billingOrgId` to the **first org id in the JWT** (not the "default company" preference).
- Request: `POST /api/trips` with the quote id, the method, the org id, the purpose and the booking's idempotency key (one key per quote; reused if the request fails), then `/rider/trip/<id>`. The quote's promo discount is booked by trip-service when it reads the quote. `active_trip_exists` refreshes the active trip and goes to it; `quote_expired` / `invalid_quote` / `quote_used` fetch a new quote.
- Schedule: `POST /api/trips/scheduled` with the same fields plus `scheduledFor` (UTC ISO), same key rule; the booking is added to `scheduledRidesProvider`, a toast "Ride booked for <time>", then `/rider/activity`. `too_soon`, `too_far_ahead`, `too_many_scheduled`, `schedule_conflict` are shown in words.
- Quoting: `POST /api/pricing/estimates` with the vehicle types offered in the city that contains the pickup, and the promo code when one is in use. The first estimate on opening runs after the first frame.

### RiderTripScreen (`rider/trip/rider_trip_screen.dart`)

One map and a sheet (snaps 42 %, 80 %) that changes with `riderStageOf(trip)`.

| Stage | Map | Sheet |
|---|---|---|
| finding | radar pulse at the pickup, pickup → drop-off line | "Requested" pill with the elapsed time, "Finding a driver", vehicle, drop-off, estimate, Cancel |
| driverAssigned | the car (MarkerAnimator), the car's road to the pickup (from `tripEtaProvider`, else a straight line), the trip line as a secondary dashed leg; ETA callout over the car | progress bar (matched → on the way → arrived → riding), "<driver> is on the way", ETA badge, "live" or "position stale" line, photo with rating ("New" under three ratings), car and plate, the PIN (flag `tripPin`, when the trip has one), fare and method, Cancel (with the fee note after the free window) |
| driverArrived | car and pickup | same card, "<driver> has arrived" |
| inTrip | the car's road to the drop-off, ETA callout | "On the way to <drop-off>", ETA badge, driver, fare and method |
| completed | both pins | total, "paid by <method>", "Pay" (digital) or "Receipt" (cash or corporate) → `/rider/trip/<id>/pay`, Done |
| cancelled | both pins | "No driver found" (reason `NO_DRIVER_FOUND`) or "cancelled by <side>", the fee if any, Done |

- Top: back (only when the trip ended), Share (active and not `requested`), SOS (flag `sos`, while `sosAvailable`: matched, en route, in progress, or completed ≤ 30 min ago) → `/sos?trip=<id>`.
- Stage changes play haptics; arrival shows a toast; completion plays confetti. When dispatch gives the trip to another driver (a `trip:status` with another `driver.userId`), `ActiveTripController` invalidates `tripPartiesProvider` (new name, photo, car) and the screen shows "Your driver changed" once.
- Money shown is what the rider pays (`fare.payableMinor`: the fare minus a promo discount). Completed with a promo: under the total, "Promo code CODE · −X".
- Cancel opens `showCancelSheet` with the reasons changedPlans, driverTooFar, driverAskedToCancel, wrongPickup, other, and a "no fee" or "a fee of 30 ETB may apply" pill (`riderCancelIsFree`, 2 min after the match; the fee is the constant `_cancelFeeMinor = 3000` in the screen). Calls `POST /api/trips/:id/cancel` with a new key.
- Share: `POST /api/trips/:id/share`, then the share sheet with the link; when sharing, the button offers "share again" or "stop sharing" (`DELETE /api/trips/:id/share`).
- Done: `activeTripProvider.clearIfEnded()` and `/rider/home`.
- Providers: `tripProvider(id)`, `tripPartiesProvider(id)` (only once a driver is set), `driverLiveProvider(id)`, `tripEtaProvider(id)`, `featureProvider`.
- Socket: `trip:status` (through `activeTripProvider`), `trip:subscribe` and `driver:location` (through `driverLiveProvider`).
- Loading: skeleton list; error: `Problem`.

### PayScreen (`rider/payments/pay_screen.dart`)

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

- Shows the other side's name (`tripPartiesProvider`), 1–5 stars, tag chips (`RatingTags.ofDriver` for riders, `ofRider` for drivers; positive tags first for 4–5 stars, negative first otherwise), a comment (max 500), and for riders a "Add a tip" row marked "Coming soon" (`kTipsEnabled` is false).
- Submit: `POST /api/trips/:id/rating`; `already_rated` counts as done. Then a "thanks" illustration with Done. "Skip" finishes without rating.
- Finishing clears the ended trip and goes to `doneRoute` (`/rider/home` or `/driver/home`).

### HistoryScreen (`rider/history/history_screens.dart`, both sides)

- `tripHistoryProvider(as)` = `GET /api/trips?as=rider|driver` (20 per page), next page when scrolled within 400 px of the end, pull to refresh.
- People who can drive see a Rider / Driver switch. A period filter: all, this week (7 days), this month (one calendar month back from today), applied on the loaded trips.
- Riders (flag `scheduledRides`): "Upcoming" above the past trips (`UpcomingRidesSection`, nothing when empty), one `ScheduledRideTile` per booking: pickup time (Addis), status pill (Booked, Finding a driver, Driver search started, Cancelled, Couldn't book), drop-off, pickup, "vehicle · booked price · method", "Driver search starts at hh:mm" while booked, and "Cancel booking" while `cancellable` (status SCHEDULED): a confirmation dialog ("free until we start looking for a driver"), then `POST /api/trips/scheduled/:id/cancel` and "Booking cancelled"; a failure shows the error and refreshes the list. Pull to refresh reloads both lists.
- Trips grouped by day ("Today", "Yesterday", or the date). Tap → the receipt route. Rows show what the rider paid (`payableMinor`) on the rider side and the fare on the driver side.
- States: skeleton list, error with Retry, illustrated empty state.

### ReceiptScreen (`rider/history/history_screens.dart`, both sides)

- A small non-interactive map with both pins and the trip line (straight if none), status pill and date, the driver (photo, name, car, plate) when known, a timeline (requested, started, completed, cancelled, distance), the money.
- Drivers also see the settlement from `GET /api/payments/trips/:tripId`: commission, VAT and "your balance change" (green or red).
- A share button sends a text receipt through the share sheet (the payable amount for riders, the fare for drivers).
- "Help with this trip" (flag `support`): for the rider, the existing lost-item report about this trip (status pill → the report), else "I left something" while `lostItemReportable` (completed ≤ 7 days ago) → `/support/lost-items/report?trip=<id>`; for both sides "Report a problem with this trip" → `/support/new?trip=<id>`. The rider's reports come from `myLostItemsProvider` (`GET /api/support/me/lost-items`).

## Driver

### DriverHomeScreen (`driver/shift/driver_home_screen.dart`)

- Map: the driver's position (`lastPositionProvider`) as the car, follow mode `me` at zoom 15 until a gesture. With an offer: fit to the car, pickup and drop-off; a straight line car → pickup and the offer's road (`GET /api/maps/route` for pickup → drop-off).
- Top chips: Online / Offline; while online "GPS good" / "GPS poor" and "Reconnecting" when the socket is not connected; "Dev tools" with fake location.
- A balance banner when the state is `warning`, `cashBlocked` or `blocked`, with "Top up" → `/driver/earnings/top-up`.
- Sheet offline (snaps 32 %, 60 %):
  - "You were taken offline: <reason>" when the last session ended for a reason other than `DRIVER`;
  - today's stats (`GET /api/payments/earnings/me?period=today`): net earnings, trips, and time online when a session exists;
  - the car (last used, from prefs `last_vehicle_id`, else the first drivable) with Ready / Not eligible and the denial text; tapping opens the vehicle picker (`GET /api/fleet/drivers/me/vehicles`);
  - "No vehicles" notice with "Add vehicle" → onboarding;
  - location errors with "Open settings";
  - "Slide to go online" (enabled when the car may drive): asks for notification permission, location permission (`driverOnline`), then `POST /api/fleet/sessions` with an idempotency key kept across network failures; `already_online` refreshes the driver home.
- Sheet online: "Waiting for offers" with a radar, the car, the stats, "Slide to go offline" (`DELETE /api/fleet/sessions/current`; a 404 counts as offline).
- `OfferSheet` (`driver/offers/offer_sheet.dart`) replaces the sheet while there is an offer or an "expired/cancelled" notice (shown 4 s): "New trip", pickup ETA, trip distance and time, a 15 s countdown ring, pickup and drop-off, fare and method, "Slide to accept" (`POST /api/trips/:id/accept` with a key; `offer_closed` / `invalid_state` show "expired"), "Decline" (`POST /api/trips/:id/decline`, errors ignored). Accepting sets the active trip, and the router opens the trip screen.
- `ShiftController` follows the server's session: every 60 s while online it refreshes `GET /api/fleet/drivers/me`; when the session closes on the server, it stops streaming and keeps the end reason.
- Socket: `trip:offer`, `trip:offer_expired`, `trip:offer_cancelled` (offers), `location:update` (pings).

### VehiclePickerSheet (`driver/shift/vehicle_picker_sheet.dart`)

A bottom sheet listing the cars; ineligible ones are dimmed with the denial message and cannot be picked; fleet cars are labelled.

### DriverTripScreen (`driver/trip/driver_trip_screen.dart`)

- Keeps the screen on while open when the "Keep screen on" preference is on.
- Map: in-app navigation to the target (pickup, then drop-off) with the travelled part greyed; follow `driverBearing` (or `driver` when "Turn the map the way I'm driving" is off) at zoom 17; a gesture switches to overview; an ETA callout at the target. Without a route: a straight line. The trip line is drawn as a secondary leg on the way to the pickup.
- Top: `TurnBanner` (tap → turn list) while navigating; back (ended trips); SOS (flag `sos`, while `sosAvailable`, so also for 30 min after drop-off); chips "Follow / Overview" and "Directions" (external app, asking which one when the preference is "ask").
- Sheet: the rider's photo and name, the target address, the payment method pill; a call button only if `kMaskedCallsEnabled` (false).

| Stage | Actions |
|---|---|
| accepted | "Slide: on my way" → `POST /api/trips/:id/en-route`; "Cancel trip" |
| toPickup | distance to the pickup (green within 150 m), "Slide: arrived" (green within 300 m) → `POST /api/trips/:id/arrive` (the server checks the position); "Cancel trip" |
| waitingAtPickup | waiting timer, "free until 3:00" then "rider is waiting"; "Slide to start" → PIN sheet when `tripPin` is on (4 `PinBoxes`), then `POST /api/trips/:id/start {pin}`; "No-show" enabled after 5 min (counts down before) → cancel with `NO_SHOW` |
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

- Profile card (avatar, name, phone, rating from `GET /api/trips/me/rating`, trips count from the loaded history) → `/account/profile`.
- Mode: "Switch to driver", "Become a driver", or "Switch to rider".
- Rider: saved places, payment preferences, scheduled rides (flag `scheduledRides`) → `/scheduled`.
- Driver: vehicles, navigation, earnings, and "Lost items" (flag `support`) → `/support/lost-items`.
- Preferences: language, appearance, notifications. Safety: emergency contact. Account: organisations (names, invitation count badge), signed-in devices. Help (flag `support`) → `/support`. About: sign out (confirmation dialog), delete account (flag), the app version.

### ProfileScreen (`profile/profile_screen.dart`)

Avatar with a camera button: take a photo, choose from gallery, or remove. The image is picked at 256 px, quality 70, sent as a JPEG data URL; if it is over 48 KB the gallery picker opens again at 160 px, quality 50. Name field (≥ 2 chars, Save enabled when changed). Phone shown read-only. `POST /api/auth/update-user`.

### LanguageScreen (`profile/account_screens.dart`)

English or Amharic; sets `localeProvider`.

### SessionsScreen

`GET /api/auth/list-sessions`: user agent, date and IP of each session; "sign out this device" (`POST /api/auth/revoke-session`) and "sign out everywhere else" (`POST /api/auth/revoke-other-sessions`).

### PaymentPreferencesScreen

The preferred mobile-money provider: `GET` / `PUT /api/payments/me/preferences`, choices from the providers that take mobile money.

### SavedPlacesScreen (`profile/saved_places_screen.dart`)

Home, Work and other places (`GET /api/trips/places`). Set or change opens the route editor in saved-place mode; Home and Work use `PUT /api/trips/places/home|work`, others `POST /api/trips/places`. Swipe or tap the bin to remove (`DELETE /api/trips/places/:id`).

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
