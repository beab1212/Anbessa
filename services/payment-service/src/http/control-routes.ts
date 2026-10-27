// Money controls under /api/payments (Payment.md §15–§16, workflows 09, 11, 13, 15): balance
// adjustments, write-offs, policy overrides, driver incentives (maker–checker each) and corporate
// invoices. Registered by routes.ts with its principal() and idempotent() helpers.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Principal } from "@ride-app/shared-authz";
import type { Container } from "../container.js";
import { ADJUSTMENT_CATEGORIES } from "../money/controls.js";

export type ControlDeps = Pick<Container, "adjustments" | "writeOffs" | "policyOverrides" | "incentives" | "invoices">;

interface Helpers {
  principal(req: FastifyRequest): Promise<Principal>;
  idempotent(req: FastifyRequest, reply: FastifyReply, p: Principal, status: number, work: () => Promise<unknown>): Promise<unknown>;
}

const uuid = z.string().uuid();
const cityId = z.string().regex(/^[a-z0-9-]{1,40}$/);
const money = z.number().int().positive().max(100_000_000);
const reason = z.string().trim().min(5).max(500);
const decisionBody = z.object({ reason: z.string().trim().max(500).optional() });
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "period is YYYY-MM");
const limitMinor = z.number().int().min(-100_000_000).max(0).nullable().default(null);
const referenceCode = z.string().trim().min(5).max(20);
/** a request names the balance by account id or by its reference code (ANB-…), not both */
const oneBalance = (b: { accountId?: string | undefined; referenceCode?: string | undefined }) => !!b.accountId !== !!b.referenceCode;
const flag = z.enum(["true", "false", "1", "0"]).optional().transform((v) => v === "true" || v === "1");

