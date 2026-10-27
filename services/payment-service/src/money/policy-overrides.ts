// Per-beneficiary policy overrides (Payment.md §13 beneficiary_policy_override, §15): an exception
// to the city's balance limits for one driver or fleet, for a time window: a trusted fleet with a
// larger cash limit for a month, a new driver forced to PREPAID. An onboarding officer asks (in
// their city); a finance manager approves, never the same person. The merged limits are checked
// against the city's policy on the request and again on approval. Approved overrides of one balance
// never overlap (exclusion constraint). The balance's state is recomputed when one starts, ends or
// is revoked (the 5-minute job catches windows that open or close later).

import { authorize, can, type Principal } from "@ride-app/shared-authz";
import type { PolicyOverride } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import { afterPosting, beneficiariesOf, findBeneficiary, overrideFields, policyAt, type BeneficiarySummary } from "./balances.js";
import { DECISION_TTL_MS, overrideProblem, type OverrideFields } from "./controls.js";
import { cityFilter, reachOf, reachesAnything } from "./reach.js";

export interface OverrideInput extends OverrideFields {
  accountId?: string | undefined;
  referenceCode?: string | undefined;
  validFrom: Date | null;
  validUntil: Date;
  reason: string;
}

export function overrideView(o: PolicyOverride, b?: BeneficiarySummary, now = new Date()) {
  return {
    id: o.id, accountId: o.beneficiaryAccountId, cityId: o.cityId, ...overrideFields(o), validFrom: o.validFrom, validUntil: o.validUntil,
    reason: o.reason, status: o.status, requestedBy: o.requestedBy, decidedBy: o.decidedBy, decisionReason: o.decisionReason,
    revokedBy: o.revokedBy, revokedAt: o.revokedAt, createdAt: o.createdAt, decidedAt: o.decidedAt, expiresAt: o.expiresAt,
    inForce: o.status === "APPROVED" && o.validFrom <= now && o.validUntil > now,
    ...(b ? { beneficiary: b.beneficiary, referenceCode: b.referenceCode, balanceMinor: b.balanceMinor, state: b.state } : {}),
  };
}

const VIEWERS = ["policy_override:request", "policy_override:approve", "balance:read"] as const;
const DECIDERS = ["policy_override:request", "policy_override:approve"] as const;

const isOverlap = (err: unknown) => {
  const text = `${(err as Error)?.message ?? ""} ${JSON.stringify(err ?? {})}`;
  return text.includes("ex_policy_override_no_overlap") || text.includes("23P01");
};

