import { describe, expect, it } from "vitest";
import { isAllowed } from "../../src/auth/allowlist.js";
import { DEV_TRUSTED_PROXIES, isIpOrCidr, loadConfig } from "../../src/config/index.js";

describe("endpoint allowlist", () => {
  it.each([
    ["app", "POST", "/phone-number/send-otp"],
    ["app", "GET", "/token"],
    ["app", "GET", "/jwks"],
    ["admin", "POST", "/sign-in/email"],
    ["admin", "POST", "/two-factor/verify-totp"],
    ["admin", "POST", "/two-factor/verify-backup-code"],
    ["admin", "POST", "/two-factor/generate-backup-codes"],
    ["admin", "POST", "/update-user"],
    ["admin", "GET", "/list-sessions"],
  ] as const)("%s allows %s %s", (surface, method, path) => {
    expect(isAllowed(surface, method, path)).toBe(true);
  });

  it.each([
    ["app", "POST", "/admin/set-role"],
    ["app", "POST", "/admin/impersonate-user"],
    ["app", "POST", "/sign-in/email"],
    ["app", "POST", "/sign-up/email"],
    ["app", "POST", "/organization/delete"],
    ["app", "POST", "/organization/leave"],
    ["admin", "POST", "/sign-up/email"],
    ["admin", "POST", "/two-factor/disable"],
    ["admin", "POST", "/admin/set-role"],
    ["admin", "POST", "/phone-number/send-otp"],
    ["app", "GET", "/phone-number/send-otp"], // wrong method
    ["app", "GET", "/token/"], // no normalization tricks
    ["app", "GET", "/organization/../admin/list-users"],
  ] as const)("%s blocks %s %s", (surface, method, path) => {
    expect(isAllowed(surface, method, path)).toBe(false);
  });
});

describe("config", () => {
  const base = {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://x@localhost/db",
    BETTER_AUTH_SECRET: "a".repeat(64),
    AUTH_BASE_URL: "http://localhost:3001",
  };

  it("treats blank values as unset and derives the issuer", () => {
    const c = loadConfig({ ...base, REDIS_URL: "", KAFKA_BROKERS: "a:9092, b:9092" });
    expect(c.REDIS_URL).toBeUndefined();
    expect(c.KAFKA_BROKERS).toEqual(["a:9092", "b:9092"]);
    expect(c.AUTH_ISSUER).toBe("http://localhost:3001");
  });

  it("rejects a short secret", () => {
    expect(() => loadConfig({ ...base, BETTER_AUTH_SECRET: "short" })).toThrow();
  });

  it("refuses insecure production settings", () => {
    const err = (() => {
      try {
        loadConfig({ ...base, NODE_ENV: "production", OTP_DELIVERY: "console", AUTH_RATE_LIMIT: "off", DEV_LOGIN: "on" });
      } catch (e) {
        return String(e);
      }
    })();
    for (const key of ["OTP_DELIVERY", "REDIS_URL", "KAFKA_BROKERS", "INTERNAL_SERVICE_TOKEN", "AUTH_RATE_LIMIT", "AUTH_BASE_URL", "DEV_LOGIN", "TRUSTED_PROXIES"]) {
      expect(err).toContain(key);
    }
  });

  it("requires notification-service settings for real OTP delivery", () => {
    expect(() => loadConfig({ ...base, OTP_DELIVERY: "notification" })).toThrow(/NOTIFICATION_INTERNAL_URL/);
  });

  it("keeps development sign-in off unless asked, and only with console OTPs", () => {
    expect(loadConfig(base).DEV_LOGIN).toBe("off");
    expect(loadConfig({ ...base, DEV_LOGIN: "on" }).DEV_LOGIN).toBe("on");
    expect(() =>
      loadConfig({ ...base, DEV_LOGIN: "on", OTP_DELIVERY: "notification", NOTIFICATION_INTERNAL_URL: "http://n:3006", INTERNAL_SERVICE_TOKEN: "t".repeat(32) }),
    ).toThrow(/DEV_LOGIN/);
  });

  describe("TRUSTED_PROXIES", () => {
    const prod = {
      ...base, NODE_ENV: "production", AUTH_BASE_URL: "https://api.example.et", OTP_DELIVERY: "notification",
      NOTIFICATION_INTERNAL_URL: "http://n:3006", INTERNAL_SERVICE_TOKEN: "t".repeat(32), REDIS_URL: "redis://r:6379", KAFKA_BROKERS: "k:9092",
    };

    it("defaults to loopback and private ranges outside production", () => {
      expect(loadConfig(base).TRUSTED_PROXIES).toEqual(DEV_TRUSTED_PROXIES);
    });

    it("is required in production and parsed as a list", () => {
      expect(() => loadConfig(prod)).toThrow(/TRUSTED_PROXIES/);
      expect(loadConfig({ ...prod, TRUSTED_PROXIES: "10.42.0.0/16, 172.20.0.5" }).TRUSTED_PROXIES).toEqual(["10.42.0.0/16", "172.20.0.5"]);
    });

    it("refuses entries that aren't an IP or CIDR range", () => {
      expect(() => loadConfig({ ...base, TRUSTED_PROXIES: "10.0.0.0/8,kong" })).toThrow(/kong/);
      expect(() => loadConfig({ ...base, TRUSTED_PROXIES: "10.0.0.0/33" })).toThrow(/TRUSTED_PROXIES/);
    });

    it.each([
      ["10.0.0.0/8", true], ["203.0.113.7", true], ["::1/128", true], ["fc00::/7", true],
      ["10.0.0.0/", false], ["10.0.0.0/8/1", false], ["1.2.3.4/x", false], ["::/129", false], ["", false], ["localhost", false],
    ] as const)("isIpOrCidr(%j) = %s", (value, ok) => {
      expect(isIpOrCidr(value)).toBe(ok);
    });
  });
});
