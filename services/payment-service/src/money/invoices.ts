// Corporate invoices (workflow 11 D, Payment.md §6.3): a company's trips post to its
// CORPORATE_RECEIVABLE account; once an Addis Ababa calendar month is over, a finance officer
// (invoice:issue) issues that month's invoice: every receivable posting of the month not invoiced
// yet becomes a line (a posting is invoiced at most once), numbered INV-YYYYMM-NNNNN without gaps.
// One invoice per company per month; once issued it never changes (trigger), only how much of it
// is paid. A bank transfer from the company is applied by finance (receivable +X, bank −X); when
// the whole amount is in, the invoice is PAID. Company account admins (corporate:read_invoices
// @ ORG) see their own company's invoices and nothing else.

import { randomUUID } from "node:crypto";
import { authorize, AuthorizationError, can, type Principal } from "@ride-app/shared-authz";
import { Prisma, type Invoice, type InvoiceLine, type InvoicePayment } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { accounts, post } from "../ledger/ledger.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import { addisMonth, INVOICE_TERMS_DAYS, invoiceNumber, isPeriod } from "./controls.js";

type Tx = Prisma.TransactionClient;

export function invoiceView(i: Invoice, now = new Date()) {
  return {
    id: i.id, orgId: i.orgId, period: i.period, number: i.number, periodStart: i.periodStart, periodEnd: i.periodEnd, currency: i.currency,
    totalMinor: Number(i.totalMinor), lineCount: i.lineCount, paidMinor: Number(i.paidMinor), outstandingMinor: Number(i.totalMinor - i.paidMinor),
    status: i.status, overdue: i.status === "ISSUED" && i.dueAt < now, issuedBy: i.issuedBy, issuedAt: i.issuedAt, dueAt: i.dueAt, paidAt: i.paidAt,
  };
}

const lineView = (l: InvoiceLine) => ({
  id: l.id, at: l.at, kind: l.kind, tripId: l.tripId, purpose: l.purpose, riderId: l.riderId, cityId: l.cityId, vehicleType: l.vehicleType, amountMinor: Number(l.amountMinor),
});

const paymentView = (x: InvoicePayment, staff: boolean) => ({
  id: x.id, amountMinor: Number(x.amountMinor), bankReference: x.bankReference, createdAt: x.createdAt, ...(staff ? { recordedBy: x.recordedBy } : {}),
});

