// Keeps this process's registry equal to auth-service's: load at start, reload when auth-service
// publishes on the Redis channel `authz:changed`, and poll as a backstop (lost messages, no Redis).
// If auth-service can't be reached at start, the built-in matrix stays in force (logged).

import { getAuthzSnapshot, setAuthzSnapshot, type AuthzSnapshot } from "./registry.js";

export const AUTHZ_CHANNEL = "authz:changed";

/** The subset of an ioredis client needed for pub/sub (kept structural: no Redis dependency here). */
export interface RedisLike {
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

export interface AuthzSyncOptions {
  fetchSnapshot: () => Promise<AuthzSnapshot>;
  redis?: RedisLike;
  logger: LoggerLike;
  pollMs?: number;
}

/** The internal endpoint every service reads (auth-service, service token). */
export function fetchAuthzSnapshotFrom(authInternalUrl: string, token: string): () => Promise<AuthzSnapshot> {
  return async () => {
    const res = await fetch(new URL("/internal/authz/snapshot", authInternalUrl), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`auth-service answered ${res.status}`);
    return (await res.json()) as AuthzSnapshot;
  };
}

export function createAuthzSync(opts: AuthzSyncOptions) {
  let timer: NodeJS.Timeout | undefined;
  let sub: ReturnType<RedisLike["duplicate"]> | undefined;

  async function refresh(reason: string) {
    try {
      const next = await opts.fetchSnapshot();
      if (next.version !== getAuthzSnapshot().version) {
        setAuthzSnapshot(next);
        opts.logger.info({ version: next.version, reason }, "permission matrix updated");
      }
    } catch (err) {
      opts.logger.warn({ err: (err as Error).message, reason }, "permission matrix refresh failed; keeping the current one");
    }
  }

  return {
    refresh,
    async start() {
      await refresh("start");
      if (opts.redis) {
        try {
          sub = opts.redis.duplicate();
          sub.on("message", () => void refresh("published"));
          await sub.subscribe(AUTHZ_CHANNEL);
        } catch (err) {
          opts.logger.warn({ err: (err as Error).message }, "can't subscribe to permission changes; polling only");
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

export type AuthzSync = ReturnType<typeof createAuthzSync>;
