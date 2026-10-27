# Operations

Running, building, testing and serving the web app. Commands run from the repo root unless they start with `cd`.

## Run locally

```bash
make setup-web      # cd apps/web && pnpm install; copies .env.example → .env if missing
make dev-services   # the backend services (see docs/development)
make dev-web        # cd apps/web && pnpm dev → http://localhost:5173
```

Which services a page needs:

| Area | Services |
|---|---|
| Any sign-in, navigation, permissions | auth-service |
| Banners, city list, phone-booking flag | platform-service (optional: built-in defaults without it) |
| Live board, Find a trip, Book by phone, shared trip | trip-service, location-service, pricing-service, mapping-service |
| Onboarding, review queue, partner vehicles and documents | fleet-service (and auth-service for organisations) |
| Money pages, fleet balance, trip money | payment-service |
| Administration | auth-service, platform-service, audit-service |

To sign in:

- **Ready-made accounts**: set `DEV_LOGIN=on` in `services/auth-service/.env`, run `pnpm --filter @ride-app/auth-service seed:dev` (and `pnpm --filter @ride-app/fleet-service seed:dev` for review data), then use the "Sign in as…" panel on `/sign-in/staff` or `/sign-in/partner`.
- **A real first super admin**: `pnpm --filter @ride-app/auth-service bootstrap:super-admin -- --email … --name …`, then sign in at `/sign-in/staff`; the setup page asks for a new password and an authenticator.

