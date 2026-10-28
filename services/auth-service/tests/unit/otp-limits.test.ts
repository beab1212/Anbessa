import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createOtpLimiter, memoryCounterStore, OTP_LIMITS, otpLimitKey } from "../../src/auth/otp-limits.js";
import { mountBetterAuth } from "../../src/http/better-auth.routes.js";
import type { Db } from "../../src/db.js";

const PHONE = "+251911223344";

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (s: number) => { t += s * 1000; } };
}

describe("otpLimitKey", () => {
  it("keys on the exact number Better Auth uses as the OTP identifier", () => {
    expect(otpLimitKey(PHONE)).toBe(PHONE);
    expect(otpLimitKey(" +251911223344")).toBeUndefined(); // refused by Better Auth's validator anyway
    expect(otpLimitKey(42)).toBeUndefined();
  });
});

describe("per-phone OTP limits", () => {
  it("enforces a resend cooldown and a cap on codes per hour", async () => {
    const c = clock();
    const limits = createOtpLimiter(memoryCounterStore(c.now));
    expect(await limits.beforeSend(PHONE)).toBeUndefined();
    const soon = await limits.beforeSend(PHONE);
    expect(soon?.code).toBe("otp_resend_too_soon");
    expect(soon?.retryAfterSeconds).toBeLessThanOrEqual(OTP_LIMITS.RESEND_COOLDOWN_SECONDS);
    for (let i = 1; i < OTP_LIMITS.SENDS_PER_WINDOW; i++) {
      c.advance(OTP_LIMITS.RESEND_COOLDOWN_SECONDS);
      expect(await limits.beforeSend(PHONE)).toBeUndefined();
    }
    c.advance(OTP_LIMITS.RESEND_COOLDOWN_SECONDS);
    const capped = await limits.beforeSend(PHONE);
    expect(capped?.code).toBe("otp_send_limit");
    expect(capped!.retryAfterSeconds).toBeGreaterThan(0);
    // another number is unaffected, and the window ends
    expect(await limits.beforeSend("+251922334455")).toBeUndefined();
    c.advance(OTP_LIMITS.WINDOW_SECONDS);
    expect(await limits.beforeSend(PHONE)).toBeUndefined();
  });

  it("locks verification after too many wrong codes, even with a fresh code, until the window ends", async () => {
    const c = clock();
    const limits = createOtpLimiter(memoryCounterStore(c.now));
    for (let i = 0; i < OTP_LIMITS.FAILURES_PER_WINDOW; i++) {
      expect(await limits.beforeVerify(PHONE)).toBeUndefined();
      await limits.afterVerify(PHONE, 400);
    }
    expect((await limits.beforeVerify(PHONE))?.code).toBe("otp_verify_locked");
    // no new code while locked either
    expect((await limits.beforeSend(PHONE))?.code).toBe("otp_verify_locked");
    c.advance(OTP_LIMITS.WINDOW_SECONDS);
    expect(await limits.beforeVerify(PHONE)).toBeUndefined();
  });

  it("reserves the try before Better Auth runs, so parallel guesses can't slip past", async () => {
    const limits = createOtpLimiter(memoryCounterStore());
    const answers = await Promise.all(Array.from({ length: 30 }, () => limits.beforeVerify(PHONE)));
    expect(answers.filter((a) => a === undefined)).toHaveLength(OTP_LIMITS.FAILURES_PER_WINDOW);
  });

  it("a success clears the count; a request that never checked a code doesn't count", async () => {
    const limits = createOtpLimiter(memoryCounterStore());
    for (let i = 0; i < OTP_LIMITS.FAILURES_PER_WINDOW - 1; i++) {
      await limits.beforeVerify(PHONE);
      await limits.afterVerify(PHONE, 400);
    }
    await limits.beforeVerify(PHONE);
    await limits.afterVerify(PHONE, 429); // Better Auth's own per-IP limit answered
    await limits.beforeVerify(PHONE);
    await limits.afterVerify(PHONE, 200);
    for (let i = 0; i < OTP_LIMITS.FAILURES_PER_WINDOW; i++) expect(await limits.beforeVerify(PHONE)).toBeUndefined();
  });
});

describe("mountBetterAuth with OTP limits", () => {
  async function app(status = 400) {
    const calls: string[] = [];
    const a = Fastify();
    mountBetterAuth(a, {
      handler: async (r) => {
        calls.push(new URL(r.url).pathname);
        return new Response(JSON.stringify({}), { status, headers: { "content-type": "application/json" } });
      },
    }, { prefix: "/api/auth", surface: "app", db: {} as Db, otpLimits: createOtpLimiter(memoryCounterStore()) });
    await a.ready();
    return { a, calls };
  }

  it("answers 429 with retry-after and a stable code before Better Auth sees the request", async () => {
    const { a, calls } = await app(200);
    const send = () => a.inject({ method: "POST", url: "/api/auth/phone-number/send-otp", payload: { phoneNumber: PHONE } });
    expect((await send()).statusCode).toBe(200);
    const res = await send();
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toMatch(/^\d+$/);
    expect(res.json().error).toBe("otp_resend_too_soon");
    expect(calls).toHaveLength(1);
  });

  it("locks /phone-number/verify for the number after repeated wrong codes", async () => {
    const { a, calls } = await app(400);
    const verify = () => a.inject({ method: "POST", url: "/api/auth/phone-number/verify", payload: { phoneNumber: PHONE, code: "000000" } });
    for (let i = 0; i < OTP_LIMITS.FAILURES_PER_WINDOW; i++) expect((await verify()).statusCode).toBe(400);
    const res = await verify();
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("otp_verify_locked");
    expect(calls).toHaveLength(OTP_LIMITS.FAILURES_PER_WINDOW);
  });
});
