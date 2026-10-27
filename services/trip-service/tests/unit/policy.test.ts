import { describe, expect, it } from "vitest";
import { cancellationFee, DEFAULT_POLICY, waitingFee } from "../../src/trips/policy.js";
import { loadConfig } from "../../src/config/index.js";

const t0 = new Date("2026-10-26T08:00:00Z");
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
const base = { reason: "CHANGED_PLANS", status: "matched", matchedAt: t0, arrivedAt: null, waitingPerMinMinor: 300n };

describe("waiting fee (workflow 06 step 7)", () => {
  it("is free for 3 minutes, then per started minute", () => {
    expect(waitingFee(DEFAULT_POLICY, t0, at(180), 300n)).toBe(0n);
    expect(waitingFee(DEFAULT_POLICY, t0, at(181), 300n)).toBe(300n);
    expect(waitingFee(DEFAULT_POLICY, t0, at(300), 300n)).toBe(600n);
    expect(waitingFee(DEFAULT_POLICY, null, at(900), 300n)).toBe(0n);
  });
});

describe("cancellation fee (workflow 07 §3)", () => {
  it("rider: free before a driver is assigned and within 2 min of matching", () => {
    expect(cancellationFee(DEFAULT_POLICY, { ...base, by: "RIDER", status: "requested", matchedAt: null, now: at(600) }).feeMinor).toBe(0n);
    expect(cancellationFee(DEFAULT_POLICY, { ...base, by: "RIDER", now: at(119) })).toMatchObject({ feeMinor: 0n, waived: "free_window" });
  });

  it("rider: 30 ETB after 2 min, 80% to the driver", () => {
    expect(cancellationFee(DEFAULT_POLICY, { ...base, by: "RIDER", now: at(121) })).toEqual({ feeMinor: 3000n, compensationMinor: 2400n });
  });

  it("rider after the driver arrived: fee plus paid waiting", () => {
    const r = cancellationFee(DEFAULT_POLICY, { ...base, by: "RIDER", arrivedAt: at(60), now: at(60 + 300) });
    expect(r.feeMinor).toBe(3000n + 600n);
  });

  it("waived when the driver asked the rider to cancel", () => {
    expect(cancellationFee(DEFAULT_POLICY, { ...base, by: "RIDER", reason: "DRIVER_ASKED_TO_CANCEL", now: at(600) })).toMatchObject({ feeMinor: 0n, waived: "driver_asked" });
  });

  it("driver, staff and system cancellations are free; a no-show charges the rider", () => {
    for (const by of ["DRIVER", "STAFF", "SYSTEM"] as const) expect(cancellationFee(DEFAULT_POLICY, { ...base, by, now: at(900) }).feeMinor).toBe(0n);
    expect(cancellationFee(DEFAULT_POLICY, { ...base, by: "DRIVER", reason: "NO_SHOW", arrivedAt: at(0), now: at(400) })).toEqual({ feeMinor: 3000n, compensationMinor: 2400n });
  });
});

describe("config", () => {
  const env = { DATABASE_URL: "postgresql://x@localhost/x", REDIS_URL: "redis://localhost:6379", INTERNAL_SERVICE_TOKEN: "t".repeat(64) };

  it("refuses the quote stand-in and missing Kafka in production", () => {
    expect(() => loadConfig({ ...env, NODE_ENV: "production", PRICING: "builtin" })).toThrow(/PRICING[\s\S]*KAFKA_BROKERS|KAFKA_BROKERS[\s\S]*PRICING/);
    expect(loadConfig(env).PRICING).toBe("service");
    expect(() => loadConfig({ ...env, NODE_ENV: "production", PRICING: "service", KAFKA_BROKERS: "k:9092" })).toThrow(/SHARE_BASE_URL/);
    expect(() => loadConfig({ ...env, NODE_ENV: "production", PRICING: "service", KAFKA_BROKERS: "k:9092", SHARE_BASE_URL: "https://app.anbessa.et" })).not.toThrow();
  });

  it("parses the radius steps", () => {
    expect(loadConfig(env).MATCH_RADII_METERS).toEqual([2000, 4000, 6000]);
    expect(() => loadConfig({ ...env, MATCH_RADII_METERS: "2000,50" })).toThrow();
  });
});
