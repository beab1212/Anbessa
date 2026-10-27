# Domain and geometry helpers

Pure functions with no I/O. Sources: `packages/core/lib/src/domain/domain.dart` and `packages/core/lib/src/geo/polyline.dart`. Tests: `test/models_test.dart` (group "domain helpers") and `test/polyline_test.dart`.

## Trip stages (`domain.dart`)

The stage a screen shows is derived from the trip each time; it is never stored.

### `riderStageOf(Trip)` → `RiderStage`

| Trip status | `times.arrivedAt` | Rider stage |
|---|---|---|
| requested | | `finding` |
| matched | | `driverAssigned` |
| enRoute | null | `driverAssigned` |
| enRoute | set | `driverArrived` |
| inProgress | | `inTrip` |
| completed | | `completed` |
| cancelled | | `cancelled` |
| unknown | | `unknown` |

### `driverStageOf(Trip)` → `DriverStage`

| Trip status | `times.arrivedAt` | Driver stage |
|---|---|---|
| matched | | `accepted` |
| enRoute | null | `toPickup` |
| enRoute | set | `waitingAtPickup` |
| inProgress | | `inTrip` |
| completed | | `completed` |
| cancelled | | `cancelled` |
| requested, unknown | | `unknown` |

### Other trip rules

| Function | Rule |
|---|---|
| `riderCancelIsFree(trip, now, {freeWindow = 2 min})` | true while `requested`, when `matchedAt` is null, or within `freeWindow` after `matchedAt` |
| `waitingAtPickup(trip, now)` | time from `arrivedAt` to `startedAt` (or `now`); zero before arrival, never negative |

The free waiting time (3 min) and the no-show delay (5 min) are constants in the driver trip screen, not here (`apps/phone-app/lib/features/driver/trip/driver_trip_screen.dart`).

## Versions

| Function | Behaviour |
|---|---|
| `compareVersions(a, b)` | numeric compare of dot-separated parts; anything after `+` or `-` is dropped; missing parts count as 0; non-numbers count as 0. Negative when `a < b` |
| `isBelowMinimum(current, minimum)` | true only when `minimum` is non-empty and `current < minimum` |

Used by the forced-update gate (`updateRequiredProvider` in the app).

## Phone numbers

| Function | Behaviour |
|---|---|
| `toE164(input)` | strips everything but digits and `+`, then accepts `0911…`, `911…`, `251911…`, `+251911…` where the national part is `7` or `9` followed by 8 digits; returns `+2519…` / `+2517…` or null |
| `formatPhone(e164)` | `+251911223344` → `+251 91 122 3344`; null or empty → `—`; anything else unchanged |
| `isPlaceholderName(name)` | true when the name is 9–15 digits with an optional `+` (phone-only accounts get a name derived from the number, Auth.md §17). The app then greets with the formatted phone |

## Money

Amounts are `int` minor units (santim).

| Function | Behaviour |
|---|---|
| `birr(minor, {locale = 'en', withUnit = true})` | `40000` → `400 ETB`; `123450` → `1,234.50 ETB` (decimals only when there are santim); negative amounts start with `−` (U+2212); unit `ብር` when the locale starts with `am`; null → `—`. Digits are always formatted with the `en` pattern |
| `toMinor(input)` | birr typed by a person → santim; spaces and commas ignored; null unless a finite number > 0 |

## Time (Addis Ababa)

Addis Ababa is UTC+3 with no daylight saving. `addisOffset` is that constant and `toAddis(utc)` adds it. Every formatter below converts to Addis time first; none uses the device time zone.

| Function | Example |
|---|---|
| `clockOf(at)` | `14:05` |
| `dayAndTime(at, {locale})` | `26 Oct, 14:05` |
| `dayOf(at, {locale})` | `26 Oct 2026` |
| `since(at, now)` | `just now` (< 45 s), `4 min`, `1 h 05` (English only) |
| `mmss(duration)` | `3:45` |
| `minutesOf(seconds)` | `< 1 min`, `12 min`, `1 h 05` |
| `km(meters)` | `5.2 km` (one decimal under 10 km), `12 km` |
| `shortId(id)` | last 6 characters, dashes removed, upper case |

Month names are Gregorian in both languages; with an `am` locale they are the Amharic transliterations (`ጃንዩ`, `ፌብሩ`, …). The Ethiopian calendar is out of scope (comment in `domain.dart`). Null inputs return `—`.

## Distance and bearing (`domain.dart`)

| Function | Behaviour |
|---|---|
| `haversineMeters(lat1, lng1, lat2, lng2)` | great-circle distance, Earth radius 6 371 000 m |
| `bearingDegrees(lat1, lng1, lat2, lng2)` | 0–360, clockwise from north |
| `T.let(f)` | a small extension used in the code (`x.let((it) => …)`) |

## Geometry (`geo/polyline.dart`)

`typedef GeoPoint = ({double lat, double lng})`.

### Polylines

| Function | Behaviour |
|---|---|
| `decodePolyline6(encoded)` | Google-encoded polyline with 6 decimals (OSRM `geometries=polyline6`), the format of `route.polyline`, `Quote.routePolyline6`, `RouteSteps.polyline6` |
| `decodePolyline5(encoded)` | the 5-decimal variant (Google Maps default) |
| `encodePolyline6(points)` | the reverse of `decodePolyline6` (used by tests) |

### Points and angles

| Function | Behaviour |
|---|---|
| `geoDistanceMeters(a, b)` | haversine, same radius |
| `geoBearing(a, b)` | 0–360 |
| `geoOffset(from, bearingDeg, meters)` | the point that far along that bearing (used for dead reckoning) |
| `geoLerp(a, b, t)` | linear interpolation of lat/lng |
| `lerpAngleDeg(a, b, t)` | interpolates an angle the short way round (350° → 10° passes 0°) |

### Along a route

| Function | Behaviour |
|---|---|
| `cumulativeMeters(points)` | `[0, d01, d01+d12, …]` |
| `totalMeters(points)` | the last cumulative value, 0 for an empty list |
| `projectOntoPolyline(points, p, {cumulative})` | `RouteProjection (segment, t, offMeters, alongMeters, point)`: the nearest point on the route, the segment it is on, the fraction along that segment, the perpendicular distance and the distance from the start. Uses a local equirectangular projection around `p`. Empty route → `offMeters = infinity` |
| `bearingAt(points, index)` | bearing of the segment starting at `index` (clamped) |
| `sliceFrom(points, projection)` | the untravelled remainder, starting at the projected point |
| `sliceTo(points, projection)` | the travelled part, ending at the projected point |
| `pointAlong(points, meters, {cumulative})` | the point that many metres from the start (clamped to the ends) |

These feed `MarkerAnimator`, `NavigationController` and the route layers in the app (`apps/phone-app/lib/features/maps/`).