export function createPolicyOverrides(deps: { db: Db; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  async function withOwners(rows: PolicyOverride[]) {
    const owners = await beneficiariesOf(db, rows.map((r) => r.beneficiaryAccountId));
    return rows.map((r) => overrideView(r, owners.get(r.beneficiaryAccountId), now()));
  }

  const overlapping = (accountId: string, from: Date, until: Date, exceptId?: string) =>
    db.policyOverride.findFirst({
      where: { beneficiaryAccountId: accountId, status: "APPROVED", validFrom: { lt: until }, validUntil: { gt: from }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });

  /** The balance's state with the limits now in force (publishes a change). */
  const recompute = (accountId: string) => db.$transaction((tx) => afterPosting(tx, accountId, { creditMinor: 0, now: now() }));

  return {
    async request(p: Principal, input: OverrideInput) {
      const b = await findBeneficiary(db, input);
      if (!b) throw notFound("balance");
      authorize(p, "policy_override:request", { cityId: b.cityId });
      const at = now();
      const validFrom = input.validFrom && input.validFrom > at ? input.validFrom : at;
      const city = await db.$transaction((tx) => policyAt(tx, b.cityId, validFrom));
      const problem = overrideProblem(city, { ...input, validFrom }, at);
      if (problem) throw badRequest(problem, "invalid_override");
      if (await overlapping(b.accountId, validFrom, input.validUntil)) throw conflict("an approved override of this balance already covers part of that window", "overlap");
      return db.$transaction(async (tx) => {
        const o = await tx.policyOverride.create({
          data: {
            beneficiaryAccountId: b.accountId, cityId: b.cityId, mode: input.mode,
            warningMinor: input.warningMinor === null ? null : BigInt(input.warningMinor), cashLimitMinor: input.cashLimitMinor === null ? null : BigInt(input.cashLimitMinor),
            hardLimitMinor: input.hardLimitMinor === null ? null : BigInt(input.hardLimitMinor),
            prepaidMinimumMinor: input.prepaidMinimumMinor === null ? null : BigInt(input.prepaidMinimumMinor),
            validFrom, validUntil: input.validUntil, reason: input.reason, requestedBy: p.userId, expiresAt: new Date(at.getTime() + DECISION_TTL_MS),
          },
        });
        await writeOutbox(tx, audit({ actorId: p.userId, action: "policy_override:request", resource: { type: "policy_override", id: o.id }, outcome: "EXECUTED", reason: input.reason }));
        return overrideView(o, undefined, at);
      });
    },

    async decide(p: Principal, id: string, decision: "approve" | "reject" | "cancel", reason?: string) {
      const o = await db.policyOverride.findUnique({ where: { id } });
      if (!o) throw notFound("override");
      if (decision === "cancel") {
        if (o.requestedBy !== p.userId) throw forbidden("only the person who asked can withdraw it");
      } else {
        authorize(p, "policy_override:approve", { cityId: o.cityId });
        if (o.requestedBy === p.userId) throw forbidden("someone else must approve what you asked for", "maker_checker");
        if (decision === "reject" && !reason) throw badRequest("say why", "reason_required");
      }
      if (o.status !== "PENDING_APPROVAL") throw conflict(`the override is ${o.status.toLowerCase().replace("_", " ")}`, "invalid_state");
      if (o.expiresAt < now()) {
        await db.policyOverride.updateMany({ where: { id, status: "PENDING_APPROVAL" }, data: { status: "EXPIRED" } });
        throw conflict("the request expired; ask again", "expired");
      }
      if (decision === "approve") {
        // the limits again, against the city's policy as it is now
        const city = await db.$transaction((tx) => policyAt(tx, o.cityId, o.validFrom > now() ? o.validFrom : now()));
        const problem = overrideProblem(city, { ...overrideFields(o), validFrom: o.validFrom, validUntil: o.validUntil }, now());
        if (problem) throw conflict(problem, "invalid_override");
        if (await overlapping(o.beneficiaryAccountId, o.validFrom, o.validUntil, o.id)) throw conflict("an approved override of this balance already covers part of that window", "overlap");
      }
      try {
        await db.$transaction(async (tx) => {
          const { count } = await tx.policyOverride.updateMany({ where: { id, status: "PENDING_APPROVAL", decidedBy: null }, data: { decidedBy: p.userId } });
          if (count === 0) throw conflict("the override was already decided", "invalid_state");
          const status = decision === "approve" ? "APPROVED" : decision === "reject" ? "REJECTED" : "CANCELLED";
          await tx.policyOverride.update({ where: { id }, data: { status, decidedAt: now(), decisionReason: reason ?? null } });
          // in force already: the balance's state follows at once
          if (decision === "approve" && o.validFrom <= now()) await afterPosting(tx, o.beneficiaryAccountId, { creditMinor: 0, now: now() });
          await writeOutbox(tx, audit({
            actorId: p.userId, action: decision === "approve" ? "policy_override:approve" : `policy_override:${decision}`,
            resource: { type: "policy_override", id }, outcome: "EXECUTED", ...(reason ? { reason } : {}),
          }));
        });
      } catch (err) {
        if (isOverlap(err)) throw conflict("an approved override of this balance already covers part of that window", "overlap");
        throw err;
      }
      return this.get(p, id);
    },

    /** End an approved override early (finance manager). The city's limits apply again at once. */
    async revoke(p: Principal, id: string, reason: string) {
      const o = await db.policyOverride.findUnique({ where: { id } });
      if (!o) throw notFound("override");
      authorize(p, "policy_override:approve", { cityId: o.cityId });
      await db.$transaction(async (tx) => {
        const { count } = await tx.policyOverride.updateMany({ where: { id, status: "APPROVED" }, data: { status: "REVOKED", revokedBy: p.userId, revokedAt: now(), decisionReason: reason } });
        if (count === 0) throw conflict("only an approved override can be revoked", "invalid_state");
        await afterPosting(tx, o.beneficiaryAccountId, { creditMinor: 0, now: now() });
        await writeOutbox(tx, audit({ actorId: p.userId, action: "policy_override:revoke", resource: { type: "policy_override", id }, outcome: "EXECUTED", reason }));
      });
      return this.get(p, id);
    },

    async get(p: Principal, id: string) {
      const o = await db.policyOverride.findUnique({ where: { id } });
      if (!o || (!VIEWERS.some((perm) => can(p, perm, { cityId: o.cityId })) && o.requestedBy !== p.userId)) throw notFound("override");
      return (await withOwners([o]))[0]!;
    },

    async list(p: Principal, q: { status?: string | undefined; accountId?: string | undefined; cityId?: string | undefined }) {
      const where = cityFilter(reachOf(p, VIEWERS), q.cityId, "balance:read");
      const rows = await db.policyOverride.findMany({
        where: { ...where, ...(q.status ? { status: q.status } : {}), ...(q.accountId ? { beneficiaryAccountId: q.accountId } : {}) },
        orderBy: { createdAt: "desc" }, take: 100,
      });
      return withOwners(rows);
    },

    async pending(p: Principal) {
      const r = reachOf(p, DECIDERS);
      if (!reachesAnything(r)) return [];
      const rows = await db.policyOverride.findMany({ where: { status: "PENDING_APPROVAL", ...(r.everywhere ? {} : { cityId: { in: r.cities } }) }, orderBy: { createdAt: "asc" }, take: 200 });
      return withOwners(rows);
    },

    async expire() {
      const { count } = await db.policyOverride.updateMany({ where: { status: "PENDING_APPROVAL", expiresAt: { lt: now() } }, data: { status: "EXPIRED" } });
      return count;
    },

    /** Approved windows that opened or closed in (since, until]: recompute those balances' states. */
    async boundaries(since: Date, until: Date) {
      const rows = await db.policyOverride.findMany({
        where: { status: "APPROVED", OR: [{ validFrom: { gt: since, lte: until } }, { validUntil: { gt: since, lte: until } }] },
        select: { beneficiaryAccountId: true },
      });
      const ids = [...new Set(rows.map((r) => r.beneficiaryAccountId))];
      for (const id of ids) await recompute(id);
      return ids.length;
    },
  };
}

export type PolicyOverrides = ReturnType<typeof createPolicyOverrides>;