Details: [docs/development/README.md §2 and §4](../../../docs/development/README.md#4-web-app-staff-dashboard-fleet-and-corporate-portals).

### Through Kong

```bash
make dev-gateway                                   # Kong on :8000, routes from kong.yml + /api/dev
GATEWAY_URL=http://localhost:8000 pnpm --filter @ride-app/web dev
make dev-gateway-down
```

`GATEWAY_URL` is only used for prefixes whose own variable (`AUTH_URL`, `TRIP_URL`, …) is unset; see [configuration.md](configuration.md#proxy-targets-development-only). Kong's rate limits then apply to everything from your machine together.

## Scripts

From [package.json](../package.json), run in `apps/web` (or `pnpm --filter @ride-app/web <script>`):

| Script | Command | What it does |
|---|---|---|
| `dev` | `vite` | Dev server on :5173 with the `/api/*` proxy and HMR |
| `build` | `tsc --noEmit && vite build` | Type-check, then build to `dist/` |
| `preview` | `vite preview` | Serve `dist/` locally (Vite's default preview port, 4173, since the config sets none). Vite reuses `server.proxy` for preview by default, so `/api/*` is proxied the same way |
| `test` | `vitest run --passWithNoTests` | Unit tests (below) |
| `lint` | `eslint src` | Repo-root [eslint.config.mjs](../../../eslint.config.mjs); for `apps/web/**/*.{ts,tsx}` it adds `eslint-plugin-react-hooks` recommended rules. ESLint is a root dev dependency |
| `typecheck` | `tsc --noEmit` | Types for `src` and `vite.config.ts` |

Turborepo runs the same tasks across the workspace (`pnpm turbo run build|test|lint|typecheck`); `build` and `test` depend on the workspace libraries' `build` (`turbo.json`).

## Tests

No DOM environment is configured (no jsdom or Testing Library), so the tests cover plain modules. Vitest picks up every `*.test.ts`; there are three files and 18 tests (all passing when this was written).

| File | Covers |
|---|---|
| [tests/api.test.ts](../tests/api.test.ts) | The HTTP client with stubbed axios adapters: bearer token and `Idempotency-Key` are sent; one token refresh after a 401, then `signed_out`; failures become `ApiError` with the server's message; a missing session is treated as signed out |
| [tests/logic.test.ts](../tests/logic.test.ts) | `toE164`, placeholder emails, `birr` and times; `staffSections()` for dispatcher, onboarding officer, super admin, auditor, finance officer/manager, support and operations, call center, safety; phone booking hidden by the flag; app-audience roles in a staff token give nothing |
| [src/lib/polyline.test.ts](../src/lib/polyline.test.ts) | `decodePolyline6` on Google's reference line and on an empty string |

There are no component, page or end-to-end tests.

## Build

```bash
pnpm --filter @ride-app/web build   # → apps/web/dist (index.html, assets/, favicon.svg)
```

- `VITE_MAP_STYLE_URL` is baked in at this step. Nothing else is environment-specific: API URLs are relative.
- The dev sign-in panel is excluded (`import.meta.env.DEV` is false).
- Workspace libraries: type-checking uses their `src/` through the `development` condition. For the bundle, `exports` falls back to each library's `dist/`, so build the libraries first (Turborepo's `^build` dependency does this when you go through `pnpm turbo run build`).

## Deploy

Nothing in `infra/` builds or serves the web app: there is no Dockerfile, Kubernetes manifest, Terraform resource or Kong route for the static files. `infra/kong/kong.yml` routes only `/api/*` prefixes to services.

What the code requires, and what [docs/production/README.md](../../../docs/production/README.md#web-app-staff-dashboard-fleet-and-corporate-portals) describes:

1. Serve `dist/` and `/api/*` on **one origin** (for example a CDN with `dist/` as origin and `/api/*` forwarded to Kong).
2. Fall back to `index.html` for unknown paths: routing is client-side (`BrowserRouter`), including `/t/:token` links shared with the public.
3. Put that origin in auth-service's `APP_TRUSTED_ORIGINS` and `ADMIN_TRUSTED_ORIGINS` (partners use the app surface, staff the admin surface).
4. A Content-Security-Policy allowing Google Fonts, the tile host, the documents bucket (`connect-src`, `img-src`, `frame-src`) and `worker-src 'self' blob:` for MapLibre.
5. Keep `/api/dev` unrouted (Kong's production config has no such route).

## Troubleshooting

| Symptom | Likely cause | Where to look |
|---|---|---|
| "Can't reach the server…" on every page | The proxied service isn't running, or the proxy target is wrong | `make dev-services`; `apps/web/.env` targets ([configuration.md](configuration.md)) |
| Sign-in loops back to `/sign-in/staff` | `GET /api/admin-auth/token` answers 401/403: no session cookie, a session on the other surface, or the origin isn't trusted by auth-service | Network tab; auth-service `ADMIN_TRUSTED_ORIGINS` / `APP_TRUSTED_ORIGINS` |
| Staff always land on the setup page | The token still has a `setup` claim: password not changed or authenticator not enrolled | [Auth.md §8](../../../docs/design/Auth.md#8-sessions-and-tokens) |
| "Nothing here for your roles." | The route's guard fails for your roles, or the token has no roles yet | Route table in [architecture.md](architecture.md#route-table); roles under Staff and roles |
| A page or button doesn't appear after a role change | The UI reads roles from the claims fetched when the session query ran (page load, sign-in, `refresh()`); only the matrix refreshes on its own (60 s) | Reload the page, or sign out and in |
| "Sign in as…" says dev sign-in is off | `DEV_LOGIN` isn't `on`, auth-service not restarted, or `/api/dev` not routed (through Kong use `make dev-gateway`, which adds it) | `services/auth-service/.env` |
| "Rate limited…" in the dev panel | auth-service's sign-in rate limit | `AUTH_RATE_LIMIT=off` in auth-service's `.env` |
| 429 through Kong | Kong's per-route rate limits (60 or 120 a minute), shared by every tab on your machine | `infra/kong/kong.yml` |
| "Map tiles unavailable. Positions still update." | The style URL or tiles can't load | `VITE_MAP_STYLE_URL`; rebuild or restart the dev server after changing it |
| Blank map area in a production build | CSP blocks the tile host or the MapLibre worker | CSP `connect-src`, `img-src`, `worker-src 'self' blob:` |
| "Address search is offline: common places only." | `/api/maps/search` failed (mapping-service or Nominatim down) | mapping-service; the page keeps working with `COMMON_PLACES` |
| Document upload: "The file didn't upload…" | The signed `PUT` failed: bucket CORS, CSP, or local storage not reachable | fleet-service `STORAGE` settings; bucket CORS for `PUT` from the web origin |
| Book by phone missing from the sidebar | `features.phoneBooking` is off in platform settings, or no `trip:create_on_behalf` | Administration → Settings |
| Shared trip shows "This link has ended" | trip-service answered 404: the trip ended over 30 minutes ago or sharing was stopped | trip-service |
