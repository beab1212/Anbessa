// Trip settlement (Payment.md §6, workflow 08): one journal entry per trip (or cancellation fee),
// keyed `trip-settlement:<tripId>` / `cancel-fee:<tripId>`, so a replay posts nothing. Where the
// fare came from decides the first line:
//
//   cash             the driver holds it: the beneficiary owes commission + VAT
//   card / mobile    PROVIDER_CLEARING (captured by the provider)
//   failed charge    RIDER_RECEIVABLE (the platform carries the risk, Payment.md Q6)
//   corporate        CORPORATE_RECEIVABLE (invoiced monthly)

import type { Beneficiary, PaymentMethod } from "@ride-app/shared-types";
import type { Prisma } from "../generated/prisma/client.js";
import { accounts, post, type Line } from "../ledger/ledger.js";
import { writeOutbox } from "../outbox/outbox.js";
import { afterPosting, ensureBeneficiary, policyAt, ruleAt } from "./balances.js";
import { tripMoney, type TripMoney } from "./rules.js";

type Tx = Prisma.TransactionClient;

export type Source =
  | { type: "CASH" }
  | { type: "PROVIDER"; provider: string }
  | { type: "RIDER_RECEIVABLE" }
  | { type: "CORPORATE"; orgId: string };

export interface TripFareInput {
  tripId: string;
  riderId: string;
  driverId: string;
  beneficiary: Beneficiary;
  cityId: string;
  vehicleType: string;
  paymentMethod: PaymentMethod;
  fareMinor: number;
  currency: string;
  /** the commission rule valid at this time applies (Payment.md §16) */
  at: Date;
  source: Source;
}

function sourceLine(source: Source, riderId: string, amountMinor: number): Line[] {
  switch (source.type) {
    case "CASH":
      return [];
    case "PROVIDER":
      return [{ account: accounts.clearing(source.provider), amountMinor: -amountMinor }];
    case "RIDER_RECEIVABLE":
      return [{ account: accounts.rider(riderId), amountMinor: -amountMinor }];
    case "CORPORATE":
      return [{ account: accounts.corporate(source.orgId), amountMinor: -amountMinor }];
  }
}

/** Settle a completed trip. Returns null when it was already settled. */
export async function settleTripFare(tx: Tx, input: TripFareInput, now: Date): Promise<(TripMoney & { entryId: string }) | null> {
  const already = await tx.tripSettlement.findUnique({ where: { tripId_purpose: { tripId: input.tripId, purpose: "TRIP_FARE" } } });
  if (already) return null;

  const b = await ensureBeneficiary(tx, input.beneficiary, input.cityId);
  const policy = await policyAt(tx, input.cityId, input.at);
  const rule = await ruleAt(tx, { cityId: input.cityId, vehicleType: input.vehicleType, beneficiaryOwnerId: input.beneficiary.id, at: input.at });
  const money = tripMoney(input.fareMinor, input.source.type === "CASH", rule, policy);

  const posted = await post(tx, {
    kind: "TRIP_SETTLEMENT", referenceType: "trip", referenceId: input.tripId, idempotencyKey: `trip-settlement:${input.tripId}`,
    memo: `${input.paymentMethod.toLowerCase().replace("_", " ")} trip`,
    lines: [
      ...sourceLine(input.source, input.riderId, input.fareMinor),
      { account: { id: b.accountId }, amountMinor: money.earningsMinor },
      { account: accounts.commission(input.cityId), amountMinor: money.commissionMinor },
      { account: accounts.vat(), amountMinor: money.vatMinor },
    ],
  });
  if (!posted.created) return null;

  await tx.tripSettlement.create({
    data: {
      tripId: input.tripId, purpose: "TRIP_FARE", paymentMethod: input.paymentMethod, cityId: input.cityId, vehicleType: input.vehicleType,
      driverId: input.driverId, riderId: input.riderId, beneficiaryAccountId: b.accountId, fareMinor: BigInt(money.fareMinor),
      commissionMinor: BigInt(money.commissionMinor), vatMinor: BigInt(money.vatMinor), commissionRuleId: rule.id,
      earningsMinor: BigInt(money.earningsMinor), journalEntryId: posted.entryId, settledAt: now,
    },
  });
  await afterPosting(tx, b.accountId, { creditMinor: money.earningsMinor, now });
  await writeOutbox(tx, {
    topic: "trip.settled", key: input.tripId,
    payload: {
      tripId: input.tripId, riderId: input.riderId, driverId: input.driverId, beneficiary: input.beneficiary, purpose: "TRIP_FARE",
      paymentMethod: input.paymentMethod, fareMinor: money.fareMinor, commissionMinor: money.commissionMinor, vatMinor: money.vatMinor,
      earningsMinor: money.earningsMinor, currency: input.currency,
    },
  });
  return { ...money, entryId: posted.entryId };
}

