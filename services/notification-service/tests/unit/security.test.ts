import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { phoneHasher, sealer } from "../../src/lib/crypto.js";
import { reportVerifier } from "../../src/otp/telegram-gateway.js";
import { loadConfig } from "../../src/config/index.js";
import { inviteSms } from "../../src/notify/templates.js";
import { smsText } from "../../src/otp/otp-service.js";

const TOKEN = "telegram-gateway-test-token-123456";
const sign = (ts: string, body: string, token = TOKEN) =>
  createHmac("sha256", createHash("sha256").update(token).digest()).update(`${ts}\n${body}`).digest("hex");

describe("Telegram delivery report signature", () => {
  const now = 1_792_900_000_000;
  const verify = reportVerifier(TOKEN, () => now);
  const ts = String(now / 1000);
  const body = '{"request_id":"r1","delivery_status":{"status":"delivered","updated_at":1}}';

  it("accepts a correctly signed, fresh report", () => {
    expect(verify(body, ts, sign(ts, body))).toBe(true);
  });

  it("rejects a modified body, a wrong key, and missing headers", () => {
    expect(verify(body.replace("delivered", "read"), ts, sign(ts, body))).toBe(false);
    expect(verify(body, ts, sign(ts, body, "another-token-entirely-123456"))).toBe(false);
    expect(verify(body, undefined, sign(ts, body))).toBe(false);
    expect(verify(body, ts, undefined)).toBe(false);
    expect(verify(body, ts, "short")).toBe(false);
  });

  it("rejects replays older than 5 minutes (and timestamps from the future)", () => {
    const old = String(now / 1000 - 301);
    const future = String(now / 1000 + 301);
    expect(verify(body, old, sign(old, body))).toBe(false);
    expect(verify(body, future, sign(future, body))).toBe(false);
  });
});

describe("crypto helpers", () => {
  const key = "a".repeat(64);

  it("seals and opens, and refuses tampering or another context", () => {
    const s = sealer(key);
    const sealed = s.seal('{"code":"123456"}', "phone-a");
    expect(sealed).not.toContain("123456");
    expect(s.open(sealed, "phone-a")).toBe('{"code":"123456"}');
    expect(() => s.open(sealed, "phone-b")).toThrow();
    const raw = Buffer.from(sealed, "base64");
    raw[raw.length - 1]! ^= 1;
    expect(() => s.open(raw.toString("base64"), "phone-a")).toThrow();
    expect(() => sealer("b".repeat(64)).open(sealed, "phone-a")).toThrow();
  });

  it("hashes phones deterministically per key, 32 bytes, without the number", () => {
    const h = phoneHasher(key)("+251911223344");
    expect(h.length).toBe(32);
    expect(Buffer.from(h).equals(Buffer.from(phoneHasher(key)("+251911223344")))).toBe(true);
    expect(Buffer.from(h).equals(Buffer.from(phoneHasher("c".repeat(64))("+251911223344")))).toBe(false);
  });
});

describe("templates", () => {
  it("fits one SMS", () => {
    expect(smsText("123456", 300)).toMatch(/123456.*5 minutes/);
    expect(smsText("123456", 300).length).toBeLessThanOrEqual(160);
    expect(inviteSms("Abebe Transport PLC", "fleet_driver")).toBe("Abebe Transport PLC invites you to drive with them on Anbessa. Open the Anbessa app to accept.");
    expect(inviteSms("x".repeat(200), "employee").length).toBeLessThanOrEqual(160);
    expect(inviteSms(undefined, "unknown")).toMatch(/^A company invites you to join them/);
  });
});

describe("config", () => {
  const base = {
    DATABASE_URL: "postgresql://x@localhost/db",
    REDIS_URL: "redis://localhost:6379",
    INTERNAL_SERVICE_TOKEN: "t".repeat(64),
    PHONE_HASH_KEY: "a".repeat(64),
    OTP_ENCRYPTION_KEY: "b".repeat(64),
  };

  it("drops telegram without a token, and treats blank values as unset", () => {
    const c = loadConfig({ ...base, TELEGRAM_GATEWAY_TOKEN: "", KAFKA_BROKERS: "" });
    expect(c.OTP_CHANNELS).toEqual(["sms"]);
    expect(c.KAFKA_BROKERS).toBeUndefined();
  });

  it("keeps the channel order with a token", () => {
    expect(loadConfig({ ...base, TELEGRAM_GATEWAY_TOKEN: TOKEN }).OTP_CHANNELS).toEqual(["telegram", "sms"]);
  });

  it("rejects keys that aren't 32 bytes of hex", () => {
    expect(() => loadConfig({ ...base, OTP_ENCRYPTION_KEY: "short" })).toThrow(/OTP_ENCRYPTION_KEY/);
  });

  it("refuses insecure production settings", () => {
    const err = (() => {
      try {
        loadConfig({ ...base, NODE_ENV: "production", TELEGRAM_GATEWAY_TOKEN: TOKEN, TELEGRAM_CALLBACK_URL: "http://x.test/cb" });
      } catch (e) {
        return String(e);
      }
    })();
    for (const key of ["SMS_PROVIDER", "PUSH_PROVIDER", "KAFKA_BROKERS", "TELEGRAM_CALLBACK_URL"]) expect(err).toContain(key);
  });

  it("requires provider credentials", () => {
    expect(() => loadConfig({ ...base, SMS_PROVIDER: "twilio" })).toThrow(/TWILIO/);
    expect(() => loadConfig({ ...base, PUSH_PROVIDER: "fcm" })).toThrow(/FCM/);
  });
});
