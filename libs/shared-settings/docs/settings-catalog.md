# Settings catalogue

All 47 keys in `SETTINGS` ([`src/registry.ts`](../src/registry.ts)), generated from the source. "Owner" is the `owner` field of the definition (the service meant to act on it). The [Readers](#where-each-key-is-read) section lists where the code actually reads each key.

Values are resolved as: city override (only for `scope: city`) → stored global value → the reading service's `defaults` → the default below. Money is in santim (1 birr = 100). Sensitive settings need a second super admin to approve a change.

## Definitions

### Matching

| Key | Type | Default | Bounds / options | Unit | Scope | Sensitive | Owner | Label |
|---|---|---|---|---|---|---|---|---|
| `match.timeoutSeconds` | int | `120` | 10–600 | s | global |  | trip-service | Give up finding a driver after |
| `match.offerSeconds` | int | `15` | 5–60 | s | global |  | trip-service | Time a driver has to accept |
| `match.radiiMeters` | intList | `[2000,4000,6000]` | 100–20000 | m | global |  | trip-service | Search radius steps |

### Trip rules

| Key | Type | Default | Bounds / options | Unit | Scope | Sensitive | Owner | Label |
|---|---|---|---|---|---|---|---|---|
| `trip.pinRequired` | bool | `false` |  |  | global |  | trip-service | Driver must enter the rider's PIN to start |
| `trip.arrivalRadiusMeters` | int | `150` | 30–1000 | m | city |  | trip-service | Arrival radius |
| `trip.freeWaitingSeconds` | int | `180` | 0–1800 | s | city |  | trip-service | Free waiting at the pickup |
| `trip.noShowAfterSeconds` | int | `300` | 60–3600 | s | city |  | trip-service | Driver may report a no-show after |
| `trip.completeFarFromDropoffMeters` | int | `300` | 50–5000 | m | city |  | trip-service | Flag trips completed this far from the drop-off |
| `quote.ttlSeconds` | int | `600` | 60–3600 | s | global |  | trip-service | A quoted fare is valid for |

### Cancellations and fees

| Key | Type | Default | Bounds / options | Unit | Scope | Sensitive | Owner | Label |
|---|---|---|---|---|---|---|---|---|
| `cancel.freeSeconds` | int | `120` | 0–1800 | s | city |  | trip-service | Free cancellation window |
| `cancel.feeMinor` | money | `3000` | 0–100000 |  | city | yes | trip-service | Cancellation fee |
| `cancel.driverShare` | number | `0.8` | 0–1 |  | city | yes | trip-service | Driver's share of the fee |

### Fares

| Key | Type | Default | Bounds / options | Unit | Scope | Sensitive | Owner | Label |
|---|---|---|---|---|---|---|---|---|
| `fares.economy.baseMinor` | money | `5000` | 0–1000000 |  | city | yes | pricing-service | Economy: base fare |
| `fares.economy.perKmMinor` | money | `1500` | 0–1000000 |  | city | yes | pricing-service | Economy: per km |
| `fares.economy.perMinMinor` | money | `200` | 0–1000000 |  | city | yes | pricing-service | Economy: per minute |
| `fares.economy.minFareMinor` | money | `8000` | 0–1000000 |  | city | yes | pricing-service | Economy: minimum fare |
| `fares.economy.waitingPerMinMinor` | money | `300` | 0–1000000 |  | city | yes | pricing-service | Economy: waiting, per minute |
| `fares.comfort.baseMinor` | money | `7000` | 0–1000000 |  | city | yes | pricing-service | Comfort: base fare |
| `fares.comfort.perKmMinor` | money | `2000` | 0–1000000 |  | city | yes | pricing-service | Comfort: per km |
| `fares.comfort.perMinMinor` | money | `300` | 0–1000000 |  | city | yes | pricing-service | Comfort: per minute |
| `fares.comfort.minFareMinor` | money | `11000` | 0–1000000 |  | city | yes | pricing-service | Comfort: minimum fare |
| `fares.comfort.waitingPerMinMinor` | money | `400` | 0–1000000 |  | city | yes | pricing-service | Comfort: waiting, per minute |
| `fares.minivan.baseMinor` | money | `9000` | 0–1000000 |  | city | yes | pricing-service | Minivan: base fare |
| `fares.minivan.perKmMinor` | money | `2500` | 0–1000000 |  | city | yes | pricing-service | Minivan: per km |
| `fares.minivan.perMinMinor` | money | `350` | 0–1000000 |  | city | yes | pricing-service | Minivan: per minute |
| `fares.minivan.minFareMinor` | money | `14000` | 0–1000000 |  | city | yes | pricing-service | Minivan: minimum fare |
| `fares.minivan.waitingPerMinMinor` | money | `500` | 0–1000000 |  | city | yes | pricing-service | Minivan: waiting, per minute |

### Payments

| Key | Type | Default | Bounds / options | Unit | Scope | Sensitive | Owner | Label |
|---|---|---|---|---|---|---|---|---|
| `payments.methods` | enumList | `["CASH","MOBILE_MONEY","CARD"]` | `CASH`, `MOBILE_MONEY`, `CARD` |  | city | yes | trip-service | Payment methods riders can choose |
| `payments.mobileMoneyProviders` | enumList | `["telebirr","cbebirr"]` | `telebirr`, `cbebirr` |  | global |  | payment-service | Mobile money providers, in order |
| `payments.cardProvider` | enum | `"chapa"` | `chapa` |  | global |  | payment-service | Card payments go through |

### Sign-in and OTP

| Key | Type | Default | Bounds / options | Unit | Scope | Sensitive | Owner | Label |
|---|---|---|---|---|---|---|---|---|
| `otp.channels` | enumList | `["telegram","sms"]` | `telegram`, `sms` |  | global |  | notification-service | Login code channels, in order |
| `otp.fallbackSeconds` | int | `20` | 5–120 | s | global | yes | notification-service | Send by SMS if Telegram hasn't delivered after |

### Documents

| Key | Type | Default | Bounds / options | Unit | Scope | Sensitive | Owner | Label |
|---|---|---|---|---|---|---|---|---|
| `documents.expiryWarningDays` | int | `30` | 1–90 | days | global |  | fleet-service | Expiring soon means within |
| `documents.reminderDays` | intList | `[30,7,1]` | 1–90 | days | global |  | fleet-service | Remind owners this many days before expiry |

### Apps and maintenance

| Key | Type | Default | Bounds / options | Unit | Scope | Sensitive | Owner | Label |
|---|---|---|---|---|---|---|---|---|
| `maintenance.newTrips` | bool | `false` |  |  | global | yes | trip-service | Pause new trip requests |
| `maintenance.message` | string | `"Anbessa is briefly unavailable for maintenance. Please try again in a few minutes."` | –300 |  | global |  | platform-service | Maintenance message |
| `apps.minVersion.rider.android` | string | `"1.0.0"` | –20 |  | global | yes | platform-service | Minimum rider app version (Android) |
| `apps.minVersion.rider.ios` | string | `"1.0.0"` | –20 |  | global | yes | platform-service | Minimum rider app version (iOS) |
| `apps.minVersion.driver.android` | string | `"1.0.0"` | –20 |  | global | yes | platform-service | Minimum driver app version (Android) |
| `apps.minVersion.driver.ios` | string | `"1.0.0"` | –20 |  | global | yes | platform-service | Minimum driver app version (iOS) |

### Feature flags

| Key | Type | Default | Bounds / options | Unit | Scope | Sensitive | Owner | Label |
|---|---|---|---|---|---|---|---|---|
| `features.phoneBooking` | bool | `true` |  |  | global |  | trip-service | Call center can book by phone |
| `features.corporateBooking` | bool | `true` |  |  | global |  | trip-service | Company accounts can book rides |
| `features.scheduledRides` | bool | `false` |  |  | global |  | platform-service | Riders can schedule rides |
| `features.sos` | bool | `false` |  |  | global |  | platform-service | SOS button during trips |
| `features.support` | bool | `false` |  |  | global |  | platform-service | In-app support tickets |
| `features.promos` | bool | `false` |  |  | global |  | platform-service | Promo codes |
| `features.accountDeletion` | bool | `false` |  |  | global |  | platform-service | Self-service account deletion |

Descriptions (the `description` field) are shown in the admin dashboard; read them in the source.

## Where each key is read

Found by grepping `services/`, `apps/` and `packages/` for each key (tests excluded).

| Key(s) | Read in | How |
|---|---|---|
| `match.timeoutSeconds`, `match.offerSeconds`, `match.radiiMeters` | trip-service `src/container.ts` | matcher `config()` getter, read per matching run |
| `trip.pinRequired`, `features.phoneBooking`, `features.corporateBooking`, `maintenance.newTrips`, `maintenance.message`, `payments.methods` | trip-service `src/trips/service.ts` | checks on trip request / start (`maintenance.newTrips` → `503 maintenance` with the message) |
| `trip.arrivalRadiusMeters`, `trip.freeWaitingSeconds`, `trip.noShowAfterSeconds`, `trip.completeFarFromDropoffMeters`, `cancel.freeSeconds`, `cancel.feeMinor`, `cancel.driverShare` | trip-service `src/trips/policy.ts` | per city |
| `quote.ttlSeconds` | pricing-service `src/quotes.ts`; trip-service `src/quotes.ts` (built-in stand-in) | |
| `fares.{type}.*` | pricing-service `src/fares.ts` (`fareCard`); trip-service `src/quotes.ts` (built-in stand-in, `PRICING=builtin`) | per city |
| `payments.methods` | payment-service `src/http/routes.ts` (`GET /api/payments/methods?cityId=`) | per city |
| `payments.mobileMoneyProviders`, `payments.cardProvider` | payment-service `src/money/payments.ts` | |
| `otp.channels`, `otp.fallbackSeconds` | notification-service `src/container.ts` (OTP service getters) | `telegram` is dropped when `TELEGRAM_GATEWAY_TOKEN` isn't set |
| `documents.expiryWarningDays`, `documents.reminderDays` | fleet-service `src/fleet/service.ts` | expiry job and reminders |
| `features.*` (all seven), `trip.pinRequired`, `maintenance.*`, `apps.minVersion.*` | platform-service `src/catalog/service.ts` → `GET /api/platform/client-config` | resolved globally (no city) for the apps and web |

Phone app and web read the client-config response (`cfg.maintenance.*` in `apps/phone-app/lib/features/bootstrap/gates.dart`, `apps/web/src/components/Shell.tsx`), not this lib.

## Service defaults

Services pass env values as `defaults` to `createSettingsClient`, sitting between stored values and the registry default:

| Service | `defaults` |
|---|---|
| trip-service | `match.timeoutSeconds` ← `MATCH_TIMEOUT_SECONDS`, `match.offerSeconds` ← `OFFER_SECONDS`, `match.radiiMeters` ← `MATCH_RADII_METERS`, `trip.pinRequired` ← `TRIP_PIN_REQUIRED` |
| notification-service | `otp.channels` ← `OTP_CHANNELS`, `otp.fallbackSeconds` ← `OTP_FALLBACK_SECONDS` |
| fleet-service | `documents.expiryWarningDays` ← `EXPIRY_WARNING_DAYS` |
| payment-service, pricing-service | none |

## Observations

- **Owner vs reader differ** for some keys: `quote.ttlSeconds` (owner trip-service, read mostly by pricing-service), `payments.methods` (owner trip-service, also read by payment-service), `maintenance.message` (owner platform-service, also read by trip-service).
- Fares exist only for `economy`, `comfort` and `minivan`. Vehicle types created in platform-service (`SettingsSnapshot.vehicleTypes`) get no fares until this file changes.
- `features.scheduledRides`, `features.sos`, `features.support`, `features.promos`, `features.accountDeletion` are only passed to the apps; no backend service checks them ("phone-app modules built ahead of their services", comment in the registry).
- fleet-service's fallback `?? [30, 7, 1]` for `documents.reminderDays` is never reached when a client is present, because `get` always returns the registry default.
