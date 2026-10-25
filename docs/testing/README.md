# Testing guide

What we test, how to run it, and how to write new tests. CI runs the same
commands (`.github/workflows/ci.yml`), so if these pass locally the CI checks
should pass too.

---

## 1. The gates

```bash
# Node workspace (Turborepo, every service + lib + admin dashboard)
pnpm lint && pnpm typecheck && pnpm test && pnpm build

# Flutter workspace (apps/rider-app + packages/core)
dart run melos run analyze && dart run melos run test

# or both halves at once
make lint && make test
```

| Gate | Tool | Notes |
|------|------|-------|
| `pnpm lint` | ESLint 10 flat config (`eslint.config.mjs`) | typescript-eslint recommended + react-hooks for the dashboard |
| `pnpm typecheck` | `tsc --noEmit` (TypeScript 7) | Services check against lib **source**, so no build is needed first |
| `pnpm test` | Vitest 5 | `--passWithNoTests`: packages without tests pass |
| `pnpm build` | `tsc` / `vite build` | Libs build first (`^build`) |
| `melos run analyze` | `flutter analyze` + flutter_lints 6 | Warnings fail the run |
| `melos run test` | `flutter test` | Every package with a `test/` folder |

Turbo caches results. To re-run everything anyway: `pnpm test --force`.

---

## 2. What exists today

| Where | Tests | Kind |
|-------|-------|------|
| `libs/shared-authz/tests` | 18 | Unit: scope checks (`authorize`, `citiesWith`), token verification (alg pinning, audience, denylist, `pv`) |
| `services/auth-service/tests/unit` | 39 | Unit: role decoding, claims gating per surface, endpoint allowlist, config rules |
| `services/auth-service/tests/integration` | 31 | Integration: the real app on a throwaway Postgres database (section 5) |
| `apps/rider-app/test/widget_test.dart` | 3 | Widget: boots to login; rider → sign out → driver flow; provider override straight into driver mode |
| `packages/core/test/primary_button_test.dart` | 1 | Widget: shared button |
| other `services/*/tests` | — | Empty, ready for tests |
| `apps/admin-dashboard` | — | None yet (see section 7) |

---

## 3. Running a subset

```bash
pnpm --filter @ride-app/auth-service test                 # one service
cd services/auth-service && pnpm vitest                    # watch mode
pnpm vitest tests/unit/claims.test.ts -t "two-factor"      # one file / one test name

cd apps/rider-app && flutter test                          # one Flutter package
flutter test test/widget_test.dart --plain-name "boots"   # one Flutter test
```

---

## 4. Backend unit tests (Vitest)

Put them in `services/<svc>/tests/unit/*.test.ts`. Vitest's default include
pattern picks them up, so no config file is needed.

**Rule: keep logic in pure functions, and test those without mocks.** In
auth-service, config is parsed by `loadConfig(env)` (no import-time side
effects) and the decision logic lives in plain modules: `auth/roles-codec.ts`,
`auth/claims.ts`, `auth/allowlist.ts`. Their tests need no database:

```ts
import { selectRolesForSurface } from "../../src/auth/claims.js";

it("admin tokens carry no roles without two-factor", () => {
  expect(selectRolesForSurface(roles, "admin", { id: "u1", twoFactorEnabled: false })).toEqual([]);
});
```

When a function needs the database only for a lookup, pass a stub with just that method
(`{ member: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as Db`), as
`tests/unit/claims.test.ts` does.

### HTTP-level tests

`buildApp(deps)` builds the Fastify instance from its dependencies without calling
`listen()`, so routes can be exercised in-process with `app.inject`. `createContainer(config, logger, opts)`
builds those dependencies; tests pass `otpSink` (to capture OTP codes) and `signals` (an
in-memory replacement for Redis). See `tests/integration/harness.ts`.

---

## 5. Auth tests

The auth suite runs on every change to auth-service, and **must** pass before any Better Auth upgrade ([Auth.md R6](../design/Auth.md#15-risks-and-spikes)).

```bash
make infra-up                                              # Postgres on :5432
pnpm --filter @ride-app/auth-service test:integration      # ~30 s
```

`tests/integration/global-setup.ts` drops and recreates `auth_service_test` (it refuses any name that doesn't end in `_test`), then runs `prisma migrate deploy`. So every run starts from the real migrations, seed rows included. Override the URL with `TEST_DATABASE_URL`.

What it covers (`tests/integration/auth.test.ts`):
- **OTP:** send → verify → session, the 3-attempt lockout, non-Ethiopian numbers refused, no self-service phone change.
- **Tokens:** ES256 header, claims without PII, `aud` per surface, app tokens refused by staff APIs, app sessions can't mint admin tokens.
- **Lockdown:** admin-plugin endpoints, email sign-up and `two-factor/disable` return 404. App users get 404 for any staff organisation.
- **Staff:** no roles until the password is changed and TOTP enrolled. Maker ≠ checker, non-grantable roles, the two-super-admin floor, `pv` invalidation of older tokens.
- **Call center:** a guest is created in the agent's city only, then claimed by OTP (same user id).
- **Suspension:** sessions deleted, existing JWTs refused (`token_revoked`), `/token` refused, reinstatement works. Only super admins suspend staff.
- **Partners:** fleet create (pending) → verification → invite by phone → accept → `FLEET_DRIVER` claim, no role smuggling, protected fields, no staff-org creation.
- **Internal API:** service token required. Driver role on/off.

Not covered yet: key rotation with the grace period, Redis-backed rate limits (tests run with `AUTH_RATE_LIMIT=off` and no Redis), the outbox relay against Redpanda.

## 6. Integration tests for other services

Follow auth-service: a `vitest.integration.config.ts` with a `globalSetup` that recreates a `<svc>_test` database and runs migrations, a `test:integration` script, and `pnpm test` excluding `tests/integration/**`, so `pnpm test` stays fast and needs no Docker.

For CI without a shared Postgres, the same `globalSetup` can start `postgis/postgis:18-3.6-alpine` with `testcontainers` instead.

---

## 7. Admin dashboard

Vitest is installed, but there are no tests and no DOM environment yet. To add component tests:

```bash
pnpm --filter @ride-app/admin-dashboard add -D jsdom @testing-library/react @testing-library/jest-dom
```

Then set `test: { environment: "jsdom" }` in `vite.config.ts` and put tests next to components as `*.test.tsx`.

---

## 8. Flutter tests

- Wrap widgets in `ProviderScope`, as `main()` does.
- To start in a given mode, override the session provider instead of tapping through login:

  ```dart
  await tester.pumpWidget(ProviderScope(
    overrides: [sessionRoleProvider.overrideWith(() => _DriverSession())],
    child: const RideApp(),
  ));
  // class _DriverSession extends SessionRole { @override AppRole? build() => AppRole.driver; }
  ```
- Repositories are abstract (`features/*/domain`), so tests can swap in fakes through providers without a backend.
- Integration and device tests (`integration_test/`) aren't set up. Add the `integration_test` SDK package when you need them.

---

## 9. Coverage

Not wired up yet:

- **Node:** `pnpm add -D -w @vitest/coverage-v8`, then `pnpm vitest run --coverage` in a package (turbo already caches `coverage/**`).
- **Flutter:** `flutter test --coverage` writes `coverage/lcov.info`.
