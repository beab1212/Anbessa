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
| `services/auth-service/tests/unit/auth.service.test.ts` | 4 | Unit: login/register business rules with all boundaries mocked |
| `apps/rider-app/test/widget_test.dart` | 3 | Widget: boots to login; rider → sign out → driver flow; provider override straight into driver mode |
| `packages/core/test/primary_button_test.dart` | 1 | Widget: shared button |
| `services/*/tests/unit`, `services/*/tests/integration` | — | Empty, ready for tests |
| `apps/admin-dashboard` | — | None yet (see section 7) |

---

## 3. Running a subset

```bash
pnpm --filter @ride-app/auth-service test                 # one service
cd services/auth-service && pnpm vitest                    # watch mode
pnpm vitest tests/unit/auth.service.test.ts -t "login"    # one file / one test name

cd apps/rider-app && flutter test                          # one Flutter package
flutter test test/widget_test.dart --plain-name "boots"   # one Flutter test
```

---

## 4. Backend unit tests (Vitest)

Put them in `services/<svc>/tests/unit/*.test.ts`. Vitest's default include
pattern picks them up, so no config file is needed.

**Rule: mock the module boundaries, assert on business logic.** Many modules
do work at import time. `config/index.ts` validates `process.env`, and
`auth.service.ts` reads the private key file. Mock those modules *before*
importing the code under test:

```ts
import { vi } from "vitest";

vi.mock("../../src/config/index.js", () => ({ config: { JWT_PRIVATE_KEY_PATH: "x", JWT_ACCESS_TTL: "15m" } }));
vi.mock("node:fs", () => ({ readFileSync: vi.fn(() => "test-key") }));
vi.mock("../../src/repositories/user.repository.js", () => ({ userRepository: { findByEmail: vi.fn(), create: vi.fn() } }));

const { authService } = await import("../../src/services/auth.service.js");
```

`tests/unit/auth.service.test.ts` is the worked example: copy its shape.

### HTTP-level tests

`src/app.ts` builds the Fastify instance without calling `listen()`, so routes
can be exercised in-process with `app.inject`. Mock the same boundaries as above:

```ts
const { buildApp } = await import("../../src/app.js");
const app = await buildApp();
const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "a@b.c", password: "x" } });
expect(res.statusCode).toBe(401);
```

---

## 5. Auth tests (planned with Better Auth)

When auth-service moves to Better Auth ([Auth.md](../design/Auth.md)), add an **auth suite** that runs on every Better Auth upgrade ([Auth.md R6](../design/Auth.md#15-risks-and-spikes)):
- **OTP:** send → verify, the 3-attempt limit, expiry, the rate limit on `send-otp`.
- **Tokens:** `/token` claims match `definePayload` (no PII), `aud` per surface, ES256 `kid` resolvable from the JWKS.
- **Surfaces:** an app session can't mint a `ride-admin` token. Staff without 2FA get no staff roles.
- **Grants:** `addMember` into a `STAFF_CITY` org without an approved request is refused.
- **Ban:** sessions revoked, `/token` refused, `user.suspended` written to the outbox.
- **Rotation:** tokens signed with the previous key still verify during the grace period.

## 6. Integration tests (not set up yet)

`services/*/tests/integration/` is reserved for tests against real
Postgres, Redis and Kafka. No tooling is installed yet. The recommended setup:

1. Add `testcontainers` + `@testcontainers/postgresql` as devDependencies of the service.
2. In a Vitest `globalSetup`, start `postgis/postgis:18-3.6-alpine` (the same image as dev), then run
   `prisma migrate deploy` against it with `DATABASE_URL` pointing at the container.
3. Keep integration tests in a separate Vitest project or script (`test:integration`), so `pnpm test` stays fast and Docker-free.
   Run them in CI as their own job.

Quick manual alternative: `make infra-up`, then point `DATABASE_URL` at a
throwaway database (e.g. `auth_service_test`) and run `prisma migrate dev`.

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
