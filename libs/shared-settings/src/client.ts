// Reading live settings in a service. Load once at start from platform-service, reload when it
// publishes on `settings:changed`, poll as a backstop. get() is synchronous and never fails: a value
// resolves as city override → global value → this service's default (e.g. from its env) → the
// registry default. If platform-service is down at start, the service runs on its defaults.

import { settingDef } from "./registry.js";

export const SETTINGS_CHANNEL = "settings:changed";

export interface CityInfo {
  id: string;
  name: string;
  timezone: string;
  enabled: boolean;
  bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number };
}

export interface VehicleTypeInfo {
  code: string;
  name: string;
  seatsMin: number;
  seatsMax: number;
  enabled: boolean;
  /** cities where it's offered; empty = every city */
  cities: string[];
}

export interface SettingsSnapshot {
  version: number;
  global: Record<string, unknown>;
  /** per-city overrides */
  cities: Record<string, Record<string, unknown>>;
  cityList: CityInfo[];
  vehicleTypes: VehicleTypeInfo[];
}

interface RedisLike {
  duplicate(): {
    subscribe(channel: string): Promise<unknown>;
    on(event: "message", listener: (channel: string, message: string) => void): unknown;
    quit(): Promise<unknown>;
  };
}

interface LoggerLike {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export const emptySnapshot = (): SettingsSnapshot => ({ version: 0, global: {}, cities: {}, cityList: [], vehicleTypes: [] });

/** platform-service's internal snapshot endpoint (service token). */
export function fetchSettingsSnapshotFrom(platformInternalUrl: string, token: string): () => Promise<SettingsSnapshot> {
  return async () => {
    const res = await fetch(new URL("/internal/settings/snapshot", platformInternalUrl), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`platform-service answered ${res.status}`);
    return (await res.json()) as SettingsSnapshot;
  };
}

export interface SettingsReader {
  /** The value in force (for a city, if given). */
  get<T = unknown>(key: string, cityId?: string): T;
  snapshot(): SettingsSnapshot;
}

/** Pure resolution over a snapshot (also used by platform-service itself). */
export function resolveSetting(snap: SettingsSnapshot, key: string, cityId: string | undefined, defaults: Record<string, unknown> = {}): unknown {
  const def = settingDef(key);
  if (!def) throw new Error(`unknown setting ${key}`);
  if (cityId && def.scope === "city" && snap.cities[cityId] && key in snap.cities[cityId]!) return snap.cities[cityId]![key];
  if (key in snap.global) return snap.global[key];
  if (key in defaults) return defaults[key];
  return def.default;
}

/** Fixed values (tests, or a service running without platform-service). */
export function staticSettings(values: Record<string, unknown> = {}, cityValues: Record<string, Record<string, unknown>> = {}): SettingsReader & { set(key: string, value: unknown, cityId?: string): void } {
  const snap: SettingsSnapshot = { ...emptySnapshot(), global: { ...values }, cities: structuredClone(cityValues) };
  return {
    get: <T>(key: string, cityId?: string) => resolveSetting(snap, key, cityId) as T,
    snapshot: () => snap,
    set(key, value, cityId) {
      if (cityId) (snap.cities[cityId] ??= {})[key] = value;
      else snap.global[key] = value;
    },
  };
}

export function createSettingsClient(opts: {
  fetchSnapshot: () => Promise<SettingsSnapshot>;
  redis?: RedisLike;
  logger: LoggerLike;
  /** this service's own defaults (e.g. its env values), below stored values */
  defaults?: Record<string, unknown>;
  pollMs?: number;
}) {
  let current = emptySnapshot();
  let timer: NodeJS.Timeout | undefined;
  let sub: ReturnType<RedisLike["duplicate"]> | undefined;
  const defaults = opts.defaults ?? {};

  async function refresh(reason: string) {
    try {
      const next = await opts.fetchSnapshot();
      if (next.version !== current.version) {
        current = next;
        opts.logger.info({ version: next.version, reason }, "settings updated");
      }
    } catch (err) {
      opts.logger.warn({ err: (err as Error).message, reason }, "settings refresh failed; keeping the current values");
    }
  }

  return {
    get: <T = unknown>(key: string, cityId?: string) => resolveSetting(current, key, cityId, defaults) as T,
    snapshot: () => current,
    refresh,
    async start() {
      await refresh("start");
      if (opts.redis) {
        try {
          sub = opts.redis.duplicate();
          sub.on("message", () => void refresh("published"));
          await sub.subscribe(SETTINGS_CHANNEL);
        } catch (err) {
          opts.logger.warn({ err: (err as Error).message }, "can't subscribe to settings changes; polling only");
        }
      }
      timer = setInterval(() => void refresh("poll"), opts.pollMs ?? 30_000);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      await sub?.quit().catch(() => undefined);
    },
  };
}

export type SettingsClient = ReturnType<typeof createSettingsClient>;
