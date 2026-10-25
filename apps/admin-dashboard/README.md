# admin-dashboard

React + Vite web app for ops and support teams — live trip map, driver roster,
payout review, dispute resolution.

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
