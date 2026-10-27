# API reference: `@ride-app/shared-settings`

Contents: [registry.ts](#registryts) · [client.ts](#clientts)

---

## registry.ts

### `SettingType`

```ts
type SettingType = "int" | "number" | "bool" | "string" | "enum" | "intList" | "enumList" | "money";
```

### `SettingDef`

```ts
interface SettingDef {
  key: string;
  group: SettingGroup;
  label: string;
  description: string;
  type: SettingType;
  default: unknown;          // what the platform did before the setting existed
  min?: number;              // numbers: lower bound; lists: bound of each item
  max?: number;              // numbers: upper bound; string: max length
  options?: readonly string[]; // enum / enumList
  unit?: string;
  scope: "global" | "city";  // "city": a city may override the global value
  sensitive?: boolean;       // changes need a second super admin (maker–checker)
  owner: string;             // the service that acts on it
}
```

### `SETTING_GROUPS` / `SettingGroup`

```ts
const SETTING_GROUPS = ["Matching", "Trip rules", "Cancellations and fees", "Fares", "Payments",
  "Sign-in and OTP", "Documents", "Apps and maintenance", "Feature flags"] as const;
```

Display order for the admin settings page (platform-service returns it with the definitions).

### `SETTINGS: readonly SettingDef[]`

47 definitions. Full table: [settings-catalog.md](settings-catalog.md). Two groups are generated:

- **Fares**: a local `fare(type, label, defaults)` helper creates five `money` settings per vehicle type (`baseMinor`, `perKmMinor`, `perMinMinor`, `minFareMinor`, `waitingPerMinMinor`), all `scope: "city"`, `sensitive: true`, `min 0`, `max 1_000_000`, `owner: "pricing-service"`. Called for `economy`, `comfort`, `minivan`.
- **App minimum versions**: `apps.minVersion.{rider|driver}.{android|ios}`, `string`, default `"1.0.0"`, `max 20`, sensitive.

Keys are unique (tested) and every default passes its own validation (tested).

### `settingDef(key: string): SettingDef | undefined`

Lookup by key. Used to check whether a key exists before reading it, e.g. pricing-service's `fareCard` returns `null` for a vehicle type without `fares.{type}.baseMinor`:

```ts
// services/pricing-service/src/fares.ts
const key = (part: string) => `fares.${vehicleType}.${part}`;
if (!settingDef(key("baseMinor"))) return null;
```

So a vehicle type added in platform-service has no fares until a release adds a `fare(...)` line here.

### `validateSetting(key, value): { ok: true; value: unknown } | { ok: false; error: string }`

Checks a proposed value against its definition. Never throws. Errors are human-readable and start with the setting's label.

| Type | Accepted | Returned value |
|---|---|---|
| unknown key | — | `{ ok: false, error: "unknown setting {key}" }` |
| `int`, `money` | `Number.isInteger(value)` within `min`–`max` | as given |
| `number` | finite number within `min`–`max` | as given |
| `bool` | `typeof value === "boolean"` | as given |
| `string` | string of length ≤ `max` (default 500); keys starting `apps.minVersion.` must also match `/^\d{1,4}\.\d{1,4}\.\d{1,4}$/` | **trimmed** (the length check runs before trimming) |
| `enum` | a string in `options` | as given |
| `intList` | non-empty array of ≤ 10 integers, each within `min`–`max` | as given |
| `enumList` | non-empty array, no duplicates, every item in `options` | as given |

Examples (from `tests/settings.test.ts`):

```ts
validateSetting("match.offerSeconds", 4);                 // { ok: false } (min 5)
validateSetting("match.offerSeconds", 20.5);              // { ok: false } (not an integer)
validateSetting("cancel.driverShare", 1.2);               // { ok: false } (max 1)
validateSetting("otp.channels", ["sms", "sms"]);          // { ok: false } (repeat)
validateSetting("apps.minVersion.rider.android", "2.x");  // { ok: false }
validateSetting("match.radiiMeters", [1500, 3000]);       // { ok: true, value: [1500, 3000] }
```

Call site: `services/platform-service/src/settings/service.ts` (on propose, and again on approve).

---

## client.ts

### `SETTINGS_CHANNEL = "settings:changed"`

Redis pub/sub channel. platform-service publishes the new version after commit; on failure services catch up on their next poll.

### Snapshot types

```ts
interface CityInfo {
  id: string; name: string; timezone: string; enabled: boolean;
  bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number };
}

interface VehicleTypeInfo {
  code: string; name: string; seatsMin: number; seatsMax: number; enabled: boolean;
  cities: string[];          // where it's offered; empty = every city
}

interface SettingsSnapshot {
  version: number;
  global: Record<string, unknown>;                  // stored global values only
  cities: Record<string, Record<string, unknown>>;  // per-city overrides
  cityList: CityInfo[];
  vehicleTypes: VehicleTypeInfo[];
}
```

The snapshot holds only values someone has stored; unset keys fall through to defaults. `cityList` and `vehicleTypes` are carried along but no helper in this lib reads them.

### `emptySnapshot(): SettingsSnapshot`

`{ version: 0, global: {}, cities: {}, cityList: [], vehicleTypes: [] }`. The client's state before the first successful fetch.

### `fetchSettingsSnapshotFrom(platformInternalUrl, token): () => Promise<SettingsSnapshot>`

Fetcher for `GET {platformInternalUrl}/internal/settings/snapshot` with `authorization: Bearer {token}` and a 3 s timeout. Non-2xx → throws `Error("platform-service answered {status}")`. The body is cast, not validated. Services pass `config.PLATFORM_INTERNAL_URL` (default `http://localhost:3011` in their configs) and `config.INTERNAL_SERVICE_TOKEN`.

### `SettingsReader`

```ts
interface SettingsReader {
  get<T = unknown>(key: string, cityId?: string): T;   // the value in force
  snapshot(): SettingsSnapshot;
}
```

The type services depend on, so tests can pass `staticSettings()` instead of a live client. `T` is a cast; nothing checks the value's type at read time.

### `resolveSetting(snap, key, cityId, defaults = {}): unknown`

Pure resolution; also used by platform-service itself (`catalog/service.ts`, for `GET /api/platform/client-config`).

1. Unknown key → **throws** `Error("unknown setting {key}")`.
2. If `cityId` is given, the definition has `scope: "city"`, and `snap.cities[cityId]` has the key → that value.
3. Else if `snap.global` has the key → that value.
4. Else if `defaults` has the key → that value (the service's own default, e.g. from env).
5. Else `def.default`.

A city override of a `global`-scoped setting is ignored (test: `match.offerSeconds` overridden for hawassa still resolves to 15). Presence is checked with `in`, so a stored `null` would be returned as `null`.

### `staticSettings(values = {}, cityValues = {}): SettingsReader & { set(key, value, cityId?): void }`

Fixed values for tests or a service running without platform-service. `values` become `global`, `cityValues` (deep-cloned) become `cities`. `set` writes a global value, or a city value if `cityId` is given (no validation). No service defaults layer: unset keys resolve to the registry default.

```ts
// services/trip-service/tests/integration/harness.ts
const settings = staticSettings({ "match.timeoutSeconds": 120, "match.offerSeconds": 15 });
// services/pricing-service/tests/unit/pricing.test.ts
const settings = staticSettings({}, { "addis-ababa": { "fares.economy.perKmMinor": 2000 } });
```

### `createSettingsClient(opts)`

```ts
function createSettingsClient(opts: {
  fetchSnapshot: () => Promise<SettingsSnapshot>;
  redis?: RedisLike;                       // ioredis-compatible: duplicate().subscribe/on/quit
  logger: { info(obj, msg?): void; warn(obj, msg?): void };
  defaults?: Record<string, unknown>;      // this service's defaults, below stored values
  pollMs?: number;                         // default 30_000
}): {
  get<T = unknown>(key: string, cityId?: string): T;
  snapshot(): SettingsSnapshot;
  refresh(reason: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type SettingsClient = ReturnType<typeof createSettingsClient>;
```

| Method | Behaviour |
|---|---|
| `get(key, cityId?)` | `resolveSetting(current, key, cityId, defaults)`. Synchronous. Throws only for an unknown key |
| `snapshot()` | the current snapshot object |
| `refresh(reason)` | fetch; if `version` differs from the current one, replace it and log `info "settings updated"`. Errors are logged as `warn "settings refresh failed; keeping the current values"`; never throws |
| `start()` | `refresh("start")`; if `redis`: `duplicate()`, any message → `refresh("published")`, `subscribe(SETTINGS_CHANNEL)` (failure logged, "polling only"); then an `unref()`'d interval `refresh("poll")` |
| `stop()` | clear the interval, `quit()` the subscriber (errors swallowed) |

Caching: one in-memory snapshot per client; no TTL; replaced only when the version changes. `get` before `start()` (or while platform-service is unreachable) returns service defaults / registry defaults.

The `RedisLike` and `LoggerLike` interfaces are declared locally (not exported) and have the same shape as shared-authz's.
