// Shared plumbing for engine calls: a hard timeout and a small circuit breaker, so a slow
// or dead engine costs callers at most one timeout, then fails fast until it recovers.

export class EngineError extends Error {
  constructor(readonly engine: string, readonly reason: string, readonly status?: number) {
    super(`${engine}: ${reason}`);
  }
}

export interface Breaker {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly open: boolean;
}

/** Opens after `threshold` consecutive failures; one trial call is let through every `cooldownMs`. */
export function breaker(engine: string, opts: { threshold?: number; cooldownMs?: number; now?: () => number } = {}): Breaker {
  const threshold = opts.threshold ?? 3;
  const cooldown = opts.cooldownMs ?? 10_000;
  const now = opts.now ?? Date.now;
  let failures = 0;
  let openedAt = 0;
  return {
    get open() {
      return failures >= threshold && now() - openedAt < cooldown;
    },
    async run(fn) {
      if (this.open) throw new EngineError(engine, "circuit open");
      try {
        const out = await fn();
        failures = 0;
        return out;
      } catch (err) {
        // "no route" style answers are valid responses, not engine failures
        if (!(err instanceof EngineError && err.status !== undefined && err.status < 500)) {
          failures++;
          if (failures >= threshold) openedAt = now();
        }
        throw err;
      }
    },
  };
}

export async function getJson<T>(engine: string, url: URL, timeoutMs: number, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new EngineError(engine, (err as Error).name === "TimeoutError" ? "timeout" : "unreachable");
  }
  const body = await res.json().catch(() => undefined);
  if (!res.ok && res.status >= 500) throw new EngineError(engine, `http ${res.status}`, res.status);
  if (body === undefined) throw new EngineError(engine, "invalid response", 502);
  return body as T;
}
