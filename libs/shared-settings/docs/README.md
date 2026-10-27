# `@ride-app/shared-settings`

Live platform settings: what each setting is (the registry), and how a service reads the value in force (the client). platform-service stores the values and their history and runs the maker–checker flow for sensitive ones; every other service reads them through this lib.

| File | What it covers |
|---|---|
| [reference.md](reference.md) | Every export: `SettingDef`, `SETTINGS`, `validateSetting`, `resolveSetting`, `createSettingsClient`, `staticSettings`, snapshot types |
| [settings-catalog.md](settings-catalog.md) | Every setting key with type, default, bounds, scope, sensitivity, owner, and where in the code it is actually read |

---

## How it works

```mermaid
sequenceDiagram
  participant Admin as Super admins (web)
  participant PS as platform-service
  participant R as Redis
  participant S as service (createSettingsClient)
  Admin->>PS: propose value (validateSetting); sensitive → second super admin approves
  PS->>PS: store value, bump version
  PS->>R: PUBLISH settings:changed <version>
  R-->>S: message
  S->>PS: GET /internal/settings/snapshot (Bearer INTERNAL_SERVICE_TOKEN)
  PS-->>S: SettingsSnapshot
  Note over S: get(key, cityId) is synchronous:<br/>city override → global value → service default → registry default
  Note over S: also polls every 30 s
```

From the header of [`src/client.ts`](../src/client.ts): load once at start, reload when platform-service publishes on `settings:changed`, poll as a backstop. `get()` never fails for a known key. If platform-service is down at start, the service runs on its defaults.

## What belongs here and what doesn't

Belongs here:

- the definition of every live setting (key, type, bounds, default, city scope, sensitivity, owning service): [`src/registry.ts`](../src/registry.ts);
- validation of a proposed value against its definition;
- the read path: snapshot fetch, caching in memory, reload, value resolution.

Does not belong here:

- storage, history, approvals, audit: platform-service (`services/platform-service/src/settings/service.ts`);
- the permission matrix (`authz:*`) — that's shared-authz and auth-service, a different snapshot on a different channel;
- secrets and infrastructure config (database URLs, tokens). Those stay in each service's env, validated with zod in `src/config/index.ts`;
- business logic that uses a value. The lib returns values; the service decides what to do.

## Who uses it

| Package | Files | Symbols |
|---|---|---|
| `services/trip-service` | 5 | `createSettingsClient`, `fetchSettingsSnapshotFrom`, `SettingsReader`, `settingDef` (+ `staticSettings` in the integration harness) |
| `services/pricing-service` | 5 | `createSettingsClient`, `fetchSettingsSnapshotFrom`, `SettingsReader`, `settingDef` (+ `staticSettings` in unit tests) |
| `services/payment-service` | 3 | `createSettingsClient`, `fetchSettingsSnapshotFrom`, `SettingsReader` (+ `staticSettings`) |
| `services/fleet-service` | 2 | `createSettingsClient`, `fetchSettingsSnapshotFrom`, `SettingsReader` |
| `services/notification-service` | 1 | `createSettingsClient`, `fetchSettingsSnapshotFrom` |
| `services/platform-service` | 2 | `SETTINGS`, `SETTING_GROUPS`, `SETTINGS_CHANNEL`, `settingDef`, `validateSetting`, `SettingsSnapshot` (owner side), `resolveSetting` (public client config) |
| `apps/web` | 2 | `SettingDef` (admin settings page) |

auth-service, audit-service, location-service, mapping-service and realtime-gateway don't use it.

## Wiring in a service

From `services/trip-service/src/container.ts` and `src/server.ts`:

```ts
// live settings; this service's env values are the defaults until an admin changes them
const settingsClient = opts.settings ? undefined : createSettingsClient({
  fetchSnapshot: fetchSettingsSnapshotFrom(config.PLATFORM_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN),
  redis, logger,
  defaults: {
    "match.timeoutSeconds": config.MATCH_TIMEOUT_SECONDS, "match.offerSeconds": config.OFFER_SECONDS,
    "match.radiiMeters": config.MATCH_RADII_METERS, "trip.pinRequired": config.TRIP_PIN_REQUIRED,
  },
});
const settings: SettingsReader = opts.settings ?? settingsClient!;

// server.ts
await c.settingsClient?.start();
// …on shutdown
await c.settingsClient?.stop();

// anywhere
if (deps.settings.get<boolean>("maintenance.newTrips"))
  throw new AppError(503, deps.settings.get<string>("maintenance.message"), "maintenance");
```

Read values at the point of use (`settings.get(...)` inside the handler, or a getter like `config: () => ({ timeoutSeconds: settings.get(...) })`), not once at boot, or live changes won't apply.

Tests inject `staticSettings({...})` through `opts.settings` (trip-service, payment-service harnesses; pricing-service unit tests).

## Build and import

[`package.json`](../package.json): the usual `exports` with a `development` condition pointing at `./src/index.ts`, `types`/`default` at `dist/`. No runtime dependencies (Redis is structural, `fetch` is global). Scripts: `build` (`tsc -p tsconfig.json`), `test` (`vitest run`, [`tests/settings.test.ts`](../tests/settings.test.ts)), `lint`, `typecheck`.

```ts
import { createSettingsClient, fetchSettingsSnapshotFrom, type SettingsReader } from "@ride-app/shared-settings";
```

## Source map

| File | Exports |
|---|---|
| [`src/registry.ts`](../src/registry.ts) | `SettingType`, `SettingDef`, `SETTING_GROUPS`, `SettingGroup`, `SETTINGS`, `settingDef`, `validateSetting` |
| [`src/client.ts`](../src/client.ts) | `SETTINGS_CHANNEL`, `CityInfo`, `VehicleTypeInfo`, `SettingsSnapshot`, `emptySnapshot`, `fetchSettingsSnapshotFrom`, `SettingsReader`, `resolveSetting`, `staticSettings`, `createSettingsClient`, `SettingsClient` |
