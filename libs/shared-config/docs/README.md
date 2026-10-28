# `@ride-app/shared-config`

Two env helpers built on zod. Source: [`src/env.ts`](../src/env.ts), re-exported from [`src/index.ts`](../src/index.ts).

## `nodeEnvSchema` (used)

`z.enum(["development", "test", "production"])` with **no default** and a clear message when
`NODE_ENV` is missing. notification-, support-, platform- and audit-service use it for their
`NODE_ENV`; the other services still have `.default("development")` in their own config (owned by
other teams; switch them to `nodeEnvSchema` too). Every service's `.env.example` sets
`NODE_ENV=development`, the images set `production` and vitest sets `test`.

## Status of `loadEnv`: not used

Most services list `"@ride-app/shared-config": "workspace:*"` in `package.json` (audit, auth, fleet, location, mapping, notification, payment, platform, realtime-gateway, trip; not pricing-service, not `apps/web`), but **no source or test file imports it**. `grep -r '@ride-app/shared-config' services apps --include=*.ts` returns nothing. (`apps/web/vite.config.ts` uses Vite's own `loadEnv`, unrelated.)

Services validate their env themselves in `src/config/index.ts` with zod directly. Example, `services/trip-service/src/config/index.ts`:

```ts
import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3002),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  INTERNAL_SERVICE_TOKEN: z.string().min(32),
  // …
});
```

with production-only checks (`fail("KAFKA_BROKERS", "required in production …")`) implemented per service.

## What belongs here

Helpers for reading and validating configuration at boot, so every service fails fast with a clear message instead of on the first request (comment in `env.ts`). Not per-service schemas, not live settings (those are shared-settings), not secrets.

---

## `loadEnv<T extends ZodSchema>(schema: T): z.infer<T>`

```ts
export function loadEnv<T extends ZodSchema>(schema: T, env = process.env): z.infer<T> {
  nodeEnvSchema.parse(env.NODE_ENV);
  return schema.parse(env);
}
```

`NODE_ENV` is required whatever the schema says (a schema default is ignored for this check).

Parses `process.env` with the given schema and returns the typed result. On invalid input `schema.parse` throws a `ZodError` (listing every failing variable); nothing is caught or reformatted. It doesn't load `.env` files: services rely on `tsx --env-file-if-exists=.env` in their `dev` scripts for that.

```ts
import { z } from "zod";
import { loadEnv } from "@ride-app/shared-config";

const config = loadEnv(z.object({ PORT: z.coerce.number().default(3000), REDIS_URL: z.string().url() }));
```

## `existingFile(hint: string)`

```ts
export function existingFile(hint: string) {
  return z.string().refine((path) => existsSync(path), { message: `file not found. ${hint}` });
}
```

A zod string schema that passes only if the path exists (`fs.existsSync`, so a directory also passes). For key material and certificates, so a missing file names the env var and the fix instead of an `ENOENT` deep inside a module.

```ts
const env = loadEnv(z.object({
  TLS_CERT_PATH: existingFile("Run `make secrets` or set TLS_CERT_PATH."),   // illustrative
}));
```

No call sites in the repo.

## Build and import

[`package.json`](../package.json): `exports` with `development` → `./src/index.ts`, `types`/`default` → `dist/`. Dependency: `zod` `^4.6.7`. Scripts: `build` (`tsc -p tsconfig.json`), `lint`, `typecheck`. No tests.
