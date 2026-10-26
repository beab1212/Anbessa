// payment-service HTTP API under /api/payments (one Kong route). Phone app (ride-app) and web
// (ride-admin) tokens are both accepted; permissions decide. Provider webhooks are public and
// signature-checked; the simulator's checkout page exists only outside production.

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { bearerToken, TokenError, type Principal, type VerifyAccessToken } from "@ride-app/shared-authz";
import type { Container } from "../container.js";
import { checkoutPage } from "../gateways/checkout-page.js";
import { withIdempotency } from "../lib/idempotency.js";
import { badRequest, notFound, unauthorized } from "../lib/errors.js";
import { assertFinanceView } from "../money/access.js";

const uuid = z.string().uuid();
const cityId = z.string().regex(/^[a-z0-9-]{1,40}$/);
const money = z.number().int().positive().max(100_000_000);
const reason = z.string().trim().min(5).max(500);

export type RouteDeps = Pick<Container,
  "db" | "gateways" | "payments" | "topUps" | "payouts" | "ruleChanges" | "balances" | "webhooks" | "settings" | "config" | "internalToken"
> & { verifyAccessToken: VerifyAccessToken };

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { payments, topUps, payouts, ruleChanges, balances, webhooks, gateways, db } = deps;

  async function principal(req: FastifyRequest): Promise<Principal> {
    const token = bearerToken(req.headers.authorization);
    if (!token) throw unauthorized();
    try {
      return await deps.verifyAccessToken(token, "ride-app");
    } catch (err) {
      if (!(err instanceof TokenError) || err.code !== "invalid_token") throw err;
      return deps.verifyAccessToken(token, "ride-admin");
    }
  }

  async function idempotent(req: FastifyRequest, reply: FastifyReply, p: Principal, status: number, work: () => Promise<unknown>) {
    const key = req.headers["idempotency-key"];
    const r = await withIdempotency(db, p.userId, typeof key === "string" ? key : undefined, { url: req.url, body: req.body }, async () => ({ statusCode: status, body: await work() }));
    return reply.status(r.statusCode).send(r.body);
  }

  // ── public ──────────────────────────────────────────────────────────────────
  // what the apps offer at checkout (methods per city, providers)
  app.get("/api/payments/methods", async (req, reply) => {
    const q = z.object({ cityId: cityId.optional() }).parse(req.query);
    return reply.header("cache-control", "public, max-age=30").send({
      methods: deps.settings.get<string[]>("payments.methods", q.cityId),
      providers: gateways.list().map((g) => ({ provider: g.provider, label: g.label, methods: g.methods, mode: g.mode })),
    });
  });

  // ── drivers and fleet owners: the balance ───────────────────────────────────
  app.get("/api/payments/balances/me", async (req) => {
    const p = await principal(req);
    const q = z.object({ cityId: cityId.default("addis-ababa"), open: z.coerce.boolean().default(false) }).parse(req.query);
    return balances.mine(p, q.cityId, q.open);
  });
  app.get("/api/payments/balances/org/:orgId", async (req) => {
    const p = await principal(req);
    const { orgId } = z.object({ orgId: uuid }).parse(req.params);
    const q = z.object({ cityId: cityId.default("addis-ababa"), open: z.coerce.boolean().default(false) }).parse(req.query);
    return balances.org(p, orgId, q.cityId, q.open);
  });
  app.get("/api/payments/balances/:accountId", async (req) => balances.get(await principal(req), z.object({ accountId: uuid }).parse(req.params).accountId));
  app.get("/api/payments/balances/:accountId/statement", async (req) => {
    const p = await principal(req);
    const q = z.object({ before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query);
    return balances.statement(p, z.object({ accountId: uuid }).parse(req.params).accountId, q);
  });
  app.get("/api/payments/balances/:accountId/top-ups", async (req) => ({
    topUps: await topUps.forAccount(await principal(req), z.object({ accountId: uuid }).parse(req.params).accountId),
  }));
  app.post("/api/payments/balances/:accountId/top-ups", async (req, reply) => {
    const p = await principal(req);
    const { accountId } = z.object({ accountId: uuid }).parse(req.params);
    const body = z.object({ amountMinor: money, provider: z.string().min(1).max(30) }).parse(req.body);
    return idempotent(req, reply, p, 201, () => topUps.create(p, accountId, body));
  });
  app.put("/api/payments/balances/:accountId/payout-method", async (req) => {
    const p = await principal(req);
    const { accountId } = z.object({ accountId: uuid }).parse(req.params);
    return balances.setPayoutMethod(p, accountId, z.object({ provider: z.string().min(1).max(30), destination: z.string().min(6).max(30) }).parse(req.body));
  });
  app.get("/api/payments/top-ups/:id", async (req) => topUps.get(await principal(req), z.object({ id: uuid }).parse(req.params).id));

  // ── riders ──────────────────────────────────────────────────────────────────
  app.get("/api/payments/trips/:tripId", async (req) => payments.forTrip(await principal(req), z.object({ tripId: uuid }).parse(req.params).tripId));
  app.post("/api/payments/payments/:id/pay", async (req, reply) => {
    const p = await principal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return idempotent(req, reply, p, 200, () => payments.payNow(p, id));
  });
  app.get("/api/payments/me/preferences", async (req) => {
    const p = await principal(req);
    return { mobileMoneyProvider: await payments.preference(p.userId) };
  });
  app.put("/api/payments/me/preferences", async (req) => {
    const p = await principal(req);
    return payments.setPreference(p, z.object({ mobileMoneyProvider: z.string().min(1).max(30) }).parse(req.body).mobileMoneyProvider);
  });

  // ── finance ─────────────────────────────────────────────────────────────────
  app.get("/api/payments/overview", async (req) => balances.overview(await principal(req)));
  app.get("/api/payments/ledger/integrity", async (req) => balances.integrity(await principal(req)));
  app.get("/api/payments/balances", async (req) => {
    const p = await principal(req);
    const q = z.object({
      state: z.enum(["OK", "WARNING", "CASH_BLOCKED", "BLOCKED"]).optional(), cityId: cityId.optional(),
      type: z.enum(["INDIVIDUAL", "ORGANIZATION"]).optional(), q: z.string().trim().max(60).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    return balances.list(p, q);
  });

  app.get("/api/payments/payments", async (req) => {
    const p = await principal(req);
    const q = z.object({
      status: z.string().max(30).optional(), provider: z.string().max(30).optional(), tripId: uuid.optional(),
      before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query);
    return payments.list(p, q);
  });
  app.get("/api/payments/payments/:id", async (req) => payments.get(await principal(req), z.object({ id: uuid }).parse(req.params).id));
  app.post("/api/payments/payments/:id/reconcile", async (req) => payments.reconcileOne(await principal(req), z.object({ id: uuid }).parse(req.params).id));
  app.post("/api/payments/payments/:id/refunds", async (req, reply) => {
    const p = await principal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ amountMinor: money, reason, driverAtFault: z.boolean().default(false) }).parse(req.body);
    return idempotent(req, reply, p, 201, () => payments.requestRefund(p, id, body));
  });
  app.get("/api/payments/refunds", async (req) => {
    const p = await principal(req);
    const { status } = z.object({ status: z.enum(["PENDING_APPROVAL", "PROCESSING", "SUCCEEDED", "FAILED", "REJECTED"]).optional() }).parse(req.query);
    return { refunds: await payments.refunds(p, status) };
  });
  app.post("/api/payments/refunds/:id/:decision", async (req) => {
    const p = await principal(req);
    const { id, decision } = z.object({ id: uuid, decision: z.enum(["approve", "reject"]) }).parse(req.params);
    const body = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    return payments.decideRefund(p, id, decision, body.reason);
  });

  // office cash and bank transfers (maker–checker)
  app.post("/api/payments/top-ups/manual", async (req, reply) => {
    const p = await principal(req);
    const body = z.object({
      accountId: uuid.optional(), referenceCode: z.string().trim().max(20).optional(),
      channel: z.enum(["OFFICE_CASH", "BANK_TRANSFER"]), amountMinor: money,
      receiptNo: z.string().trim().min(3).max(60), note: z.string().trim().max(300).optional(),
    }).refine((b) => !!b.accountId !== !!b.referenceCode, "give the account or its reference code").parse(req.body);
    return idempotent(req, reply, p, 201, () => topUps.record(p, body));
  });
  app.get("/api/payments/top-ups", async (req) => {
    const p = await principal(req);
    const q = z.object({ status: z.string().max(30).optional(), channel: z.string().max(30).optional() }).parse(req.query);
    return { topUps: await topUps.list(p, q) };
  });
  app.post("/api/payments/top-ups/:id/:decision", async (req) => {
    const p = await principal(req);
    const { id, decision } = z.object({ id: uuid, decision: z.enum(["approve", "reject"]) }).parse(req.params);
    return topUps.decide(p, id, decision, z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {}).reason);
  });

  // weekly settlement and payouts
  app.post("/api/payments/settlements/run", async (req, reply) => {
    const r = await payouts.run(await principal(req));
    return reply.status(r.created ? 201 : 200).send(r);
  });
  app.get("/api/payments/payouts", async (req) => ({ batches: await payouts.list(await principal(req)) }));
  app.get("/api/payments/payouts/:id", async (req) => payouts.get(await principal(req), z.object({ id: uuid }).parse(req.params).id));
  app.post("/api/payments/payouts/:id/:decision", async (req) => {
    const p = await principal(req);
    const { id, decision } = z.object({ id: uuid, decision: z.enum(["approve", "reject"]) }).parse(req.params);
    return payouts.decide(p, id, decision, z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {}).reason);
  });

  // commission rules and balance policies (maker–checker)
  app.get("/api/payments/rules", async (req) => {
    const p = await principal(req);
    return ruleChanges.overview(p, z.object({ cityId }).parse(req.query).cityId);
  });
  app.get("/api/payments/rules/pending", async (req) => ({ changes: await ruleChanges.pending(await principal(req)) }));
  const nullableMoney = z.number().int().min(0).max(100_000_000).nullable().default(null);
  const commissionRule = z.object({
    vehicleType: z.string().regex(/^[a-z0-9_]{1,30}$/).nullable().default(null), beneficiaryId: uuid.nullable().default(null),
    model: z.enum(["PERCENT", "FIXED_PER_TRIP", "ZERO"]), rateBp: z.number().int().min(0).max(10_000).nullable().default(null),
    fixedMinor: nullableMoney, minMinor: nullableMoney, maxMinor: nullableMoney, validFrom: z.string().datetime().nullable().default(null),
  });
  const balancePolicy = z.object({
    mode: z.enum(["POSTPAID", "PREPAID"]), warningMinor: z.number().int().max(0), cashLimitMinor: z.number().int().max(0),
    hardLimitMinor: z.number().int().max(0), prepaidMinimumMinor: z.number().int().min(0), dueDays: z.number().int().min(1).max(30),
    minPaymentBp: z.number().int().min(0).max(10_000), minPayoutMinor: z.number().int().min(0), taxBasis: z.enum(["COMMISSION", "FULL_FARE"]),
    vatRateBp: z.number().int().min(0).max(10_000), validFrom: z.string().datetime().nullable().default(null),
  });
  app.post("/api/payments/rules/changes", async (req, reply) => {
    const p = await principal(req);
    const body = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("COMMISSION_RULE"), cityId, payload: commissionRule, reason }),
      z.object({ kind: z.literal("BALANCE_POLICY"), cityId, payload: balancePolicy, reason }),
    ]).parse(req.body);
    return reply.status(202).send(await ruleChanges.propose(p, body));
  });
  app.post("/api/payments/rules/changes/:id/:decision", async (req) => {
    const p = await principal(req);
    const { id, decision } = z.object({ id: uuid, decision: z.enum(["approve", "reject", "cancel"]) }).parse(req.params);
    return ruleChanges.decide(p, id, decision, z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {}).reason);
  });

  // providers: what's connected and the latest callbacks
  app.get("/api/payments/gateways", async (req) => {
    const p = await principal(req);
    assertFinanceView(p);
    return {
      providers: gateways.list().map((g) => ({ provider: g.provider, label: g.label, methods: g.methods, mode: g.mode })),
      simulator: deps.config.GATEWAY_MODE === "simulated"
        ? { autoApproveSeconds: deps.config.SIM_AUTO_APPROVE_SECONDS, payoutSeconds: deps.config.SIM_PAYOUT_SECONDS, dropWebhooks: deps.config.SIM_DROP_WEBHOOKS }
        : null,
      webhooks: await webhooks.stats(),
      recent: await webhooks.recent(30),
    };
  });

  // ── provider webhooks (public; the body is verified byte for byte) ──────────
  await app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser("*", { parseAs: "string", bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));
    hooks.post("/api/payments/webhooks/:provider", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
      const { provider } = z.object({ provider: z.string().max(30) }).parse(req.params);
      const r = await webhooks.receive(provider, typeof req.body === "string" ? req.body : "", req.headers);
      return reply.status(r.status).send(r.body);
    });

    // the simulator's hosted checkout (form posts, no scripts)
    if (deps.config.GATEWAY_MODE === "simulated" && deps.config.NODE_ENV !== "production") {
      const sim = gateways.simulator;
      hooks.get("/api/payments/sim/checkout/:ref", async (req, reply) => {
        const { ref } = z.object({ ref: z.string().max(60) }).parse(req.params);
        const op = await sim.store.get(ref);
        if (!op || op.kind !== "charge") throw notFound("checkout");
        return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(checkoutPage(op, `/api/payments/sim/checkout/${ref}`));
      });
      hooks.post("/api/payments/sim/checkout/:ref", async (req, reply) => {
        const { ref } = z.object({ ref: z.string().max(60) }).parse(req.params);
        const form = new URLSearchParams(typeof req.body === "string" ? req.body : "");
        const decision = form.get("decision");
        if (decision !== "approve" && decision !== "decline" && decision !== "insufficient") throw badRequest("choose approve or decline");
        const op = await sim.decide(ref, decision === "approve" ? "SUCCEEDED" : "FAILED", decision === "insufficient" ? "insufficient funds" : "declined by the payer");
        if (!op) throw notFound("checkout");
        return reply.redirect(`/api/payments/sim/checkout/${ref}`, 303);
      });
    }
  });

  // ── internal ────────────────────────────────────────────────────────────────
  await app.register(async (internal) => {
    const expected = Buffer.from(deps.internalToken);
    internal.addHook("onRequest", async (req) => {
      const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /i, ""));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized("invalid service credentials");
    });
    // fleet-service, when a driver goes online (Payment.md §14)
    internal.get("/internal/balances/state", { config: { rateLimit: false } }, async (req) => {
      const q = z.object({ type: z.enum(["INDIVIDUAL", "ORGANIZATION"]), ownerId: uuid }).parse(req.query);
      return balances.stateOf(q.type, q.ownerId);
    });
    // system page (platform-service)
    internal.get("/internal/ops/outbox", async () => {
      const [row] = await db.$queryRaw<{ pending: bigint; oldest: Date | null }[]>`
        SELECT count(*) AS pending, min(created_at) AS oldest FROM outbox WHERE published_at IS NULL`;
      return { pending: Number(row?.pending ?? 0), oldestAt: row?.oldest?.toISOString() ?? null };
    });
    internal.get("/internal/ops/integrations", async () => {
      const [stats, open] = await Promise.all([
        webhooks.stats(),
        db.payment.groupBy({ by: ["provider", "status"], where: { status: { in: ["ACTION_REQUIRED", "RETRY_SCHEDULED", "PENDING"] } }, _count: true }),
      ]);
      return {
        mode: deps.config.GATEWAY_MODE,
        providers: gateways.list().map((g) => ({
          provider: g.provider, label: g.label, methods: g.methods,
          openCharges: open.filter((o) => o.provider === g.provider).reduce((n, o) => n + o._count, 0),
          callbacks24h: stats.last24h.filter((s) => s.provider === g.provider && s.signatureOk).reduce((n, s) => n + s.count, 0),
          rejected24h: stats.last24h.filter((s) => s.provider === g.provider && !s.signatureOk).reduce((n, s) => n + s.count, 0),
        })),
        unprocessedCallbacks: stats.unprocessed,
      };
    });
  });
}