export async function registerControlRoutes(app: FastifyInstance, deps: ControlDeps, h: Helpers) {
  const { adjustments, writeOffs, policyOverrides, incentives, invoices } = deps;
  const listQuery = z.object({ status: z.string().max(30).optional(), accountId: uuid.optional(), cityId: cityId.optional() });

  // ── everything waiting for a second person (the money approvals inbox) ─────
  app.get("/api/payments/approvals/pending", async (req) => {
    const p = await h.principal(req);
    const [a, w, o, i] = await Promise.all([adjustments.pending(p), writeOffs.pending(p), policyOverrides.pending(p), incentives.pending(p)]);
    return { adjustments: a, writeOffs: w, overrides: o, incentives: i };
  });

  // ── balance adjustments ─────────────────────────────────────────────────────
  app.post("/api/payments/adjustments", async (req, reply) => {
    const p = await h.principal(req);
    const body = z.object({
      accountId: uuid.optional(), referenceCode: referenceCode.optional(), direction: z.enum(["CREDIT", "DEBIT"]), amountMinor: money,
      category: z.enum(ADJUSTMENT_CATEGORIES), reason, ticketId: z.string().trim().min(1).max(60).optional(), tripId: uuid.optional(),
    }).refine(oneBalance, "give the account or its reference code").parse(req.body);
    return h.idempotent(req, reply, p, 201, () => adjustments.request(p, body));
  });
  app.get("/api/payments/adjustments", async (req) => ({ adjustments: await adjustments.list(await h.principal(req), listQuery.parse(req.query)) }));
  app.get("/api/payments/adjustments/:id", async (req) => adjustments.get(await h.principal(req), z.object({ id: uuid }).parse(req.params).id));
  app.post("/api/payments/adjustments/:id/:decision", async (req) => {
    const p = await h.principal(req);
    const { id, decision } = z.object({ id: uuid, decision: z.enum(["approve", "reject", "cancel"]) }).parse(req.params);
    return adjustments.decide(p, id, decision, decisionBody.parse(req.body ?? {}).reason);
  });

  // ── write-offs ──────────────────────────────────────────────────────────────
  app.get("/api/payments/write-offs/candidates", async (req) => {
    const p = await h.principal(req);
    const q = z.object({ cityId: cityId.optional() }).parse(req.query);
    return { afterDays: writeOffs.afterDays, candidates: await writeOffs.candidates(p, q) };
  });
  app.post("/api/payments/write-offs", async (req, reply) => {
    const p = await h.principal(req);
    const body = z.object({ accountId: uuid.optional(), referenceCode: referenceCode.optional(), reason }).refine(oneBalance, "give the account or its reference code").parse(req.body);
    return h.idempotent(req, reply, p, 201, () => writeOffs.request(p, body));
  });
  app.get("/api/payments/write-offs", async (req) => ({ writeOffs: await writeOffs.list(await h.principal(req), listQuery.parse(req.query)) }));
  app.get("/api/payments/write-offs/:id", async (req) => writeOffs.get(await h.principal(req), z.object({ id: uuid }).parse(req.params).id));
  app.post("/api/payments/write-offs/:id/:decision", async (req) => {
    const p = await h.principal(req);
    const { id, decision } = z.object({ id: uuid, decision: z.enum(["approve", "reject", "cancel"]) }).parse(req.params);
    return writeOffs.decide(p, id, decision, decisionBody.parse(req.body ?? {}).reason);
  });

  // ── policy overrides ────────────────────────────────────────────────────────
  app.post("/api/payments/policy-overrides", async (req, reply) => {
    const p = await h.principal(req);
    const body = z.object({
      accountId: uuid.optional(), referenceCode: referenceCode.optional(), mode: z.enum(["POSTPAID", "PREPAID"]).nullable().default(null),
      warningMinor: limitMinor, cashLimitMinor: limitMinor, hardLimitMinor: limitMinor,
      prepaidMinimumMinor: z.number().int().min(0).max(100_000_000).nullable().default(null),
      validFrom: z.string().datetime().nullable().default(null), validUntil: z.string().datetime(), reason,
    }).refine(oneBalance, "give the account or its reference code").parse(req.body);
    return h.idempotent(req, reply, p, 201, () => policyOverrides.request(p, {
      ...body, validFrom: body.validFrom ? new Date(body.validFrom) : null, validUntil: new Date(body.validUntil),
    }));
  });
  app.get("/api/payments/policy-overrides", async (req) => ({ overrides: await policyOverrides.list(await h.principal(req), listQuery.parse(req.query)) }));
  app.get("/api/payments/policy-overrides/:id", async (req) => policyOverrides.get(await h.principal(req), z.object({ id: uuid }).parse(req.params).id));
  app.post("/api/payments/policy-overrides/:id/:decision", async (req) => {
    const p = await h.principal(req);
    const { id, decision } = z.object({ id: uuid, decision: z.enum(["approve", "reject", "cancel", "revoke"]) }).parse(req.params);
    if (decision === "revoke") return policyOverrides.revoke(p, id, z.object({ reason }).parse(req.body ?? {}).reason);
    return policyOverrides.decide(p, id, decision, decisionBody.parse(req.body ?? {}).reason);
  });

  // ── driver incentives ───────────────────────────────────────────────────────
  app.get("/api/payments/incentives/me", async (req) => {
    const p = await h.principal(req);
    const q = z.object({ cityId: cityId.default("addis-ababa") }).parse(req.query);
    return { incentives: await incentives.mine(p, q.cityId) };
  });
  app.post("/api/payments/incentives", async (req, reply) => {
    const p = await h.principal(req);
    const body = z.object({
      cityId, name: z.string().trim().min(3).max(80), vehicleType: z.string().regex(/^[a-z0-9_]{1,30}$/).nullable().default(null),
      targetTrips: z.number().int().min(1).max(1000), rewardMinor: money, budgetMinor: money,
      startsAt: z.string().datetime(), endsAt: z.string().datetime(), reason,
    }).parse(req.body);
    return h.idempotent(req, reply, p, 201, () => incentives.propose(p, { ...body, startsAt: new Date(body.startsAt), endsAt: new Date(body.endsAt) }));
  });
  app.get("/api/payments/incentives", async (req) => {
    const p = await h.principal(req);
    return { incentives: await incentives.list(p, z.object({ status: z.string().max(30).optional(), cityId: cityId.optional() }).parse(req.query)) };
  });
  app.get("/api/payments/incentives/:id", async (req) => incentives.get(await h.principal(req), z.object({ id: uuid }).parse(req.params).id));
  app.post("/api/payments/incentives/:id/:decision", async (req) => {
    const p = await h.principal(req);
    const { id, decision } = z.object({ id: uuid, decision: z.enum(["approve", "reject", "cancel"]) }).parse(req.params);
    return incentives.decide(p, id, decision, decisionBody.parse(req.body ?? {}).reason);
  });

  // ── corporate invoices: finance ─────────────────────────────────────────────
  const csvReply = (reply: FastifyReply, name: string, text: string) =>
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${name}.csv"`).header("cache-control", "no-store").send(text);

  app.get("/api/payments/invoices/uninvoiced", async (req) => {
    const p = await h.principal(req);
    return invoices.uninvoiced(p, z.object({ period }).parse(req.query).period);
  });
  app.post("/api/payments/invoices", async (req, reply) => {
    const p = await h.principal(req);
    const body = z.object({ orgId: uuid, period }).parse(req.body);
    return h.idempotent(req, reply, p, 201, () => invoices.issue(p, body));
  });
  app.get("/api/payments/invoices", async (req) => {
    const p = await h.principal(req);
    const q = z.object({ status: z.enum(["ISSUED", "PAID"]).optional(), orgId: uuid.optional(), period: period.optional(), overdue: flag }).parse(req.query);
    return { invoices: await invoices.list(p, q) };
  });
  app.get("/api/payments/invoices/:id", async (req) => invoices.get(await h.principal(req), z.object({ id: uuid }).parse(req.params).id));
  app.get("/api/payments/invoices/:id/csv", async (req, reply) => {
    const d = await invoices.get(await h.principal(req), z.object({ id: uuid }).parse(req.params).id);
    return csvReply(reply, d.number, invoices.csv(d, d.lines));
  });
  app.post("/api/payments/invoices/:id/payments", async (req, reply) => {
    const p = await h.principal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ amountMinor: money, bankReference: z.string().trim().min(3).max(60).regex(/^[A-Za-z0-9/_.-]+$/) }).parse(req.body);
    return h.idempotent(req, reply, p, 201, () => invoices.recordPayment(p, id, body));
  });

  // ── corporate invoices: the company's own (corporate:read_invoices @ ORG) ────
  app.get("/api/payments/org/:orgId/invoices", async (req) => invoices.forOrg(await h.principal(req), z.object({ orgId: uuid }).parse(req.params).orgId));
  app.get("/api/payments/org/:orgId/invoices/:id", async (req) => {
    const { orgId, id } = z.object({ orgId: uuid, id: uuid }).parse(req.params);
    return invoices.getForOrg(await h.principal(req), orgId, id);
  });
  app.get("/api/payments/org/:orgId/invoices/:id/csv", async (req, reply) => {
    const { orgId, id } = z.object({ orgId: uuid, id: uuid }).parse(req.params);
    const d = await invoices.getForOrg(await h.principal(req), orgId, id);
    return csvReply(reply, d.number, invoices.csv(d, d.lines));
  });
}
