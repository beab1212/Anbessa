// The system page: every service's readiness and latency, events waiting in outboxes, Kafka
// consumer lag, Redis, and the outside services we depend on (Telegram/SMS, OSRM/Nominatim,
// object storage). Checked in parallel with short timeouts and cached for 10 s.

import { Kafka, logLevel, type Admin } from "kafkajs";
import type { Redis } from "ioredis";
import { authorize, type Principal } from "@ride-app/shared-authz";
import type { Db } from "../db.js";

export interface Target {
  name: string;
  url: string;
}

type Status = "up" | "degraded" | "down";

export interface ServiceHealth {
  name: string;
  status: Status;
  latencyMs: number | null;
  detail?: Record<string, unknown>;
  error?: string;
}

/** Services that keep a transactional outbox (they answer /internal/ops/outbox). */
const OUTBOX_OWNERS = ["auth-service", "trip-service", "fleet-service"];

async function getJson(url: string, token?: string, timeoutMs = 2000): Promise<{ ok: boolean; status: number; body: unknown; ms: number }> {
  const started = Date.now();
  const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // plain "ok"
  }
  return { ok: res.ok, status: res.status, body, ms: Date.now() - started };
}

export function createSystemHealth(deps: { db: Db; redis?: Redis; targets: Target[]; token: string; kafkaBrokers?: string[]; consumerGroups: string[] }) {
  let cached: { at: number; value: unknown } | undefined;
  let admin: Admin | undefined;
  let adminConnected = false;

  async function service(t: Target): Promise<ServiceHealth> {
    try {
      const r = await getJson(new URL("/health/ready", t.url).toString());
      const detail = typeof r.body === "object" && r.body ? (r.body as Record<string, unknown>) : undefined;
      // mapping-service answers 200 with engines marked "degraded" while it falls back to estimates
      const degraded = !!detail && JSON.stringify(detail).includes("\"degraded\"");
      return { name: t.name, status: r.ok ? (degraded ? "degraded" : "up") : "down", latencyMs: r.ms, ...(detail ? { detail } : {}), ...(r.ok ? {} : { error: `HTTP ${r.status}` }) };
    } catch (err) {
      return { name: t.name, status: "down", latencyMs: null, error: (err as Error).name === "TimeoutError" ? "no answer in 2 s" : "unreachable" };
    }
  }

  async function outboxes() {
    const own = await deps.db.$queryRaw<{ pending: bigint; oldest: Date | null }[]>`
      SELECT count(*) AS pending, min(created_at) AS oldest FROM outbox WHERE published_at IS NULL`;
    const rows: { name: string; pending: number | null; oldestAt: string | null; error?: string }[] = [
      { name: "platform-service", pending: Number(own[0]?.pending ?? 0), oldestAt: own[0]?.oldest?.toISOString() ?? null },
    ];
    await Promise.all(deps.targets.filter((t) => OUTBOX_OWNERS.includes(t.name)).map(async (t) => {
      try {
        const r = await getJson(new URL("/internal/ops/outbox", t.url).toString(), deps.token);
        const b = r.body as { pending: number; oldestAt: string | null };
        rows.push(r.ok ? { name: t.name, pending: b.pending, oldestAt: b.oldestAt } : { name: t.name, pending: null, oldestAt: null, error: `HTTP ${r.status}` });
      } catch {
        rows.push({ name: t.name, pending: null, oldestAt: null, error: "unreachable" });
      }
    }));
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function kafkaLag() {
    if (!deps.kafkaBrokers?.length) return { configured: false as const, groups: [] };
    try {
      if (!admin) admin = new Kafka({ clientId: "platform-service-health", brokers: deps.kafkaBrokers, logLevel: logLevel.NOTHING }).admin();
      if (!adminConnected) {
        await admin.connect();
        adminConnected = true;
      }
      const groups = await Promise.all(deps.consumerGroups.map(async (groupId) => {
        try {
          const offsets = await admin!.fetchOffsets({ groupId });
          let lag = 0;
          const topics: { topic: string; lag: number }[] = [];
          for (const t of offsets) {
            const high = await admin!.fetchTopicOffsets(t.topic);
            let topicLag = 0;
            for (const p of t.partitions) {
              const end = Number(high.find((h) => h.partition === p.partition)?.high ?? 0);
              const committed = Number(p.offset);
              topicLag += committed < 0 ? end : Math.max(0, end - committed);
            }
            lag += topicLag;
            topics.push({ topic: t.topic, lag: topicLag });
          }
          return { groupId, lag, topics };
        } catch (err) {
          return { groupId, lag: null, topics: [], error: (err as Error).message.slice(0, 120) };
        }
      }));
      return { configured: true as const, groups };
    } catch (err) {
      adminConnected = false;
      return { configured: true as const, groups: [], error: `Kafka unreachable: ${(err as Error).message.slice(0, 120)}` };
    }
  }

  async function redisCheck() {
    if (!deps.redis) return { configured: false, status: "down" as Status, latencyMs: null };
    const started = Date.now();
    try {
      await Promise.race([deps.redis.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000))]);
      return { configured: true, status: "up" as Status, latencyMs: Date.now() - started };
    } catch {
      return { configured: true, status: "down" as Status, latencyMs: null };
    }
  }

  async function integrations(services: ServiceHealth[]) {
    const notification = deps.targets.find((t) => t.name === "notification-service");
    let otp: unknown = null;
    if (notification) {
      try {
        const r = await getJson(new URL("/internal/ops/integrations", notification.url).toString(), deps.token);
        otp = r.ok ? r.body : { error: `HTTP ${r.status}` };
      } catch {
        otp = { error: "unreachable" };
      }
    }
    const mapping = services.find((s) => s.name === "mapping-service")?.detail?.engines ?? null;
    const realtime = services.find((s) => s.name === "realtime-gateway")?.detail?.kafka ?? null;
    const fleet = deps.targets.find((t) => t.name === "fleet-service");
    let storage: unknown = null;
    if (fleet) {
      try {
        const r = await getJson(new URL("/internal/ops/storage", fleet.url).toString(), deps.token, 4000);
        storage = r.ok ? r.body : { error: `HTTP ${r.status}` };
      } catch {
        storage = { error: "unreachable" };
      }
    }
    return { messaging: otp, routing: mapping, locationStream: realtime, documentStorage: storage };
  }

  return {
    async check(p: Principal, force = false) {
      authorize(p, "system:read");
      if (!force && cached && Date.now() - cached.at < 10_000) return cached.value;
      const services = await Promise.all(deps.targets.map(service));
      const [outbox, kafka, redis, external] = await Promise.all([outboxes(), kafkaLag(), redisCheck(), integrations(services)]);
      const value = { checkedAt: new Date().toISOString(), services, outbox, kafka, redis, integrations: external };
      cached = { at: Date.now(), value };
      return value;
    },
    async stop() {
      if (adminConnected) await admin?.disconnect().catch(() => undefined);
    },
  };
}

export type SystemHealth = ReturnType<typeof createSystemHealth>;
