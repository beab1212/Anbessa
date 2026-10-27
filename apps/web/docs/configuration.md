# Configuration

Every setting the web app reads, where it is read, and its default. There are two kinds:

- **Proxy targets** read by [vite.config.ts](../vite.config.ts) through `loadEnv(mode, process.cwd(), "")`. They only affect Vite's own servers: `pnpm dev`, and `pnpm preview` (Vite's `preview.proxy` defaults to `server.proxy`; this config does not set it). They are not compiled into the bundle and have no effect on the `vite build` output.
- **`VITE_*` values** read in the browser code through `import.meta.env`, replaced at build time.

Values come from `apps/web/.env` (and the other files Vite loads for the mode, such as `.env.local` or `.env.development`) and from the shell environment. `make setup-web` copies [.env.example](../.env.example) to `.env` if it does not exist. There are no secrets in the web app's configuration.

## Proxy targets (development only)

| Variable | Prefixes it serves | Default | Meaning |
|---|---|---|---|
| `AUTH_URL` | `/api/auth`, `/api/admin-auth`, `/api/identity`, `/api/dev` | `http://localhost:3001` | auth-service |
| `TRIP_URL` | `/api/trips` | `http://localhost:3002` | trip-service |
| `LOCATION_URL` | `/api/locations` | `http://localhost:3003` | location-service |
| `PRICING_URL` | `/api/pricing` | `http://localhost:3004` | pricing-service |
| `PAYMENT_URL` | `/api/payments` | `http://localhost:3005` | payment-service |
| `MAPPING_URL` | `/api/maps` | `http://localhost:3007` | mapping-service |
| `FLEET_URL` | `/api/fleet` | `http://localhost:3008` | fleet-service |
| `AUDIT_URL` | `/api/audit` | `http://localhost:3010` | audit-service |
| `PLATFORM_URL` | `/api/platform` | `http://localhost:3011` | platform-service |
| `GATEWAY_URL` | every prefix whose own variable is unset | unset | Send traffic through Kong, e.g. `http://localhost:8000` with `make dev-gateway` |

Lookup order for each prefix: the service variable, then `GATEWAY_URL`, then the localhost default. Because `.env.example` defines all nine service variables, a `.env` copied from it makes `GATEWAY_URL` ineffective until those lines are removed or pointed at Kong.

The dev server port is fixed at `5173` in `vite.config.ts` (`server.port`); it is not configurable through an env var.

## Build-time values

| Name | Read in | Default | Meaning |
|---|---|---|---|
| `VITE_MAP_STYLE_URL` | [src/components/map/CityMap.tsx](../src/components/map/CityMap.tsx) | `https://tiles.openfreemap.org/styles/liberty` (also used when the value is an empty string) | MapLibre style JSON for every map. `.env.example` sets the same OpenFreeMap URL. For the self-hosted TileServer GL from `make dev-infra`: `http://localhost:8081/styles/<id>/style.json`. Production should point at a self-hosted or licensed tile host ([docs/production/README.md](../../../docs/production/README.md#web-app-staff-dashboard-fleet-and-corporate-portals)) |
| `import.meta.env.DEV` | [src/pages/SignIn.tsx](../src/pages/SignIn.tsx) | `true` under `vite` dev, `false` in `vite build` | Includes the dev sign-in panel ([src/dev/DevSignIn.tsx](../src/dev/DevSignIn.tsx)) |

No other `import.meta.env` or `process.env` reads exist in `src/`, and `vite.config.ts` has no `define` block.

## Runtime configuration from the server

Not environment variables, but they change behaviour without a rebuild. [src/lib/platform.tsx](../src/lib/platform.tsx) loads `GET /api/platform/client-config` every 60 s:

| Field | Effect in the web app |
|---|---|
| `cities` | Replaces the built-in city list (`addis-ababa`, `hawassa`) used by city pickers, labels and `inAnyCity()` ([src/lib/format.ts](../src/lib/format.ts)) |
| `features.phoneBooking` | `false` hides "Book by phone" in the staff sidebar |
| `features.corporateBooking`, `features.tripPin` | In the type, not read by any page |
| `maintenance.newTripsPaused`, `maintenance.message` | Red "new trips paused" pill in the top bar and a maintenance banner on non-map pages |
| `announcements` | Banners in the Shell for announcements whose `audiences` include `staff` (staff area) or `partner` (partner area) |
| `vehicleTypes`, `version` | In the type, not read by any page. Vehicle choices on Book by phone and Add vehicle are hard-coded (economy, comfort, minivan) |

The permission matrix (`GET /api/identity/authz`, every 60 s) is the other piece of runtime configuration; see [architecture.md §4](architecture.md#4-auth-and-sessions).

## Hard-coded values worth knowing

| Value | Where |
|---|---|
| Built-in cities `addis-ababa` (Addis Ababa), `hawassa` (Hawassa) | `src/lib/format.ts` |
| Map bounding boxes per city | `CITIES` in `@ride-app/shared-location` (not the client-config bboxes) |
| Time zone `Africa/Addis_Ababa` | `src/lib/format.ts`, `src/components/Shell.tsx` |
| Common places for Addis Ababa | `COMMON_PLACES` in `src/components/PlacePicker.tsx` |
| Upload types JPEG, PNG, PDF; 10 MB limit | `src/lib/fleet.ts` |
| Token refresh margin 60 s | `src/lib/api.ts` |
| "Waiting too long" on the board: 60 s | `src/pages/staff/Board.tsx` |
| Idempotency key format `web-<uuid>` | `src/lib/api.ts` |

## TypeScript

[tsconfig.json](../tsconfig.json) extends `../../tsconfig.base.json` (strict, `noUncheckedIndexedAccess`), with `jsx: react-jsx`, `moduleResolution: Bundler`, DOM libs, `types: ["vite/client"]` and `customConditions: ["development"]`, so type-checking resolves workspace libraries to their `src/` (their `exports` map `development` to `./src/index.ts`). It includes `src` and `vite.config.ts`; the `tests/` folder is not type-checked by `pnpm typecheck`.
