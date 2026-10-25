# web — the Anbessa web app

One React + Vite app for everyone who works in a browser. What a user sees depends on
the roles in their access token ([Role.md §4](../../docs/design/Role.md#which-surface-each-role-uses)):

| Area | Who | Sign-in | Token |
|---|---|---|---|
| **Staff dashboard** (`/staff`) | call center, dispatch, support, onboarding, safety, operations, marketing, analysts, finance, super admins, auditors, regulator | email + password + TOTP (`/api/admin-auth`) | `aud=ride-admin`, 10 min |
| **Fleet portal** (`/fleet`) | fleet owners | phone OTP (`/api/auth`) | `aud=ride-app`, 15 min |
| **Corporate portal** (`/corporate`) | corporate admins and coordinators | phone OTP (`/api/auth`) | `aud=ride-app`, 15 min |

**Access control.** The app hides pages and buttons a user's roles don't allow, but that's
convenience only: every API call is checked again by the service with `libs/shared-authz`
(permission + scope). Staff and partner sessions are separate (different cookies and token
audiences), so a partner token can never open a staff API. Today the app has only the first
placeholder pages (trips); the role-gated areas are still to build.

Stack: React 19, React Router 7, TanStack Query 5, Vite 8, Vitest 5, TypeScript 7
(`moduleResolution: Bundler`, `vite/client` types). Requires Node 24 and pnpm via `corepack enable`.

## Quick start

```bash
# 1. Install dependencies
pnpm install   # pnpm via `corepack enable`; this is a workspace package, npm won't resolve it

# 2. Copy and configure the env file
cp .env.example .env
# Edit .env — at minimum set VITE_API_BASE_URL

# 3. Start the dev server
pnpm dev
# → http://localhost:5173
```

> **No backend needed for initial UI work.**
> Planned: set `VITE_USE_MOCK=true` in your `.env` to use MSW mock handlers
> instead of a real API. MSW isn't installed yet; add `msw` and the handlers first.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_BASE_URL` | `http://localhost:8000` | REST API base URL (Kong gateway) |
| `VITE_WS_URL` | `ws://localhost:3000` | WebSocket URL (realtime-gateway) |
| `VITE_USE_MOCK` | `false` | (planned) Use MSW mock handlers instead of real API |

---

## Project layout

```
src/
├── main.tsx           entry point
├── App.tsx            router setup
├── api/
│   └── client.ts      Axios instance with JWT interceptor
├── hooks/             shared React Query hooks (useTrips, useDrivers, …)
├── components/        shared UI components
└── pages/
    ├── TripsPage.tsx   live trip list + map
    ├── DriversPage.tsx driver roster
    └── PayoutsPage.tsx payout review
```

---

## Common commands

| Command | What it does |
|---------|-------------|
| `pnpm dev` | Start Vite dev server (http://localhost:5173) |
| `pnpm build` | Type-check, then Vite production build → dist/ |
| `pnpm preview` | Preview production build locally |
| `pnpm test` | Run tests (Vitest; passes when no test files exist yet) |
| `pnpm lint` | ESLint (root `eslint.config.mjs`, incl. react-hooks rules) |
| `pnpm typecheck` | TypeScript check only |
