import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { phoneHasher, sealer } from "../../src/lib/crypto.js";
import { reportVerifier } from "../../src/otp/telegram-gateway.js";
import { loadConfig } from "../../src/config/index.js";
import { inviteSms, safeOrgName } from "../../src/notify/templates.js";
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
    expect(inviteSms("Abebe Transport PLC", "fleet_driver")).toBe('Anbessa: "Abebe Transport PLC" invited you to drive with them. Accept in the Anbessa app. Ignore if unexpected.');
    expect(inviteSms("x".repeat(200), "employee").length).toBeLessThanOrEqual(160);
    expect(inviteSms(undefined, "unknown")).toMatch(/^Anbessa: a company invited you to join them/);
    for (const role of ["fleet_driver", "employee", "corporate_coordinator", "corporate_admin", "x"]) {
      expect(inviteSms("w".repeat(500), role).length).toBeLessThanOrEqual(160);
    }
  });

  it("can't be turned into a phishing SMS through the org name", () => {
    const sms = inviteSms('Anbessa Security: your account is locked, call +251 911 223 344 or visit https://anbessa-verify.com/x "', "employee");
    expect(sms.startsWith("Anbessa: \"")).toBe(true);
    expect(sms).not.toMatch(/https?:|anbessa-verify|\.com/);
    expect(sms).not.toMatch(/\d{4}/);
    expect(sms.match(/"/g)).toHaveLength(2); // only our own quotes
  });

  it("sanitises org names", () => {
    expect(safeOrgName("  Abebe   Transport\nPLC ")).toBe("Abebe Transport PLC");
    expect(safeOrgName("Go to bit.ly/abc now")).toBe("Go to now");
    expect(safeOrgName("Pay 1000123456789 today")).toBe("Pay today");
    expect(safeOrgName("Fleet 24")).toBe("Fleet 24"); // short numbers stay
    expect(safeOrgName("https://x.y")).toBeUndefined();
    expect(safeOrgName("a".repeat(100))!.length).toBe(40);
  });
});

describe("config", () => {
  const base = {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://x@localhost/db",
    REDIS_URL: "redis://localhost:6379",
    INTERNAL_SERVICE_TOKEN: "t".repeat(64),
    PHONE_HASH_KEY: "a".repeat(64),
    OTP_ENCRYPTION_KEY: "b".repeat(64),
  };

  it("requires NODE_ENV (no silent development default)", () => {
    const { NODE_ENV: _drop, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/NODE_ENV is required/);
  });

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

describe("campaign maker-checker", () => {
  it("needs a second approver above the threshold, and never the maker", async () => {
    const { needsSecondApprover, canApprove } = await import("../../src/campaigns/service.js");
    expect(needsSecondApprover(1000, 1000)).toBe(false);
    expect(needsSecondApprover(1001, 1000)).toBe(true);
    expect(needsSecondApprover(1, 0)).toBe(true);
    expect(canApprove("a", { createdBy: "a", updatedBy: "b" })).toBe(false);
    expect(canApprove("b", { createdBy: "a", updatedBy: "b" })).toBe(false);
    expect(canApprove("c", { createdBy: "a", updatedBy: "b" })).toBe(true);
  });
});