export interface CancellationFeeInput {
  tripId: string;
  riderId: string;
  driverId: string | null;
  beneficiary: Beneficiary | null;
  cityId: string;
  paymentMethod: PaymentMethod;
  feeMinor: number;
  /** the beneficiary's share of the fee */
  compensationMinor: number;
  currency: string;
  source: Source;
}

/**
 * A rider's cancellation fee (Payment.md §6.5): the beneficiary gets their compensation, the
 * platform keeps the rest. On a cash trip the fee can't be collected now, so it becomes a rider
 * receivable and the driver is compensated at once (a platform cost until it's collected).
 */
export async function settleCancellationFee(tx: Tx, input: CancellationFeeInput, now: Date) {
  const already = await tx.tripSettlement.findUnique({ where: { tripId_purpose: { tripId: input.tripId, purpose: "CANCELLATION_FEE" } } });
  if (already || input.feeMinor <= 0) return null;
  const source: Source = input.source.type === "CASH" ? { type: "RIDER_RECEIVABLE" } : input.source;
  const compensation = input.beneficiary ? Math.min(input.compensationMinor, input.feeMinor) : 0;
  const b = input.beneficiary ? await ensureBeneficiary(tx, input.beneficiary, input.cityId) : null;

  const posted = await post(tx, {
    kind: "CANCELLATION_FEE", referenceType: "trip", referenceId: input.tripId, idempotencyKey: `cancel-fee:${input.tripId}`,
    memo: "cancellation fee",
    lines: [
      ...sourceLine(source, input.riderId, input.feeMinor),
      ...(b ? [{ account: { id: b.accountId }, amountMinor: compensation }] : []),
      { account: accounts.commission(input.cityId), amountMinor: input.feeMinor - compensation },
    ],
  });
  if (!posted.created) return null;
  await tx.tripSettlement.create({
    data: {
      tripId: input.tripId, purpose: "CANCELLATION_FEE", paymentMethod: input.paymentMethod, cityId: input.cityId, driverId: input.driverId,
      riderId: input.riderId, beneficiaryAccountId: b?.accountId ?? null, fareMinor: BigInt(input.feeMinor),
      commissionMinor: BigInt(input.feeMinor - compensation), vatMinor: 0n, earningsMinor: BigInt(compensation), journalEntryId: posted.entryId, settledAt: now,
    },
  });
  if (b) await afterPosting(tx, b.accountId, { creditMinor: compensation, now });
  await writeOutbox(tx, {
    topic: "trip.settled", key: input.tripId,
    payload: {
      tripId: input.tripId, riderId: input.riderId, ...(input.driverId ? { driverId: input.driverId } : {}), ...(input.beneficiary ? { beneficiary: input.beneficiary } : {}),
      purpose: "CANCELLATION_FEE", paymentMethod: input.paymentMethod, fareMinor: input.feeMinor, commissionMinor: input.feeMinor - compensation,
      vatMinor: 0, earningsMinor: compensation, currency: input.currency,
    },
  });
  return { entryId: posted.entryId };
}

/** A rider pays later what a failed charge left owing (receivable → provider clearing). */
export async function collectReceivable(tx: Tx, input: { paymentId: string; riderId: string; provider: string; amountMinor: number }) {
  return post(tx, {
    kind: "RECEIVABLE_COLLECTION", referenceType: "payment", referenceId: input.paymentId, idempotencyKey: `receivable-collection:${input.paymentId}`,
    memo: "late payment of a failed charge",
    lines: [
      { account: accounts.clearing(input.provider), amountMinor: -input.amountMinor },
      { account: accounts.rider(input.riderId), amountMinor: input.amountMinor },
    ],
  });
}
