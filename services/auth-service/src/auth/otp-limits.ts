// Per-phone-number OTP limits (Auth.md §9.7). Better Auth's own limits are per IP and path, and
// every new code resets its per-code attempt counter, so with enough IP addresses a code could be
// brute-forced and any number flooded with SMS. These counters are per phone number, shared by
// every replica through Redis (memory when there is no Redis: development and tests):
//   send-otp  at most one code per RESEND_COOLDOWN, and SENDS_PER_WINDOW per WINDOW
//   verify    after FAILURES_PER_WINDOW wrong tries in a WINDOW the number is locked until the
//             window ends, even with a fresh code; sending is refused while it is locked
// Slots are taken before Better Auth runs (atomic INCR), so parallel requests can't slip past.

import type { Redis } from "ioredis";
import { ETHIOPIAN_MOBILE } from "./password.js";

export const OTP_LIMITS = {
  WINDOW_SECONDS: 60 * 60,
  SENDS_PER_WINDOW: 5,
  RESEND_COOLDOWN_SECONDS: 30,
  FAILURES_PER_WINDOW: 10,
} as const;

export type OtpLimitCode = "otp_resend_too_soon" | "otp_send_limit" | "otp_verify_locked";

export interface OtpRefusal {
  code: OtpLimitCode;
  message: string;
  retryAfterSeconds: number;
}

/** Fixed-window counters (Redis or memory). */
export interface CounterStore {
  /** add 1; the window (ttl) starts with the first hit. Returns the count and the seconds left. */
  increment(key: string, ttlSeconds: number): Promise<{ count: number; ttl: number }>;
  decrement(key: string): Promise<void>;
  /** set only when absent; false (and the seconds left) when it already exists */
  setOnce(key: string, ttlSeconds: number): Promise<{ set: boolean; ttl: number }>;
  /** current count and seconds left (0, 0 when absent) */
  peek(key: string): Promise<{ count: number; ttl: number }>;
  delete(key: string): Promise<void>;
}

// DECR only an existing key: a plain DECR after the window ended would leave a -1 with no TTL
const DECREMENT = `if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('DECR', KEYS[1]) end; return 0`;
const INCREMENT = `local v = redis.call('INCR', KEYS[1]); if v == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return {v, redis.call('TTL', KEYS[1])}`;

export function redisCounterStore(redis: Redis, prefix = "otp:"): CounterStore {
  const ttlOf = (t: number) => Math.max(1, t);
  return {
    async increment(key, ttl) {
      const [count, left] = (await redis.eval(INCREMENT, 1, prefix + key, ttl)) as [number, number];
      return { count: Number(count), ttl: ttlOf(Number(left)) };
    },
    async decrement(key) {
      await redis.eval(DECREMENT, 1, prefix + key);
    },
    async setOnce(key, ttl) {
      if ((await redis.set(prefix + key, "1", "EX", ttl, "NX")) === "OK") return { set: true, ttl };
      return { set: false, ttl: ttlOf(await redis.ttl(prefix + key)) };
    },
    async peek(key) {
      const [v, t] = await Promise.all([redis.get(prefix + key), redis.ttl(prefix + key)]);
      return v === null ? { count: 0, ttl: 0 } : { count: Number(v), ttl: ttlOf(t) };
    },
    async delete(key) {
      await redis.del(prefix + key);
    },
  };
}

export function memoryCounterStore(now: () => number = Date.now): CounterStore {
  const rows = new Map<string, { count: number; expiresAt: number }>();
  const live = (key: string) => {
    const r = rows.get(key);
    if (r && r.expiresAt <= now()) rows.delete(key);
    return rows.get(key);
  };
  const left = (r: { expiresAt: number }) => Math.max(1, Math.ceil((r.expiresAt - now()) / 1000));
  return {
    async increment(key, ttl) {
      const r = live(key) ?? { count: 0, expiresAt: now() + ttl * 1000 };
      r.count += 1;
      rows.set(key, r);
      return { count: r.count, ttl: left(r) };
    },
    async decrement(key) {
      const r = live(key);
      if (r) r.count -= 1;
    },
    async setOnce(key, ttl) {
      const r = live(key);
      if (r) return { set: false, ttl: left(r) };
      rows.set(key, { count: 1, expiresAt: now() + ttl * 1000 });
      return { set: true, ttl };
    },
    async peek(key) {
      const r = live(key);
      return r ? { count: r.count, ttl: left(r) } : { count: 0, ttl: 0 };
    },
    async delete(key) {
      rows.delete(key);
    },
  };
}

/**
 * The number the limits are kept under. Better Auth uses the submitted string as it is (no
 * normalisation) as the OTP's identifier, and its validator accepts only ETHIOPIAN_MOBILE, so the
 * key is that exact string. Anything else is refused by send-otp and can never match a code.
 */
export function otpLimitKey(phoneNumber: unknown): string | undefined {
  return typeof phoneNumber === "string" && ETHIOPIAN_MOBILE.test(phoneNumber) ? phoneNumber : undefined;
}

export function createOtpLimiter(store: CounterStore, limits: typeof OTP_LIMITS = OTP_LIMITS) {
  const W = limits.WINDOW_SECONDS;
  const locked = async (phone: string): Promise<OtpRefusal | undefined> => {
    const f = await store.peek(`fail:${phone}`);
    if (f.count < limits.FAILURES_PER_WINDOW) return undefined;
    return { code: "otp_verify_locked", message: "too many wrong codes for this number; try again later", retryAfterSeconds: f.ttl };
  };

  return {
    /** Before send-otp: refused, or a slot taken. */
    async beforeSend(phone: string): Promise<OtpRefusal | undefined> {
      const lock = await locked(phone);
      if (lock) return lock;
      const cool = await store.setOnce(`cool:${phone}`, limits.RESEND_COOLDOWN_SECONDS);
      if (!cool.set) return { code: "otp_resend_too_soon", message: "wait before asking for another code", retryAfterSeconds: cool.ttl };
      const sent = await store.increment(`send:${phone}`, W);
      if (sent.count > limits.SENDS_PER_WINDOW) {
        return { code: "otp_send_limit", message: "too many codes sent to this number; try again later", retryAfterSeconds: sent.ttl };
      }
      return undefined;
    },

    /** Before verify: refused while locked, otherwise one try is reserved (counted as a failure until it succeeds). */
    async beforeVerify(phone: string): Promise<OtpRefusal | undefined> {
      const tries = await store.increment(`fail:${phone}`, W);
      if (tries.count > limits.FAILURES_PER_WINDOW) {
        return { code: "otp_verify_locked", message: "too many wrong codes for this number; try again later", retryAfterSeconds: tries.ttl };
      }
      return undefined;
    },

    /** After verify ran: `status` is Better Auth's answer. */
    async afterVerify(phone: string, status: number): Promise<void> {
      if (status >= 200 && status < 300) await store.delete(`fail:${phone}`); // signed in: the count starts over
      else if (status === 429 || status >= 500) await store.decrement(`fail:${phone}`); // no code was checked
      // any other answer (wrong, expired or used-up code) keeps the reserved try as a failure
    },
  };
}

export type OtpLimiter = ReturnType<typeof createOtpLimiter>;
