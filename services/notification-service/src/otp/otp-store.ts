// Short-lived OTP state in Redis (Auth.md §9.7, step 1):
//   otp:code:{phoneHash}  → the active code for that phone, AES-256-GCM sealed, expires with the code
//   otp:fallback          → sorted set of Telegram delivery ids, scored by when to fall back to SMS
// The fallback schedule is in Redis, not in a process timer, so a restart doesn't lose it and
// several replicas can poll it: ZREM succeeds for exactly one of them.

import type { Redis } from "ioredis";
import type { Sealer } from "../lib/crypto.js";

export interface ActiveCode {
  phoneNumber: string;
  code: string;
  purpose: string;
  ttlSeconds: number;
  /** every otp_delivery row created for this code */
  deliveryIds: string[];
  telegram?: { deliveryId: string; requestId: string };
}

export interface OtpStore {
  /** A new code for this phone (replaces any previous one). */
  putCode(phoneHash: string, value: ActiveCode, ttlSeconds: number): Promise<void>;
  /** Same code, more state (e.g. a fallback row): keeps the remaining lifetime. */
  updateCode(phoneHash: string, value: ActiveCode): Promise<void>;
  getCode(phoneHash: string): Promise<ActiveCode | null>;
  deleteCode(phoneHash: string): Promise<void>;
  scheduleFallback(deliveryId: string, at: Date): Promise<void>;
  cancelFallback(deliveryId: string): Promise<void>;
  /** Claims (removes and returns) the fallbacks due at `now`. */
  claimDueFallbacks(now: Date, limit?: number): Promise<string[]>;
}

const codeKey = (phoneHash: string) => `otp:code:${phoneHash}`;
const FALLBACK_KEY = "otp:fallback";

export function redisOtpStore(redis: Redis, sealer: Sealer): OtpStore {
  return {
    async putCode(phoneHash, value, ttlSeconds) {
      await redis.set(codeKey(phoneHash), sealer.seal(JSON.stringify(value), phoneHash), "EX", ttlSeconds);
    },
    async updateCode(phoneHash, value) {
      // XX: only if the code still exists (never resurrect an expired code)
      await redis.set(codeKey(phoneHash), sealer.seal(JSON.stringify(value), phoneHash), "KEEPTTL", "XX");
    },
    async getCode(phoneHash) {
      const sealed = await redis.get(codeKey(phoneHash));
      if (!sealed) return null;
      try {
        return JSON.parse(sealer.open(sealed, phoneHash)) as ActiveCode;
      } catch {
        return null; // tampered with, or sealed with another key: treat as absent
      }
    },
    async deleteCode(phoneHash) {
      await redis.del(codeKey(phoneHash));
    },
    async scheduleFallback(deliveryId, at) {
      await redis.zadd(FALLBACK_KEY, at.getTime(), deliveryId);
    },
    async cancelFallback(deliveryId) {
      await redis.zrem(FALLBACK_KEY, deliveryId);
    },
    async claimDueFallbacks(now, limit = 50) {
      const due = await redis.zrangebyscore(FALLBACK_KEY, 0, now.getTime(), "LIMIT", 0, limit);
      const claimed: string[] = [];
      for (const id of due) if ((await redis.zrem(FALLBACK_KEY, id)) === 1) claimed.push(id);
      return claimed;
    },
  };
}

/** In-memory store for tests. */
export function memoryOtpStore(now: () => number = Date.now): OtpStore & { codes: Map<string, { value: ActiveCode; expiresAt: number }> } {
  const codes = new Map<string, { value: ActiveCode; expiresAt: number }>();
  const fallbacks = new Map<string, number>();
  return {
    codes,
    async putCode(phoneHash, value, ttlSeconds) {
      codes.set(phoneHash, { value: structuredClone(value), expiresAt: now() + ttlSeconds * 1000 });
    },
    async updateCode(phoneHash, value) {
      const e = codes.get(phoneHash);
      if (e && e.expiresAt > now()) codes.set(phoneHash, { value: structuredClone(value), expiresAt: e.expiresAt });
    },
    async getCode(phoneHash) {
      const e = codes.get(phoneHash);
      if (!e || e.expiresAt <= now()) return null;
      return structuredClone(e.value);
    },
    async deleteCode(phoneHash) {
      codes.delete(phoneHash);
    },
    async scheduleFallback(id, at) {
      fallbacks.set(id, at.getTime());
    },
    async cancelFallback(id) {
      fallbacks.delete(id);
    },
    async claimDueFallbacks(at) {
      const due = [...fallbacks].filter(([, t]) => t <= at.getTime()).map(([id]) => id);
      for (const id of due) fallbacks.delete(id);
      return due;
    },
  };
}
