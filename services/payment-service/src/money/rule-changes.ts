// Commission rules and balance policies (Payment.md §7–§8, workflow 15 C): a change is a proposal
// of a new version from a validity time; another person approves it (maker ≠ checker). Past
// trips keep the rule they were settled with; a new policy recomputes every balance state in the
// city at once (limits may have moved).

import { authorize, can, citiesWith, type Permission, type Principal } from "@ride-app/shared-authz";
import { Prisma, type RuleChange } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import { afterPosting, policyAt, policyFromRow, ruleFromRow } from "./balances.js";
import { DEFAULT_POLICY, DEFAULT_RULE, type PolicyLike } from "./rules.js";

export interface CommissionRulePayload {
  vehicleType: string | null;
  /** a fleet's or driver's contract rule */
  beneficiaryId: string | null;
  model: "PERCENT" | "FIXED_PER_TRIP" | "ZERO";
  rateBp: number | null;
  fixedMinor: number | null;
  minMinor: number | null;
  maxMinor: number | null;
  validFrom: string | null;
}

export type BalancePolicyPayload = PolicyLike & { validFrom: string | null };

const PERMS = {
  COMMISSION_RULE: { propose: "commission_rule:propose", approve: "commission_rule:approve" },
  BALANCE_POLICY: { propose: "balance_policy:propose", approve: "balance_policy:approve" },
} as const satisfies Record<string, { propose: Permission; approve: Permission }>;

export const changeView = (c: RuleChange) => ({
  id: c.id, kind: c.kind, cityId: c.cityId, payload: c.payload, reason: c.reason, makerId: c.makerId, checkerId: c.checkerId,
  status: c.status, decisionReason: c.decisionReason, createdAt: c.createdAt, decidedAt: c.decidedAt, expiresAt: c.expiresAt,
});

export function validatePolicy(p: PolicyLike): string | null {
  if (!(p.hardLimitMinor <= p.cashLimitMinor && p.cashLimitMinor <= p.warningMinor && p.warningMinor <= 0)) {
    return "limits must be in order: hard limit ≤ cash limit ≤ warning ≤ 0";
  }
  return null;
}

export function validateRule(r: CommissionRulePayload): string | null {
  if (r.model === "PERCENT" && (r.rateBp === null || r.rateBp < 0 || r.rateBp > 10_000)) return "a percentage rule needs a rate of 0–100%";
  if (r.model === "FIXED_PER_TRIP" && (r.fixedMinor === null || r.fixedMinor < 0)) return "a fixed rule needs an amount";
  if (r.minMinor !== null && r.maxMinor !== null && r.maxMinor < r.minMinor) return "the maximum is below the minimum";
  return null;
}