/** One CSV field; text a spreadsheet would run as a formula is defused. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const etb = (minor: number) => (minor / 100).toFixed(2);

/** The invoice's lines as CSV (CRLF), with a total row. */
export function invoiceCsv(i: ReturnType<typeof invoiceView>, lines: ReturnType<typeof lineView>[]): string {
  const head = ["invoice_number", "period", "at", "kind", "trip_id", "purpose", "rider_id", "city", "vehicle_type", "amount_etb"];
  const rows = lines.map((l) => [i.number, i.period, l.at, l.kind, l.tripId, l.purpose, l.riderId, l.cityId, l.vehicleType, etb(l.amountMinor)]);
  rows.push([i.number, i.period, null, "TOTAL", null, null, null, null, null, etb(i.totalMinor)]);
  return [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

const FINANCE = ["invoice:issue", "report:read_finance"] as const;
const isFinance = (p: Principal) => FINANCE.some((perm) => can(p, perm));

/** The receivable postings of a month not invoiced yet (company payments are not lines). */
async function uninvoicedPostings(tx: Pick<Tx, "$queryRaw">, accountId: string, start: Date, end: Date) {
  return tx.$queryRaw<{
    posting_id: string; entry_id: string; kind: string; at: Date; amount: bigint; trip_id: string | null; purpose: string | null;
    rider_id: string | null; city_id: string | null; vehicle_type: string | null;
  }[]>`
    SELECT p.id::text AS posting_id, je.id::text AS entry_id, je.kind, p.created_at AS at, p.amount_minor AS amount,
      ts.trip_id::text AS trip_id, ts.purpose, ts.rider_id::text AS rider_id, ts.city_id, ts.vehicle_type
    FROM posting p
    JOIN journal_entry je ON je.id = p.journal_entry_id
    LEFT JOIN trip_settlement ts
      ON ts.trip_id = (CASE WHEN je.reference_type = 'trip' THEN je.reference_id::uuid END)
      AND ts.purpose = (CASE je.kind WHEN 'TRIP_SETTLEMENT' THEN 'TRIP_FARE' WHEN 'CANCELLATION_FEE' THEN 'CANCELLATION_FEE' END)
    WHERE p.account_id = ${accountId}::uuid AND p.created_at >= ${start} AND p.created_at < ${end}
      AND je.kind <> 'INVOICE_PAYMENT'
      AND NOT EXISTS (SELECT 1 FROM invoice_line il WHERE il.posting_id = p.id)
    ORDER BY p.created_at, p.id`;
}

export function createInvoices(deps: { db: Db; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  function assertOrgReader(p: Principal, orgId: string) {
    if (!can(p, "corporate:read_invoices", { orgId }) && !isFinance(p)) throw new AuthorizationError("corporate:read_invoices");
  }

  async function detail(i: Invoice, staff: boolean) {
    const [lines, payments] = await Promise.all([
      db.invoiceLine.findMany({ where: { invoiceId: i.id }, orderBy: [{ at: "asc" }, { id: "asc" }] }),
      db.invoicePayment.findMany({ where: { invoiceId: i.id }, orderBy: { createdAt: "asc" } }),
    ]);
    return { ...invoiceView(i, now()), lines: lines.map(lineView), payments: payments.map((x) => paymentView(x, staff)) };
  }

  return {
    /** Issue a company's invoice for a month that is over. */
    async issue(p: Principal, input: { orgId: string; period: string }) {
      authorize(p, "invoice:issue");
      if (!isPeriod(input.period)) throw badRequest("period is YYYY-MM", "invalid_period");
      const { start, end } = addisMonth(input.period);
      if (now() < end) throw badRequest("that month isn't over yet; invoice it from the 1st of the next month", "period_open");
      const account = await db.ledgerAccount.findUnique({ where: { code: accounts.corporate(input.orgId).code } });
      if (!account) throw conflict("this company has no corporate charges", "nothing_to_invoice");
      try {
        const issued = await db.$transaction(async (tx) => {
          if (await tx.invoice.findUnique({ where: { orgId_period: { orgId: input.orgId, period: input.period } } })) {
            throw conflict(`this company's invoice for ${input.period} is already issued`, "already_issued");
          }
          // a payment or a late charge can't slip in while the lines are taken
          await tx.$queryRaw`SELECT id FROM ledger_account WHERE id = ${account.id}::uuid FOR UPDATE`;
          const rows = await uninvoicedPostings(tx, account.id, start, end);
          const total = -rows.reduce((s, r) => s + Number(r.amount), 0);
          if (rows.length === 0 || total <= 0) throw conflict(`nothing to invoice for ${input.period}`, "nothing_to_invoice");
          const [counter] = await tx.$queryRaw<{ last: number }[]>`
            INSERT INTO invoice_counter (period, last) VALUES (${input.period}, 1)
            ON CONFLICT (period) DO UPDATE SET last = invoice_counter.last + 1
            RETURNING last`;
          const at = now();
          const invoice = await tx.invoice.create({
            data: {
              orgId: input.orgId, period: input.period, number: invoiceNumber(input.period, Number(counter!.last)), periodStart: start, periodEnd: end,
              totalMinor: BigInt(total), lineCount: rows.length, issuedBy: p.userId, issuedAt: at, dueAt: new Date(at.getTime() + INVOICE_TERMS_DAYS * 86_400_000),
            },
          });
          await tx.invoiceLine.createMany({
            data: rows.map((r) => ({
              invoiceId: invoice.id, postingId: r.posting_id, journalEntryId: r.entry_id, kind: r.kind, tripId: r.trip_id, purpose: r.purpose,
              riderId: r.rider_id, cityId: r.city_id, vehicleType: r.vehicle_type, at: r.at, amountMinor: -r.amount,
            })),
          });
          await writeOutbox(tx,
            {
              topic: "invoice.issued", key: invoice.orgId,
              payload: {
                invoiceId: invoice.id, orgId: invoice.orgId, number: invoice.number, period: invoice.period, totalMinor: total, paidMinor: 0, currency: invoice.currency,
                dueAt: invoice.dueAt.toISOString(),
              },
            },
            audit({ actorId: p.userId, action: "invoice:issue", resource: { type: "invoice", id: invoice.id }, outcome: "EXECUTED", reason: invoice.number }),
          );
          return invoice;
        });
        return detail(issued, true);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw conflict(`this company's invoice for ${input.period} is already issued`, "already_issued");
        throw err;
      }
    },

    /** Companies with charges in a month that has no invoice yet (finance's queue). */
    async uninvoiced(p: Principal, period: string) {
      if (!isFinance(p)) throw new AuthorizationError("invoice:issue");
      if (!isPeriod(period)) throw badRequest("period is YYYY-MM", "invalid_period");
      const { start, end } = addisMonth(period);
      const rows = await db.$queryRaw<{ org_id: string; lines: bigint; total: bigint; first_at: Date; last_at: Date }[]>`
        SELECT a.owner_id AS org_id, count(*) AS lines, -sum(p.amount_minor) AS total, min(p.created_at) AS first_at, max(p.created_at) AS last_at
        FROM posting p
        JOIN ledger_account a ON a.id = p.account_id AND a.kind = 'CORPORATE_RECEIVABLE'
        JOIN journal_entry je ON je.id = p.journal_entry_id
        WHERE p.created_at >= ${start} AND p.created_at < ${end} AND je.kind <> 'INVOICE_PAYMENT'
          AND NOT EXISTS (SELECT 1 FROM invoice_line il WHERE il.posting_id = p.id)
        GROUP BY a.owner_id
        ORDER BY -sum(p.amount_minor) DESC
        LIMIT 500`;
      return {
        period, periodStart: start, periodEnd: end, open: now() < end,
        companies: rows.map((r) => ({ orgId: r.org_id, lines: Number(r.lines), totalMinor: Number(r.total), firstAt: r.first_at, lastAt: r.last_at })),
      };
    },

    /** Finance: every company's invoices. */
    async list(p: Principal, q: { status?: string | undefined; orgId?: string | undefined; period?: string | undefined; overdue?: boolean | undefined }) {
      if (!isFinance(p)) throw new AuthorizationError("invoice:issue");
      const rows = await db.invoice.findMany({
        where: {
          ...(q.status ? { status: q.status } : {}), ...(q.orgId ? { orgId: q.orgId } : {}), ...(q.period ? { period: q.period } : {}),
          ...(q.overdue ? { status: "ISSUED", dueAt: { lt: now() } } : {}),
        },
        orderBy: [{ issuedAt: "desc" }], take: 200,
      });
      return rows.map((i) => invoiceView(i, now()));
    },

    async get(p: Principal, id: string) {
      const i = await db.invoice.findUnique({ where: { id } });
      if (!i || (!isFinance(p) && !can(p, "corporate:read_invoices", { orgId: i.orgId }))) throw notFound("invoice");
      return detail(i, isFinance(p));
    },

    /** A company's own invoices (corporate:read_invoices @ ORG, or finance). */
    async forOrg(p: Principal, orgId: string) {
      assertOrgReader(p, orgId);
      const rows = await db.invoice.findMany({ where: { orgId }, orderBy: { period: "desc" }, take: 60 });
      const account = await db.ledgerAccount.findUnique({ where: { code: accounts.corporate(orgId).code } });
      return { orgId, owedMinor: account ? -Number(account.balanceMinor) : 0, invoices: rows.map((i) => invoiceView(i, now())) };
    },

    /** One of a company's invoices; another company's is "not found". */
    async getForOrg(p: Principal, orgId: string, id: string) {
      assertOrgReader(p, orgId);
      const i = await db.invoice.findUnique({ where: { id } });
      if (!i || i.orgId !== orgId) throw notFound("invoice");
      return detail(i, isFinance(p));
    },

    /** Apply a company's bank transfer to an invoice (once per bank reference). */
    async recordPayment(p: Principal, id: string, input: { amountMinor: number; bankReference: string }) {
      authorize(p, "invoice:issue");
      const ref = input.bankReference.trim().toUpperCase();
      try {
        await db.$transaction(async (tx) => {
          const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM invoice WHERE id = ${id}::uuid FOR UPDATE`;
          if (!locked) throw notFound("invoice");
          const i = await tx.invoice.findUniqueOrThrow({ where: { id } });
          if (i.status !== "ISSUED") throw conflict("the invoice is already paid", "invalid_state");
          const outstanding = Number(i.totalMinor - i.paidMinor);
          if (input.amountMinor > outstanding) throw badRequest(`only ${outstanding / 100} ETB is outstanding on ${i.number}`, "amount_exceeds_outstanding");
          const paymentId = randomUUID();
          const posted = await post(tx, {
            kind: "INVOICE_PAYMENT", referenceType: "invoice", referenceId: i.id, idempotencyKey: `invoice-payment:${ref}`, createdBy: p.userId,
            memo: `payment of ${i.number} (${ref})`,
            lines: [{ account: accounts.clearing("bank"), amountMinor: -input.amountMinor }, { account: accounts.corporate(i.orgId), amountMinor: input.amountMinor }],
          });
          if (!posted.created) throw conflict("this bank transaction is already applied", "duplicate_reference");
          await tx.invoicePayment.create({ data: { id: paymentId, invoiceId: i.id, amountMinor: BigInt(input.amountMinor), bankReference: ref, recordedBy: p.userId, journalEntryId: posted.entryId } });
          const paid = Number(i.paidMinor) + input.amountMinor;
          const full = paid === Number(i.totalMinor);
          const at = now();
          await tx.invoice.update({ where: { id }, data: { paidMinor: BigInt(paid), ...(full ? { status: "PAID", paidAt: at } : {}) } });
          await writeOutbox(tx, audit({ actorId: p.userId, action: "invoice:record_payment", resource: { type: "invoice", id }, outcome: "EXECUTED", reason: `${ref} ${input.amountMinor / 100} ETB` }));
          if (full) {
            await writeOutbox(tx, {
              topic: "invoice.paid", key: i.orgId,
              payload: {
                invoiceId: i.id, orgId: i.orgId, number: i.number, period: i.period, totalMinor: Number(i.totalMinor), paidMinor: paid, currency: i.currency,
                dueAt: i.dueAt.toISOString(), paidAt: at.toISOString(),
              },
            });
          }
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw conflict("this bank transaction is already applied", "duplicate_reference");
        throw err;
      }
      return this.get(p, id);
    },

    csv: invoiceCsv,
  };
}

export type Invoices = ReturnType<typeof createInvoices>;
