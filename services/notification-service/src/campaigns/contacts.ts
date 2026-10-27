// Phone numbers for SMS campaigns. notification-service keeps no phone numbers (only OTP HMACs),
// so it asks auth-service per recipient: GET {AUTH_INTERNAL_URL}/internal/users/:id/contact →
// { phoneNumber: string | null }. 404 = no number on file (the delivery is SKIPPED as no_phone).

export interface ContactLookup {
  /** E.164 number, or null when the user has none; rejects when auth-service can't answer. */
  phoneOf(userId: string): Promise<string | null>;
}

export function authContacts(base: string, token: string, timeoutMs = 2500): ContactLookup {
  return {
    async phoneOf(userId) {
      const res = await fetch(new URL(`/internal/users/${encodeURIComponent(userId)}/contact`, base), {
        headers: { authorization: `Bearer ${token}`, "x-service-name": "notification-service" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`auth-service /internal/users/:id/contact: http ${res.status}`);
      const body = (await res.json()) as { phoneNumber?: string | null };
      return typeof body.phoneNumber === "string" && /^\+[1-9]\d{7,14}$/.test(body.phoneNumber) ? body.phoneNumber : null;
    },
  };
}
