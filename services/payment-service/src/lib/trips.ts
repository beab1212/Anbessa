// Trip facts from trip-service (GET /internal/trips/:id, service token): defence in depth for the
// money in trip events. Before payment-service posts anything for trip.completed / trip.cancelled
// it compares the event's money fields with trip-service's own record of the trip; a trip event
// that disagrees (or names a trip trip-service doesn't know) is never posted (payments.ts).
//
// get() returns null only for a 404; trip-service unreachable or failing throws, so the consumer
// leaves the event uncommitted and kafkajs tries again (never dropped, never posted unchecked).

import type { TripCancelledEvent, TripCompletedEvent } from "@ride-app/shared-types";

/** The part of trip-service's internal trip view (trips/service.ts `tripView` + beneficiary) checked here. */
export interface TripFacts {
  id: string;
  status: string;
  cityId: string;
  riderUserId: string | null;
  paymentMethod: string;
  billing: { type: string; orgId: string | null };
  driver: { userId: string } | null;
  beneficiary: { type: string; id: string } | null;
  fare: { finalMinor: number | null; waitingFeeMinor: number | null; promoDiscountMinor: number; currency: string };
  cancellation: { feeMinor: number | null; driverCompensationMinor: number | null } | null;
}

export interface TripLookup {
  get(tripId: string): Promise<TripFacts | null>;
}

export function tripLookup(base: string, token: string): TripLookup {
  return {
    async get(tripId) {
      const res = await fetch(new URL(`/internal/trips/${encodeURIComponent(tripId)}`, base), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`trip-service http ${res.status}`);
      return (await res.json()) as TripFacts;
    },
  };
}

export interface Mismatch {
  field: string;
  event: unknown;
  trip: unknown;
}

function differ(out: Mismatch[], field: string, event: unknown, trip: unknown) {
  if (JSON.stringify(event ?? null) !== JSON.stringify(trip ?? null)) out.push({ field, event: event ?? null, trip: trip ?? null });
}
const beneficiaryKey = (b: { type: string; id: string } | null | undefined) => (b ? { type: b.type, id: b.id } : null);

/** Where a trip.completed disagrees with the trip's record ([] = it agrees). */
export function completedMismatches(e: TripCompletedEvent, t: TripFacts | null): Mismatch[] {
  if (!t) return [{ field: "trip", event: e.tripId, trip: null }];
  const out: Mismatch[] = [];
  differ(out, "status", "completed", t.status);
  differ(out, "riderId", e.riderId, t.riderUserId);
  differ(out, "cityId", e.cityId, t.cityId);
  differ(out, "driverId", e.driverId, t.driver?.userId);
  differ(out, "beneficiary", beneficiaryKey(e.beneficiary), beneficiaryKey(t.beneficiary));
  differ(out, "paymentMethod", e.paymentMethod, t.paymentMethod);
  differ(out, "billingOrgId", e.billingOrgId ?? null, t.billing.orgId);
  differ(out, "currency", e.currency, t.fare.currency);
  differ(out, "fareMinor", e.fareMinor, t.fare.finalMinor);
  differ(out, "waitingFeeMinor", e.waitingFeeMinor, t.fare.waitingFeeMinor ?? 0);
  differ(out, "promoDiscountMinor", e.promoDiscountMinor ?? 0, t.fare.promoDiscountMinor);
  return out;
}

/** Where a trip.cancelled disagrees with the trip's record ([] = it agrees). */
export function cancelledMismatches(e: TripCancelledEvent & { billingOrgId?: string }, t: TripFacts | null): Mismatch[] {
  if (!t) return [{ field: "trip", event: e.tripId, trip: null }];
  const out: Mismatch[] = [];
  differ(out, "status", "cancelled", t.status);
  differ(out, "riderId", e.riderId, t.riderUserId);
  differ(out, "cityId", e.cityId, t.cityId);
  differ(out, "driverId", e.driverId ?? null, t.driver?.userId ?? null);
  differ(out, "beneficiary", beneficiaryKey(e.beneficiary), beneficiaryKey(t.beneficiary));
  differ(out, "paymentMethod", e.paymentMethod, t.paymentMethod);
  differ(out, "billingOrgId", e.billingOrgId ?? null, t.billing.orgId);
  differ(out, "currency", e.currency, t.fare.currency);
  differ(out, "feeMinor", e.feeMinor, t.cancellation?.feeMinor ?? 0);
  differ(out, "driverCompensationMinor", e.driverCompensationMinor, t.cancellation?.driverCompensationMinor ?? 0);
  return out;
}
