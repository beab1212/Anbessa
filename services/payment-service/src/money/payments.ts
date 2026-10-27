// Rider payments (workflow 08): trip fares and cancellation fees paid by mobile money or card.
//
//   trip.completed (digital) → payment PENDING (committed first) → charge at the provider →
//   ACTION_REQUIRED (the rider approves on their phone or the checkout page) → provider callback →
//   SUCCEEDED → settlement journal (beneficiary credited).
//
// A declined charge is tried again (RETRY_SCHEDULED, PAYMENT_RETRY_SECONDS); after the last try the
// trip is settled through a rider receivable (the driver is still paid, Payment.md Q6), and a later
// payment by the rider collects it. Refunds need a second person (refund:request → refund:approve).

import { authorize, citiesWith, type Principal } from "@ride-app/shared-authz";
import type { Beneficiary, PaymentMethod, TripCancelledEvent, TripCompletedEvent } from "@ride-app/shared-types";
import type { SettingsReader } from "@ride-app/shared-settings";
import type { Logger } from "@ride-app/shared-utils";
import { Prisma, type Payment, type Refund } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import { makeReference, parseReference, type Gateways, type ProviderNotice } from "../gateways/index.js";
import { AppError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import type { Realtime } from "../lib/realtime.js";
import { accounts, post } from "../ledger/ledger.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import { canSeePayment } from "./access.js";
import { afterPosting } from "./balances.js";
import { collectReceivable, settleCancellationFee, settleTripFare, type Source } from "./settlement.js";

type Tx = Prisma.TransactionClient;
type Purpose = "TRIP_FARE" | "CANCELLATION_FEE";

/** What settlement needs, kept on the payment until the money arrives. */
interface SettlementFacts {
  driverId: string | null;
  beneficiary: Beneficiary | null;
  vehicleType: string | null;
  paymentMethod: PaymentMethod;
  completedAt: string | null;
  compensationMinor: number;
  /** trip fares with a promo: the full fare (the payment is for fare − discount); absent on older payments */
  fareMinor?: number;
  promoDiscountMinor?: number;
}

export interface PaymentsDeps {
  db: Db;
  gateways: Gateways;
  settings: SettingsReader;
  realtime: Realtime;
  logger: Logger;
  /** the provider callback URL for a provider */
  notifyUrl: (provider: string) => string;
  /** seconds to wait before each retry of a declined charge; its length is the number of retries */
  retryDelaysSeconds: number[];
  now?: () => Date;
}

const DIGITAL: readonly string[] = ["MOBILE_MONEY", "CARD"];

export function paymentView(pay: Payment & { refunds?: Refund[] }) {
  return {
    id: pay.id, purpose: pay.purpose, tripId: pay.tripId, riderId: pay.riderId, cityId: pay.cityId,
    method: pay.method, provider: pay.provider, amountMinor: Number(pay.amountMinor), currency: pay.currency, status: pay.status,
    checkoutUrl: pay.status === "ACTION_REQUIRED" ? pay.checkoutUrl : null,
    attempts: pay.attempts, nextAttemptAt: pay.nextAttemptAt, lastError: pay.lastError,
    refundedMinor: Number(pay.refundedMinor), settledAsReceivable: pay.settledAsReceivable,
    createdAt: pay.createdAt, updatedAt: pay.updatedAt, completedAt: pay.completedAt,
    ...(pay.refunds ? { refunds: pay.refunds.map(refundView) } : {}),
  };
}

export function refundView(r: Refund) {
  return {
    id: r.id, paymentId: r.paymentId, amountMinor: Number(r.amountMinor), reason: r.reason, driverAtFault: r.driverAtFault, status: r.status,
    requestedBy: r.requestedBy, approvedBy: r.approvedBy, decisionReason: r.decisionReason, failure: r.failure,
    createdAt: r.createdAt, decidedAt: r.decidedAt, completedAt: r.completedAt,
  };
}

/** Staff see payments in the cities where they handle money, or everywhere. */
export function cityFilter(p: Principal): { cityId?: { in: string[] } } {
  const cities = new Set<string>();
  for (const perm of ["balance:read", "report:read_finance", "refund:approve", "refund:request"] as const) {
    const c = citiesWith(p, perm);
    if (c === "*") return {};
    c.forEach((x) => cities.add(x));
  }
  if (cities.size === 0) throw forbidden("missing permission balance:read");
  return { cityId: { in: [...cities] } };
}

export function createPayments(deps: PaymentsDeps) {
  const { db, gateways, settings, logger } = deps;
  const now = deps.now ?? (() => new Date());

  /** The provider that asks the rider to pay: their preference, else the first enabled one. */
  async function providerFor(method: "MOBILE_MONEY" | "CARD", riderId: string): Promise<string | null> {
    const enabled = gateways.list().filter((g) => g.methods.includes(method)).map((g) => g.provider as string);
    if (method === "MOBILE_MONEY") {
      const pref = await db.payerPreference.findUnique({ where: { userId: riderId } });
      if (pref && enabled.includes(pref.mobileMoneyProvider)) return pref.mobileMoneyProvider;
      const order = settings.get<string[]>("payments.mobileMoneyProviders");
      return order.find((p) => enabled.includes(p)) ?? enabled[0] ?? null;
    }
    const card = settings.get<string>("payments.cardProvider");
    return enabled.includes(card) ? card : (enabled[0] ?? null);
  }

  async function createPayment(tx: Tx, input: { purpose: Purpose; tripId: string; riderId: string; cityId: string; method: "MOBILE_MONEY" | "CARD"; amountMinor: number; currency: string; facts: SettlementFacts }) {
    const provider = await providerFor(input.method, input.riderId);
    return tx.payment.create({
      data: {
        purpose: input.purpose, tripId: input.tripId, riderId: input.riderId, cityId: input.cityId, method: input.method,
        provider: provider ?? "none", amountMinor: BigInt(input.amountMinor), currency: input.currency,
        settlement: input.facts as unknown as Prisma.InputJsonValue,
        ...(provider ? {} : { status: "RETRY_SCHEDULED", lastError: "no payment provider is enabled for this method", nextAttemptAt: now() }),
      },
    });
  }

  /** Settle a payment's trip or fee from a source (provider, or receivable after the last retry). */
  async function settle(tx: Tx, pay: Payment, source: Source) {
    const f = pay.settlement as unknown as SettlementFacts;
    if (pay.purpose === "TRIP_FARE") {
      return settleTripFare(tx, {
        tripId: pay.tripId, riderId: pay.riderId, driverId: f.driverId!, beneficiary: f.beneficiary!, cityId: pay.cityId,
        vehicleType: f.vehicleType ?? "economy", paymentMethod: f.paymentMethod,
        // the payment is what the rider owed (fare − promo discount); the driver earns on the full fare
        fareMinor: f.fareMinor ?? Number(pay.amountMinor), promoDiscountMinor: f.promoDiscountMinor ?? 0, currency: pay.currency,
        at: f.completedAt ? new Date(f.completedAt) : pay.createdAt, source,
      }, now());
    }
    return settleCancellationFee(tx, {
      tripId: pay.tripId, riderId: pay.riderId, driverId: f.driverId, beneficiary: f.beneficiary, cityId: pay.cityId,
      paymentMethod: f.paymentMethod, feeMinor: Number(pay.amountMinor), compensationMinor: f.compensationMinor, currency: pay.currency, source,
    }, now());
  }

  /** Inbox dedupe, in the same transaction as what the event does. */
  async function once(tx: Tx, eventId: string, topic: string) {
    const r = await tx.$executeRaw`INSERT INTO inbox (event_id, topic) VALUES (${eventId}, ${topic}) ON CONFLICT DO NOTHING`;
    return r === 1;
  }

  async function startCharge(paymentId: string): Promise<void> {
    const pay = await db.payment.findUnique({ where: { id: paymentId } });
    if (!pay || !(pay.status === "RETRY_SCHEDULED" || (pay.status === "PENDING" && !pay.providerRef))) return;
    if (pay.provider === "none") {
      const provider = await providerFor(pay.method as "MOBILE_MONEY" | "CARD", pay.riderId);
      if (!provider) return failed(pay, "no payment provider is enabled for this method", true);
      await db.payment.update({ where: { id: pay.id }, data: { provider } });
      pay.provider = provider;
    }
    // claim the attempt: two workers can't start the same one
    const attempt = pay.attempts + 1;
    const claimed = await db.payment.updateMany({
      where: { id: pay.id, attempts: pay.attempts, status: { in: ["PENDING", "RETRY_SCHEDULED"] } },
      data: { attempts: attempt, status: "PENDING", nextAttemptAt: null },
    });
    if (claimed.count === 0) return;

    const reference = makeReference("payment", pay.id, attempt);
    let started;
    try {
      started = await gateways.get(pay.provider).charge({
        reference, amountMinor: Number(pay.amountMinor), currency: "ETB",
        description: pay.purpose === "TRIP_FARE" ? "Anbessa trip" : "Anbessa cancellation fee",
        notifyUrl: deps.notifyUrl(pay.provider),
      });
    } catch (err) {
      // the provider is unreachable: this try doesn't count
      logger.warn({ err: (err as Error).message, paymentId: pay.id, provider: pay.provider }, "charge could not start; trying again soon");
      await db.payment.update({ where: { id: pay.id }, data: { attempts: pay.attempts, status: "RETRY_SCHEDULED", nextAttemptAt: new Date(now().getTime() + 30_000), lastError: "the provider is unreachable" } });
      return;
    }
    const updated = await db.$transaction(async (tx) => {
      const { count } = await tx.payment.updateMany({
        where: { id: pay.id, attempts: attempt, status: "PENDING" },
        data: { status: "ACTION_REQUIRED", providerRef: started.providerRef, checkoutUrl: started.checkoutUrl, lastError: null },
      });
      if (count === 0) return null; // the callback already arrived
      await writeOutbox(tx, {
        topic: "payment.action_required", key: pay.riderId,
        payload: {
          paymentId: pay.id, tripId: pay.tripId, riderId: pay.riderId, purpose: pay.purpose as Purpose, provider: pay.provider,
          amountMinor: Number(pay.amountMinor), currency: pay.currency, checkoutUrl: started.checkoutUrl,
        },
      });
      return tx.payment.findUniqueOrThrow({ where: { id: pay.id } });
    });
    if (updated) deps.realtime.toUser(pay.riderId, "payment:action_required", { payment: paymentView(updated), instructions: started.instructions });
  }

  /** A declined or failed charge: try again later, or settle through a receivable after the last try. */
  async function failed(pay: Payment, reason: string, final = false) {
    const retriesLeft = !final && pay.attempts <= deps.retryDelaysSeconds.length;
    const result = await db.$transaction(async (tx) => {
      const current = await tx.payment.findUniqueOrThrow({ where: { id: pay.id } });
      if (!["PENDING", "ACTION_REQUIRED", "RETRY_SCHEDULED"].includes(current.status)) return null;
      if (retriesLeft) {
        const nextAttemptAt = new Date(now().getTime() + deps.retryDelaysSeconds[Math.max(0, pay.attempts - 1)]! * 1000);
        const u = await tx.payment.update({ where: { id: pay.id }, data: { status: "RETRY_SCHEDULED", nextAttemptAt, lastError: reason } });
        await writeOutbox(tx, { topic: "payment.failed", key: pay.riderId, payload: { ...outcome(u), final: false, nextAttemptAt: nextAttemptAt.toISOString() } });
        return u;
      }
      const u = await tx.payment.update({ where: { id: pay.id }, data: { status: "FAILED", lastError: reason, completedAt: now(), settledAsReceivable: true } });
      await settle(tx, u, { type: "RIDER_RECEIVABLE" });
      await writeOutbox(tx, { topic: "payment.failed", key: pay.riderId, payload: { ...outcome(u), final: true } });
      return u;
    });
    if (result) deps.realtime.toUser(pay.riderId, "payment:failed", { payment: paymentView(result) });
  }

  const outcome = (p: Payment) => ({
    paymentId: p.id, tripId: p.tripId, riderId: p.riderId, purpose: p.purpose as Purpose, provider: p.provider,
    method: p.method as PaymentMethod, amountMinor: Number(p.amountMinor), currency: p.currency,
  });

  async function captured(pay: Payment, notice: ProviderNotice) {
    const result = await db.$transaction(async (tx) => {
      const current = await tx.payment.findUniqueOrThrow({ where: { id: pay.id } });
      if (current.status === "SUCCEEDED" || current.status === "REFUNDED" || current.status === "PARTIALLY_REFUNDED") {
        return current.providerTxnId === notice.providerTxnId ? "duplicate" : "second_capture";
      }
      const u = await tx.payment.update({
        where: { id: pay.id },
        data: { status: "SUCCEEDED", providerTxnId: notice.providerTxnId, providerRef: notice.providerRef ?? current.providerRef, completedAt: now(), lastError: null, nextAttemptAt: null },
      });
      if (current.settledAsReceivable) await collectReceivable(tx, { paymentId: u.id, riderId: u.riderId, provider: u.provider, amountMinor: Number(u.amountMinor) });
      else await settle(tx, u, { type: "PROVIDER", provider: u.provider });
      await writeOutbox(tx, { topic: "payment.captured", key: u.riderId, payload: outcome(u) });
      return u;
    });
    if (typeof result === "string") {
      // the rider paid twice (an old prompt approved late): finance refunds it from the payments page
      if (result === "second_capture") logger.error({ paymentId: pay.id, txn: notice.providerTxnId }, "a second capture arrived for a paid payment; refund it");
      return result;
    }
    deps.realtime.toUser(pay.riderId, "payment:captured", { payment: paymentView(result) });
    return "captured";
  }

  async function refundDone(r: Refund, notice: { providerRef: string | null; status: "SUCCEEDED" | "FAILED"; failure?: string }) {
    return db.$transaction(async (tx) => {
      const current = await tx.refund.findUniqueOrThrow({ where: { id: r.id }, include: { payment: true } });
      if (current.status !== "PROCESSING") return "duplicate";
      const pay = current.payment;
      if (notice.status === "FAILED") {
        await tx.refund.update({ where: { id: r.id }, data: { status: "FAILED", failure: notice.failure ?? "refused by the provider", completedAt: now() } });
        await writeOutbox(tx, { topic: "refund.failed", key: pay.riderId, payload: { refundId: r.id, paymentId: pay.id, tripId: pay.tripId, riderId: pay.riderId, amountMinor: Number(r.amountMinor), currency: pay.currency } });
        return "refund_failed";
      }
      const settlement = await tx.tripSettlement.findUnique({ where: { tripId_purpose: { tripId: pay.tripId, purpose: pay.purpose } } });
      const beneficiaryAccountId = r.driverAtFault ? settlement?.beneficiaryAccountId : null;
      const amount = Number(r.amountMinor);
      const posted = await post(tx, {
        kind: "REFUND", referenceType: "refund", referenceId: r.id, idempotencyKey: `refund:${r.id}`, createdBy: r.approvedBy,
        memo: r.driverAtFault ? "refund, charged to the driver's balance" : "refund, platform goodwill",
        lines: [
          { account: accounts.clearing(pay.provider), amountMinor: amount },
          beneficiaryAccountId ? { account: { id: beneficiaryAccountId }, amountMinor: -amount } : { account: accounts.goodwill(), amountMinor: -amount },
        ],
      });
      const refunded = pay.refundedMinor + r.amountMinor;
      await tx.payment.update({ where: { id: pay.id }, data: { refundedMinor: refunded, status: refunded >= pay.amountMinor ? "REFUNDED" : "PARTIALLY_REFUNDED" } });
      await tx.refund.update({ where: { id: r.id }, data: { status: "SUCCEEDED", providerRef: notice.providerRef ?? current.providerRef, journalEntryId: posted.entryId, completedAt: now() } });
      if (beneficiaryAccountId) await afterPosting(tx, beneficiaryAccountId, { creditMinor: 0, now: now() });
      await writeOutbox(tx, { topic: "refund.succeeded", key: pay.riderId, payload: { refundId: r.id, paymentId: pay.id, tripId: pay.tripId, riderId: pay.riderId, amountMinor: amount, currency: pay.currency } });
      return "refunded";
    });
  }

  return {
    // ── Kafka (consumer) ──────────────────────────────────────────────────────
    /** Cash and corporate trips settle at once; digital ones start a charge. Returns the payment to charge. */
    async onTripCompleted(e: TripCompletedEvent): Promise<string | null> {
      const created = await db.$transaction(async (tx) => {
        if (!(await once(tx, e.eventId, "trip.completed"))) return null;
        // a promo discount: the rider pays fare − discount (never below 0); the driver earns on the full fare
        const discount = Math.min(Math.max(e.promoDiscountMinor ?? 0, 0), e.fareMinor);
        const payable = e.fareMinor - discount;
        const facts: SettlementFacts = {
          driverId: e.driverId, beneficiary: e.beneficiary, vehicleType: e.vehicleType, paymentMethod: e.paymentMethod,
          completedAt: e.completedAt, compensationMinor: 0, ...(discount > 0 ? { fareMinor: e.fareMinor, promoDiscountMinor: discount } : {}),
        };
        const digital = DIGITAL.includes(e.paymentMethod);
        if (digital && payable > 0) {
          const p = await createPayment(tx, {
            purpose: "TRIP_FARE", tripId: e.tripId, riderId: e.riderId, cityId: e.cityId, method: e.paymentMethod as "MOBILE_MONEY" | "CARD",
            amountMinor: payable, currency: e.currency, facts,
          });
          return p.id;
        }
        const source: Source = e.paymentMethod === "CORPORATE" && e.billingOrgId ? { type: "CORPORATE", orgId: e.billingOrgId }
          : digital && discount > 0 ? { type: "PROMO" } // nothing left to charge
          : { type: "CASH" };
        await settleTripFare(tx, {
          tripId: e.tripId, riderId: e.riderId, driverId: e.driverId, beneficiary: e.beneficiary, cityId: e.cityId, vehicleType: e.vehicleType,
          paymentMethod: e.paymentMethod, fareMinor: e.fareMinor, promoDiscountMinor: discount, currency: e.currency, at: new Date(e.completedAt), source,
        }, now());
        return null;
      });
      if (created) await startCharge(created);
      return created;
    },

    /** A fee: charged digitally, or a receivable for cash riders; the driver's compensation either way. */
    async onTripCancelled(e: TripCancelledEvent & { billingOrgId?: string }): Promise<string | null> {
      const created = await db.$transaction(async (tx) => {
        if (!(await once(tx, e.eventId, "trip.cancelled"))) return null;
        if (e.feeMinor <= 0) return null;
        const facts: SettlementFacts = {
          driverId: e.driverId ?? null, beneficiary: e.beneficiary ?? null, vehicleType: null, paymentMethod: e.paymentMethod,
          completedAt: null, compensationMinor: e.driverCompensationMinor,
        };
        if (DIGITAL.includes(e.paymentMethod)) {
          const p = await createPayment(tx, {
            purpose: "CANCELLATION_FEE", tripId: e.tripId, riderId: e.riderId, cityId: e.cityId, method: e.paymentMethod as "MOBILE_MONEY" | "CARD",
            amountMinor: e.feeMinor, currency: e.currency, facts,
          });
          return p.id;
        }
        const source: Source = e.paymentMethod === "CORPORATE" && e.billingOrgId ? { type: "CORPORATE", orgId: e.billingOrgId } : { type: "CASH" };
        await settleCancellationFee(tx, {
          tripId: e.tripId, riderId: e.riderId, driverId: e.driverId ?? null, beneficiary: e.beneficiary ?? null, cityId: e.cityId,
          paymentMethod: e.paymentMethod, feeMinor: e.feeMinor, compensationMinor: e.driverCompensationMinor, currency: e.currency, source,
        }, now());
        return null;
      });
      if (created) await startCharge(created);
      return created;
    },

    startCharge,

    // ── provider callbacks (webhooks.ts, reconciliation) ───────────────────────
    async applyCharge(notice: ProviderNotice): Promise<string> {
      const ref = parseReference(notice.reference);
      if (!ref || ref.kind !== "payment") return "unknown_reference";
      const pay = await db.payment.findUnique({ where: { id: ref.id } });
      if (!pay) return "unknown_payment";
      if (notice.amountMinor !== Number(pay.amountMinor)) {
        logger.error({ paymentId: pay.id, expected: Number(pay.amountMinor), got: notice.amountMinor }, "provider reported a different amount; not applied");
        return "amount_mismatch";
      }
      if (notice.status === "SUCCEEDED") return captured(pay, notice);
      if (notice.status === "FAILED") {
        // a failure of an older try doesn't matter once a newer one is running
        if (ref.attempt < pay.attempts) return "stale_attempt";
        await failed(pay, notice.failure ?? "declined");
        return "failed";
      }
      return "pending";
    },

    async applyRefund(notice: ProviderNotice): Promise<string> {
      const ref = parseReference(notice.reference);
      if (!ref || ref.kind !== "refund") return "unknown_reference";
      const r = await db.refund.findUnique({ where: { id: ref.id } });
      if (!r) return "unknown_refund";
      if (notice.status === "PENDING") return "pending";
      return refundDone(r, { providerRef: notice.providerRef, status: notice.status, ...(notice.failure ? { failure: notice.failure } : {}) });
    },

    // ── jobs ──────────────────────────────────────────────────────────────────
    /** Due retries, and charges whose start was interrupted (crash between commit and the provider call). */
    async chargeDue(): Promise<number> {
      const due = await db.payment.findMany({
        where: {
          OR: [
            { status: "RETRY_SCHEDULED", nextAttemptAt: { lte: now() } },
            { status: "PENDING", providerRef: null, createdAt: { lt: new Date(now().getTime() - 10_000) } },
          ],
        },
        take: 50, select: { id: true },
      });
      for (const p of due) await startCharge(p.id).catch((err) => logger.error({ err, paymentId: p.id }, "charge failed to start"));
      return due.length;
    },

    /** Ask the provider about charges that stayed open too long (a lost callback). */
    async reconcile(olderThanSeconds: number): Promise<number> {
      const open = await db.payment.findMany({
        where: { status: "ACTION_REQUIRED", updatedAt: { lt: new Date(now().getTime() - olderThanSeconds * 1000) } },
        take: 50,
      });
      let fixed = 0;
      for (const pay of open) {
        const notice = await gateways.get(pay.provider).query("charge", makeReference("payment", pay.id, pay.attempts)).catch(() => null);
        if (notice && notice.status !== "PENDING") {
          await this.applyCharge(notice);
          fixed++;
        }
      }
      const refunds = await db.refund.findMany({ where: { status: "PROCESSING", decidedAt: { lt: new Date(now().getTime() - olderThanSeconds * 1000) } }, include: { payment: true }, take: 50 });
      for (const r of refunds) {
        const notice = await gateways.get(r.payment.provider).query("refund", makeReference("refund", r.id)).catch(() => null);
        if (notice && notice.status !== "PENDING") {
          await this.applyRefund(notice);
          fixed++;
        }
      }
      return fixed;
    },

    // ── riders ────────────────────────────────────────────────────────────────
    async forTrip(p: Principal, tripId: string) {
      const rows = await db.payment.findMany({ where: { tripId }, include: { refunds: { orderBy: { createdAt: "desc" } } }, orderBy: { createdAt: "asc" } });
      const visible = rows.filter((r) => canSeePayment(p, r));
      const settlements = await db.tripSettlement.findMany({ where: { tripId } });
      const staff = p.audience === "ride-admin";
      return {
        payments: visible.map(paymentView),
        // commission and the driver's earnings are for staff and the driver side, not the rider
        settlements: settlements.filter((s) => staff || s.driverId === p.userId).map((s) => ({
          purpose: s.purpose, paymentMethod: s.paymentMethod, fareMinor: Number(s.fareMinor), commissionMinor: Number(s.commissionMinor),
          vatMinor: Number(s.vatMinor), earningsMinor: Number(s.earningsMinor), promoDiscountMinor: Number(s.promoDiscountMinor), commissionRuleId: s.commissionRuleId, settledAt: s.settledAt,
          beneficiaryAccountId: s.beneficiaryAccountId,
        })),
      };
    },

    /** The rider pays now instead of waiting for the next retry (also pays a receivable). */
    async payNow(p: Principal, paymentId: string) {
      const pay = await db.payment.findUnique({ where: { id: paymentId } });
      if (!pay || pay.riderId !== p.userId) throw notFound("payment");
      authorize(p, "payment:read", { ownerUserIds: [pay.riderId] });
      if (pay.status === "ACTION_REQUIRED") return paymentView(pay);
      if (pay.status === "FAILED") {
        await db.payment.updateMany({ where: { id: pay.id, status: "FAILED" }, data: { status: "RETRY_SCHEDULED", nextAttemptAt: now() } });
      } else if (pay.status !== "RETRY_SCHEDULED") {
        throw conflict(`the payment is ${pay.status.toLowerCase()}`, "invalid_state");
      }
      await startCharge(pay.id);
      return paymentView(await db.payment.findUniqueOrThrow({ where: { id: pay.id } }));
    },

    async setPreference(p: Principal, provider: string) {
      if (!gateways.has(provider) || !gateways.get(provider).methods.includes("MOBILE_MONEY")) throw badRequest("not an enabled mobile money provider", "unknown_provider");
      await db.payerPreference.upsert({ where: { userId: p.userId }, create: { userId: p.userId, mobileMoneyProvider: provider }, update: { mobileMoneyProvider: provider } });
      return { mobileMoneyProvider: provider };
    },

    async preference(userId: string) {
      return (await db.payerPreference.findUnique({ where: { userId } }))?.mobileMoneyProvider ?? null;
    },

    // ── finance ───────────────────────────────────────────────────────────────
    async list(p: Principal, q: { status?: string; provider?: string; tripId?: string; cityId?: string; before?: Date; limit: number }) {
      const allowed = cityFilter(p);
      // one city, if asked and allowed (a city outside the person's reach is refused, not emptied)
      if (q.cityId && allowed.cityId && !allowed.cityId.in.includes(q.cityId)) throw forbidden("missing permission balance:read");
      const where: Prisma.PaymentWhereInput = {
        ...(q.status ? { status: q.status } : {}), ...(q.provider ? { provider: q.provider } : {}), ...(q.tripId ? { tripId: q.tripId } : {}),
        ...(q.before ? { createdAt: { lt: q.before } } : {}),
        ...(q.cityId ? { cityId: q.cityId } : allowed),
      };
      const rows = await db.payment.findMany({ where, orderBy: { createdAt: "desc" }, take: q.limit });
      return { payments: rows.map(paymentView), next: rows.length === q.limit ? rows.at(-1)!.createdAt.toISOString() : null };
    },

    async get(p: Principal, id: string) {
      const pay = await db.payment.findUnique({ where: { id }, include: { refunds: { orderBy: { createdAt: "desc" } } } });
      if (!pay || !canSeePayment(p, pay)) throw notFound("payment");
      return paymentView(pay);
    },

    /** Ask the provider now (finance's "check with the provider"). */
    async reconcileOne(p: Principal, id: string) {
      authorize(p, "commission:collect");
      const pay = await db.payment.findUnique({ where: { id } });
      if (!pay) throw notFound("payment");
      if (pay.status === "ACTION_REQUIRED" || pay.status === "PENDING") {
        const notice = await gateways.get(pay.provider).query("charge", makeReference("payment", pay.id, Math.max(1, pay.attempts)));
        if (notice) await this.applyCharge(notice);
      }
      return paymentView(await db.payment.findUniqueOrThrow({ where: { id } }));
    },

    async requestRefund(p: Principal, paymentId: string, input: { amountMinor: number; reason: string; driverAtFault: boolean }) {
      const pay = await db.payment.findUnique({ where: { id: paymentId }, include: { refunds: true } });
      if (!pay) throw notFound("payment");
      authorize(p, "refund:request", { cityId: pay.cityId });
      if (!["SUCCEEDED", "PARTIALLY_REFUNDED"].includes(pay.status)) throw conflict("only a paid payment can be refunded", "invalid_state");
      const pending = pay.refunds.filter((r) => r.status === "PENDING_APPROVAL" || r.status === "PROCESSING").reduce((s, r) => s + Number(r.amountMinor), 0);
      const left = Number(pay.amountMinor - pay.refundedMinor) - pending;
      if (input.amountMinor > left) throw badRequest(`at most ${(left / 100).toFixed(2)} ETB can still be refunded`, "refund_too_large");
      return db.$transaction(async (tx) => {
        const r = await tx.refund.create({ data: { paymentId, amountMinor: BigInt(input.amountMinor), reason: input.reason, driverAtFault: input.driverAtFault, requestedBy: p.userId } });
        await writeOutbox(tx, audit({ actorId: p.userId, action: "refund:request", resource: { type: "payment", id: paymentId }, outcome: "EXECUTED", reason: input.reason }));
        return refundView(r);
      });
    },

    async refunds(p: Principal, status?: string) {
      const cities = cityFilter(p);
      const rows = await db.refund.findMany({
        where: { ...(status ? { status } : {}), ...(cities.cityId ? { payment: { cityId: cities.cityId } } : {}) },
        include: { payment: true }, orderBy: { createdAt: "desc" }, take: 100,
      });
      return rows.map((r) => ({ ...refundView(r), payment: paymentView(r.payment) }));
    },

    async decideRefund(p: Principal, refundId: string, decision: "approve" | "reject", reason?: string) {
      const r = await db.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
      if (!r) throw notFound("refund");
      authorize(p, "refund:approve", { cityId: r.payment.cityId });
      if (r.requestedBy === p.userId) throw forbidden("someone else must approve your own request", "maker_checker");
      if (decision === "reject") {
        if (!reason) throw badRequest("say why", "reason_required");
        const { count } = await db.refund.updateMany({ where: { id: r.id, status: "PENDING_APPROVAL" }, data: { status: "REJECTED", approvedBy: p.userId, decisionReason: reason, decidedAt: now() } });
        if (count === 0) throw conflict("the refund was already decided", "invalid_state");
        await db.$transaction((tx) => writeOutbox(tx, audit({ actorId: p.userId, action: "refund:reject", resource: { type: "refund", id: r.id }, outcome: "EXECUTED", reason })));
        return refundView(await db.refund.findUniqueOrThrow({ where: { id: r.id } }));
      }
      const { count } = await db.refund.updateMany({ where: { id: r.id, status: "PENDING_APPROVAL" }, data: { status: "PROCESSING", approvedBy: p.userId, decisionReason: reason ?? null, decidedAt: now() } });
      if (count === 0) throw conflict("the refund was already decided", "invalid_state");
      await db.$transaction((tx) => writeOutbox(tx, audit({ actorId: p.userId, action: "refund:approve", resource: { type: "refund", id: r.id }, outcome: "EXECUTED", ...(reason ? { reason } : {}) })));
      try {
        const res = await gateways.get(r.payment.provider).refund({
          reference: makeReference("refund", r.id), chargeReference: makeReference("payment", r.paymentId, Math.max(1, r.payment.attempts)),
          providerTxnId: r.payment.providerTxnId, amountMinor: Number(r.amountMinor), reason: r.reason, notifyUrl: deps.notifyUrl(r.payment.provider),
        });
        await db.refund.update({ where: { id: r.id }, data: { providerRef: res.providerRef } });
        if (res.status !== "PENDING") await refundDone({ ...r, approvedBy: p.userId }, { providerRef: res.providerRef, status: res.status, ...(res.failure ? { failure: res.failure } : {}) });
      } catch (err) {
        logger.warn({ err: (err as Error).message, refundId: r.id }, "refund request to the provider failed; reconciliation will retry the status check");
        throw new AppError(502, "the payment provider didn't answer; the refund stays approved and is checked again shortly", "provider_unavailable");
      }
      return refundView(await db.refund.findUniqueOrThrow({ where: { id: r.id } }));
    },
  };
}

export type Payments = ReturnType<typeof createPayments>;
