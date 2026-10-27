# Settings and storage

What the app keeps on the device and what it keeps on the server.

## SharedPreferences

Every key is declared in `lib/core/prefs_keys.dart` (`PrefsKeys`). Four controllers use the same string as a local constant instead of `PrefsKeys` (`ModeController` `'mode'`, `LocaleController` `'locale'`, `ShiftController` `'last_vehicle_id'`, `ClientConfigController` `'client_config'`); the values match.

| Key | Type | Default | Written by | What it controls |
|---|---|---|---|---|
| `locale` | String (`en`, `am`) | absent = follow the system | `LocaleController` (`features/profile/account_screens.dart`): Language screen, Welcome pills | the app language |
| `theme_mode` | String (`system`, `light`, `dark`) | `system` | `ThemeModeController` (`features/profile/appearance_controller.dart`) | light / dark theme and map tiles |
| `mode` | String (`rider`, `driver`) | absent | `ModeController` (`core/session/session_controller.dart`) | the chosen mode; never cleared on sign-out |
| `intro_seen` | bool | false | `IntroSeen` (`features/intro/intro_screen.dart`) | whether the intro is shown before Welcome |
| `recent_places` | String list, each `name|label|lat|lng` | empty | `BookingController.remember` / `forget` | recent drop-offs, max 8, newest first (the home shows 5) |
| `last_payment_method` | String (`PaymentMethod.name`) | cash | `BookingController.pay` | the payment method preselected on the quote |
| `billing_org_id` | String | absent (first company) | `BillingOrgController` (`features/profile/settings_controllers.dart`), Organisations screen | the "default company" choice. **Not read when booking**: the quote uses the first org id in the JWT |
| `dismissed_announcements` | String list | empty | `DismissedAnnouncements` (`features/bootstrap/gates.dart`) | announcement ids not to show again; the last 50 are kept |
| `emergency_contact` | String `name|+251…` | absent | `EmergencyContactController` | the emergency contact. Shown in Account; not used by the SOS screen |
| `notif_trip` | bool | true | `NotificationPrefsController` | "Trip updates" toggle. **Stored only**: nothing reads it |
| `notif_sound` | bool | true | same | "Sound" toggle. Stored only |
| `notif_vibrate_offer` | bool | true | `HapticsSettings` (`core/ux/haptics.dart`) | the vibration pattern on a new offer |
| `haptics` | bool | true | `HapticsSettings` | every other haptic |
| `nav_bearing` | bool | true | `NavPrefsController` | driver map turns with the heading (`driverBearing`) or stays north up |
| `nav_app` | String (`ask`, `google`, `waze`, `system`) | absent = ask | `NavPrefsController` | which app "Directions" opens |
| `keep_awake` | bool | true | `NavPrefsController` | wakelock on the driver trip screen |
| `last_vehicle_id` | String | absent | `ShiftController.goOnline` | the car preselected on the driver home |
| `client_config` | String (raw JSON) | absent | `ClientConfigController._fetch` | the last good client config, used when the fetch fails |
| `map_mode` | String (`flat`, `threeD`, `satellite`) | absent (flat) | `MapModeController` (`features/maps/map_mode.dart`) | the map view; 3D shows flat where the vector engine doesn't run |

Screen-local state that is not persisted: the booking itself, quotes, history filters, offer state, shift state (rebuilt from `GET /api/fleet/drivers/me`).

## Secure storage

`lib/core/session/secure_store.dart`.

| Key | Contents |
|---|---|
| `session_token` | the Better Auth bearer session token from the OTP verify response |

`PlatformSecureStore` uses `flutter_secure_storage` (Keychain / Android keystore). If the platform store throws (for example no keyring on Linux desktop), a **debug** build switches to SharedPreferences under the key `insecure_session_token` and prints a warning; a release build rethrows. `delete` removes both copies. `MemorySecureStore` is the test double.

The access JWT is never stored; it lives in `TokenManager` memory.

## On the server

| Setting | Service and endpoint | Screen |
|---|---|---|
| Name and photo | auth-service `POST /api/auth/update-user` (photo as a JPEG data URL, ≤ 48 KB attempted on the client) | Profile |
| Signed-in devices | auth-service `list-sessions`, `revoke-session`, `revoke-other-sessions` | Signed-in devices |
| Organisation memberships and invitations | auth-service `/api/auth/organization/*` | Organisations |
| Saved places (Home, Work, others) | trip-service `/api/trips/places` | Saved places, rider home, route editor |
| Preferred mobile-money provider | payment-service `GET`/`PUT /api/payments/me/preferences` | Payment preferences |
| Payout method | payment-service `PUT /api/payments/balances/:accountId/payout-method` | Payout method |
| Push device registration | notification-service `/api/notifications/devices` | automatic |
| Marketing messages by push / SMS (opt-outs) | notification-service `GET`/`PUT /api/notifications/me/marketing` | Notifications ("Offers and news from Anbessa"; replaced the local `notif_promo` toggle) |
| Feature flags, maintenance, announcements, minimum versions | platform-service client config (admins set them in the web app per `apps/phone-app/README.md`) | read-only in the app |