export function createRuleChanges(deps: { db: Db; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  async function execute(tx: Prisma.TransactionClient, c: RuleChange, checkerId: string) {
    const from = (payload: { validFrom: string | null }) => {
      const t = payload.validFrom ? new Date(payload.validFrom) : now();
      return t.getTime() < now().getTime() ? now() : t;
    };
    if (c.kind === "COMMISSION_RULE") {
      const r = c.payload as unknown as CommissionRulePayload;
      const validFrom = from(r);
      const same = { cityId: c.cityId, vehicleType: r.vehicleType, beneficiaryId: r.beneficiaryId };
      const later = await tx.commissionRule.findFirst({ where: { ...same, validFrom: { gte: validFrom } } });
      if (later) throw conflict("a later version of this rule is already scheduled", "rule_scheduled");
      // the version in force ends where the new one starts
      await tx.commissionRule.updateMany({ where: { ...same, validFrom: { lt: validFrom }, OR: [{ validTo: null }, { validTo: { gt: validFrom } }] }, data: { validTo: validFrom } });
      await tx.commissionRule.create({
        data: {
          ...same, model: r.model, rateBp: r.model === "PERCENT" ? r.rateBp : null, fixedMinor: r.model === "FIXED_PER_TRIP" ? BigInt(r.fixedMinor ?? 0) : null,
          minMinor: r.minMinor === null ? null : BigInt(r.minMinor), maxMinor: r.maxMinor === null ? null : BigInt(r.maxMinor),
          validFrom, proposedBy: c.makerId, approvedBy: checkerId,
        },
      });
    } else {
      const p = c.payload as unknown as BalancePolicyPayload;
      const validFrom = from(p);
      try {
        await tx.balancePolicy.create({
          data: {
            cityId: c.cityId, validFrom, mode: p.mode, warningMinor: BigInt(p.warningMinor), cashLimitMinor: BigInt(p.cashLimitMinor),
            hardLimitMinor: BigInt(p.hardLimitMinor), prepaidMinimumMinor: BigInt(p.prepaidMinimumMinor), dueDays: p.dueDays,
            minPaymentBp: p.minPaymentBp, minPayoutMinor: BigInt(p.minPayoutMinor), taxBasis: p.taxBasis, vatRateBp: p.vatRateBp,
            proposedBy: c.makerId, approvedBy: checkerId,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw conflict("a policy already starts at that time", "policy_scheduled");
        throw err;
      }
    }
  }

  /** Limits may have moved: recompute every balance state in the city (publishes the changes). */
  async function recomputeCity(cityId: string) {
    const all = await db.beneficiary.findMany({ where: { cityId }, select: { accountId: true } });
    for (const b of all) await db.$transaction((tx) => afterPosting(tx, b.accountId, { creditMinor: 0, now: now() }));
    return all.length;
  }

  return {
    recomputeCity,

    /** What's in force per city, the history, and what's waiting. */
    async overview(p: Principal, cityId: string) {
      const allowed = (["commission_rule:propose", "commission_rule:approve", "balance_policy:propose", "balance_policy:approve", "balance:read", "commission:read"] as const)
        .some((perm) => can(p, perm, { cityId }));
      if (!allowed) authorize(p, "commission:read", { cityId });
      const at = now();
      const [rules, policies, changes, policy] = await Promise.all([
        db.commissionRule.findMany({ where: { cityId }, orderBy: [{ validFrom: "desc" }], take: 50 }),
        db.balancePolicy.findMany({ where: { cityId }, orderBy: { validFrom: "desc" }, take: 20 }),
        db.ruleChange.findMany({ where: { cityId }, orderBy: { createdAt: "desc" }, take: 30 }),
        db.$transaction((tx) => policyAt(tx, cityId, at)),
      ]);
      const inForce = (r: { validFrom: Date; validTo: Date | null }) => r.validFrom <= at && (!r.validTo || r.validTo > at);
      return {
        cityId,
        defaults: { rule: DEFAULT_RULE, policy: DEFAULT_POLICY },
        policy: { ...policy, builtIn: policy.validFrom === null },
        rules: rules.map((r) => ({
          ...ruleFromRow(r), cityId: r.cityId, vehicleType: r.vehicleType, beneficiaryId: r.beneficiaryId, validFrom: r.validFrom, validTo: r.validTo,
          proposedBy: r.proposedBy, approvedBy: r.approvedBy, inForce: inForce(r),
        })),
        policies: policies.map((x) => ({ ...policyFromRow(x), validFrom: x.validFrom, proposedBy: x.proposedBy, approvedBy: x.approvedBy })),
        changes: changes.map(changeView),
      };
    },

    async pending(p: Principal) {
      const cities = new Set<string>();
      let everywhere = false;
      for (const perm of ["commission_rule:propose", "commission_rule:approve", "balance_policy:propose", "balance_policy:approve"] as const) {
        const c = citiesWith(p, perm);
        if (c === "*") everywhere = true;
        else c.forEach((x) => cities.add(x));
      }
      if (!everywhere && cities.size === 0) return [];
      const rows = await db.ruleChange.findMany({ where: { status: "PENDING", ...(everywhere ? {} : { cityId: { in: [...cities] } }) }, orderBy: { createdAt: "asc" } });
      return rows.map(changeView);
    },

    async propose(p: Principal, input: { kind: "COMMISSION_RULE" | "BALANCE_POLICY"; cityId: string; payload: CommissionRulePayload | BalancePolicyPayload; reason: string }) {
      authorize(p, PERMS[input.kind].propose, { cityId: input.cityId });
      const problem = input.kind === "COMMISSION_RULE" ? validateRule(input.payload as CommissionRulePayload) : validatePolicy(input.payload as BalancePolicyPayload);
      if (problem) throw badRequest(problem, "invalid_rule");
      return db.$transaction(async (tx) => {
        const c = await tx.ruleChange.create({
          data: {
            kind: input.kind, cityId: input.cityId, payload: input.payload as unknown as Prisma.InputJsonValue, reason: input.reason,
            makerId: p.userId, expiresAt: new Date(now().getTime() + 7 * 86_400_000),
          },
        });
        await writeOutbox(tx, audit({ actorId: p.userId, action: PERMS[input.kind].propose, resource: { type: "rule_change", id: c.id }, outcome: "EXECUTED", reason: input.reason }));
        return changeView(c);
      });
    },

    async decide(p: Principal, id: string, decision: "approve" | "reject" | "cancel", reason?: string) {
      const c = await db.ruleChange.findUnique({ where: { id } });
      if (!c) throw notFound("change");
      if (c.status !== "PENDING") throw conflict(`the change is ${c.status.toLowerCase()}`, "invalid_state");
      if (decision === "cancel") {
        if (c.makerId !== p.userId) throw forbidden("only the person who proposed it can withdraw it");
      } else {
        authorize(p, PERMS[c.kind as keyof typeof PERMS].approve, { cityId: c.cityId });
        if (c.makerId === p.userId) throw forbidden("someone else must approve your own proposal", "maker_checker");
        if (decision === "reject" && !reason) throw badRequest("say why", "reason_required");
      }
      if (c.expiresAt < now()) {
        await db.ruleChange.update({ where: { id }, data: { status: "EXPIRED" } });
        throw conflict("the proposal expired; propose it again", "expired");
      }
      const status = decision === "approve" ? "EXECUTED" : decision === "reject" ? "REJECTED" : "CANCELLED";
      await db.$transaction(async (tx) => {
        const { count } = await tx.ruleChange.updateMany({
          where: { id, status: "PENDING" },
          data: { status, decidedAt: now(), decisionReason: reason ?? null, ...(decision !== "cancel" ? { checkerId: p.userId } : {}) },
        });
        if (count === 0) throw conflict("the change was already decided", "invalid_state");
        if (decision === "approve") await execute(tx, c, p.userId);
        await writeOutbox(tx, audit({
          actorId: p.userId, action: decision === "approve" ? PERMS[c.kind as keyof typeof PERMS].approve : `rule_change:${decision}`,
          resource: { type: "rule_change", id }, outcome: "EXECUTED", ...(reason ? { reason } : {}),
        }));
      });
      if (decision === "approve" && c.kind === "BALANCE_POLICY") await recomputeCity(c.cityId);
      return changeView(await db.ruleChange.findUniqueOrThrow({ where: { id } }));
    },

    async expire() {
      const { count } = await db.ruleChange.updateMany({ where: { status: "PENDING", expiresAt: { lt: now() } }, data: { status: "EXPIRED" } });
      return count;
    },
  };
}

export type RuleChanges = ReturnType<typeof createRuleChanges>;
