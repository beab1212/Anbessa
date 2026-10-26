// Live settings (libs/shared-settings registry). A change applies at once, or, for sensitive
// settings, waits for a second super admin. Every applied change bumps settings_version, writes
// history and an audit event, and (after commit) publishes `settings:changed` so services reload.

import { authorize, type Principal } from "@ride-app/shared-authz";
import { SETTING_GROUPS, SETTINGS, SETTINGS_CHANNEL, settingDef, validateSetting, type SettingsSnapshot } from "@ride-app/shared-settings";
import type { Logger } from "@ride-app/shared-utils";
import type { Db } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { AppError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { audit, writeOutbox } from "../outbox/outbox.js";

type Tx = Prisma.TransactionClient;
const APPROVAL_TTL_MS = 7 * 24 * 3600 * 1000;

export interface Publisher {
  publish(channel: string, message: string): Promise<unknown>;
}

const jsonOrNull = (v: unknown) => (v === null || v === undefined ? Prisma.JsonNull : (v as Prisma.InputJsonValue));
const show = (v: unknown) => (v === null || v === undefined ? "default" : JSON.stringify(v));

export async function bumpVersion(tx: Tx): Promise<number> {
  return (await tx.settingsVersion.update({ where: { id: 1 }, data: { version: { increment: 1 } } })).version;
}

/** Everything services need: values, overrides, cities and vehicle types. */
export async function loadSnapshot(db: Tx | Db): Promise<SettingsSnapshot> {
  const [values, version, cities, types] = await Promise.all([
    db.settingValue.findMany(),
    db.settingsVersion.findUnique({ where: { id: 1 } }),
    db.city.findMany({ orderBy: { name: "asc" } }),
    db.vehicleType.findMany({ orderBy: [{ sortOrder: "asc" }, { code: "asc" }] }),
  ]);
  const snap: SettingsSnapshot = { version: version?.version ?? 0, global: {}, cities: {}, cityList: [], vehicleTypes: [] };
  for (const v of values) {
    if (v.cityId) (snap.cities[v.cityId] ??= {})[v.key] = v.value;
    else snap.global[v.key] = v.value;
  }
  snap.cityList = cities.map((c) => ({ id: c.id, name: c.name, timezone: c.timezone, enabled: c.enabled, bbox: { minLat: c.minLat, minLng: c.minLng, maxLat: c.maxLat, maxLng: c.maxLng } }));
  snap.vehicleTypes = types.map((t) => ({ code: t.code, name: t.name, seatsMin: t.seatsMin, seatsMax: t.seatsMax, enabled: t.enabled, cities: t.cities }));
  return snap;
}

export function createSettingsService(deps: { db: Db; logger: Logger; publisher?: Publisher; now?: () => Date }) {
  const { db, logger } = deps;
  const now = deps.now ?? (() => new Date());

  async function publish(version: number) {
    try {
      await deps.publisher?.publish(SETTINGS_CHANNEL, String(version));
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "couldn't publish settings:changed; services pick it up on their next poll");
    }
  }

  /** Write one value (null = remove → default) with history, version and audit, in the caller's transaction. */
  async function applyTx(tx: Tx, input: { key: string; cityId: string | null; value: unknown; reason: string; changedBy: string; approvedBy?: string }) {
    const existing = await tx.settingValue.findFirst({ where: { key: input.key, cityId: input.cityId } });
    if (input.value === null) {
      if (existing) await tx.settingValue.delete({ where: { id: existing.id } });
    } else if (existing) {
      await tx.settingValue.update({ where: { id: existing.id }, data: { value: input.value as Prisma.InputJsonValue, updatedBy: input.changedBy } });
    } else {
      await tx.settingValue.create({ data: { key: input.key, cityId: input.cityId, value: input.value as Prisma.InputJsonValue, updatedBy: input.changedBy } });
    }
    const version = await bumpVersion(tx);
    await tx.settingHistory.create({
      data: { key: input.key, cityId: input.cityId, oldValue: jsonOrNull(existing?.value), newValue: jsonOrNull(input.value), changedBy: input.changedBy, approvedBy: input.approvedBy ?? null, reason: input.reason, version },
    });
    await writeOutbox(tx,
      { topic: "platform.settings_changed", key: input.key, payload: { version, keys: [input.key], cityId: input.cityId, byUserId: input.approvedBy ?? input.changedBy } },
      audit({
        actorId: input.approvedBy ?? input.changedBy, action: "settings:change", resource: { type: "setting", id: input.cityId ? `${input.key}@${input.cityId}` : input.key },
        outcome: "EXECUTED", reason: `${show(existing?.value)} → ${show(input.value)} · ${input.reason}`,
      }),
    );
    return version;
  }

  async function checkCity(tx: Tx | Db, cityId: string | null) {
    if (cityId && !(await tx.city.findUnique({ where: { id: cityId } }))) throw badRequest(`unknown city ${cityId}`);
  }

  async function lockPending(tx: Tx, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM setting_change WHERE id = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) throw notFound("change request");
    const c = await tx.settingChange.findUniqueOrThrow({ where: { id } });
    if (c.status !== "PENDING") throw conflict(`request is ${c.status.toLowerCase()}`, "not_pending");
    return c;
  }

  return {
    applyTx,
    publish,
    snapshot: () => loadSnapshot(db),

    async overview(p: Principal) {
      authorize(p, "settings:read");
      const [snap, pending] = await Promise.all([
        loadSnapshot(db),
        db.settingChange.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" } }),
      ]);
      return { version: snap.version, groups: SETTING_GROUPS, definitions: SETTINGS, global: snap.global, cities: snap.cities, cityList: snap.cityList, pending };
    },

    async history(p: Principal, q: { key?: string; limit: number }) {
      authorize(p, "settings:read");
      return db.settingHistory.findMany({ where: q.key ? { key: q.key } : {}, orderBy: { at: "desc" }, take: q.limit });
    },

    /** Set (or with value null, reset) a setting. Applies at once unless it's sensitive. */
    async propose(p: Principal, key: string, input: { value: unknown; cityId?: string | null; reason: string }) {
      authorize(p, "settings:propose");
      const def = settingDef(key);
      if (!def) throw notFound("setting");
      const cityId = input.cityId ?? null;
      if (cityId && def.scope !== "city") throw badRequest(`${def.label} is the same in every city`);
      if (input.reason.trim().length < 5) throw badRequest("say why (5+ characters)");
      let value: unknown = input.value;
      if (value !== null) {
        const v = validateSetting(key, value);
        if (!v.ok) throw new AppError(400, v.error, "invalid_value");
        value = v.value;
      }
      await checkCity(db, cityId);

      if (def.sensitive) {
        const change = await db.$transaction(async (tx) => {
          const dup = await tx.settingChange.findFirst({ where: { key, cityId, status: "PENDING" } });
          if (dup) throw conflict("a change to this setting is already waiting for approval", "change_pending");
          const c = await tx.settingChange.create({
            data: { key, cityId, value: jsonOrNull(value), reason: input.reason.trim(), makerId: p.userId, expiresAt: new Date(now().getTime() + APPROVAL_TTL_MS) },
          });
          await writeOutbox(tx, audit({ actorId: p.userId, action: "settings:propose", resource: { type: "setting", id: cityId ? `${key}@${cityId}` : key }, outcome: "PENDING_APPROVAL", reason: `→ ${show(value)} · ${input.reason}` }));
          return c;
        });
        return { status: "PENDING_APPROVAL" as const, change };
      }
      const version = await db.$transaction((tx) => applyTx(tx, { key, cityId, value, reason: input.reason.trim(), changedBy: p.userId }));
      await publish(version);
      return { status: "APPLIED" as const, version };
    },

    async changes(p: Principal, status?: string) {
      authorize(p, "settings:read");
      return db.settingChange.findMany({ where: status ? { status } : {}, orderBy: { createdAt: "desc" }, take: 100 });
    },

    async approve(p: Principal, id: string, decisionReason?: string) {
      authorize(p, "settings:approve");
      const version = await db.$transaction(async (tx) => {
        const c = await lockPending(tx, id);
        if (c.makerId === p.userId) throw forbidden("maker and checker must be different people", "maker_is_checker");
        if (c.expiresAt <= now()) throw conflict("request expired", "expired");
        const value = c.value === null ? null : c.value;
        if (value !== null) {
          const v = validateSetting(c.key, value);
          if (!v.ok) throw new AppError(400, v.error, "invalid_value");
        }
        const v = await applyTx(tx, { key: c.key, cityId: c.cityId, value, reason: c.reason, changedBy: c.makerId, approvedBy: p.userId });
        await tx.settingChange.update({ where: { id }, data: { status: "EXECUTED", checkerId: p.userId, decidedAt: now(), decisionReason } });
        return v;
      });
      await publish(version);
      return { id, status: "EXECUTED", version };
    },

    async reject(p: Principal, id: string, decisionReason: string) {
      authorize(p, "settings:approve");
      return db.$transaction(async (tx) => {
        const c = await lockPending(tx, id);
        if (c.makerId === p.userId) throw forbidden("maker and checker must be different people", "maker_is_checker");
        await tx.settingChange.update({ where: { id }, data: { status: "REJECTED", checkerId: p.userId, decidedAt: now(), decisionReason } });
        await writeOutbox(tx, audit({ actorId: p.userId, action: "settings:reject", resource: { type: "setting_change", id }, outcome: "EXECUTED", reason: decisionReason }));
        return { id, status: "REJECTED" };
      });
    },

    async cancel(p: Principal, id: string) {
      return db.$transaction(async (tx) => {
        const c = await lockPending(tx, id);
        if (c.makerId !== p.userId) throw forbidden("only the person who asked can withdraw a request");
        await tx.settingChange.update({ where: { id }, data: { status: "CANCELLED", decidedAt: now() } });
        return { id, status: "CANCELLED" };
      });
    },

    async expire() {
      return (await db.settingChange.updateMany({ where: { status: "PENDING", expiresAt: { lte: now() } }, data: { status: "EXPIRED" } })).count;
    },
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;
