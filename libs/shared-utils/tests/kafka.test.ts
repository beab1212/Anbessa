import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kafkaClientConfig, kafkaSecurityFromEnv } from "../src/kafka.js";

const base = { clientId: "trip-service", brokers: ["kafka:9092"] };

describe("kafkaClientConfig", () => {
  it("is plaintext with no env (development)", () => {
    expect(kafkaClientConfig(base, { NODE_ENV: "development" })).toEqual(base);
  });
  it("adds TLS and SCRAM from env", () => {
    const cfg = kafkaClientConfig(base, { NODE_ENV: "production", KAFKA_SSL: "on", KAFKA_SASL_MECHANISM: "SCRAM-SHA-512", KAFKA_SASL_USERNAME: "trip-service", KAFKA_SASL_PASSWORD: "pw" });
    expect(cfg.ssl).toBe(true);
    expect(cfg.sasl).toEqual({ mechanism: "scram-sha-512", username: "trip-service", password: "pw" });
    expect(cfg.clientId).toBe("trip-service");
  });
  it("reads a CA bundle and turns TLS on", () => {
    const dir = mkdtempSync(join(tmpdir(), "kafka-ca-"));
    const ca = join(dir, "ca.pem");
    writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n");
    expect(kafkaSecurityFromEnv({ KAFKA_SSL_CA: ca }).ssl).toEqual({ ca: [expect.stringContaining("BEGIN CERTIFICATE")] });
    expect(() => kafkaSecurityFromEnv({ KAFKA_SSL_CA: join(dir, "missing.pem") })).toThrow(/KAFKA_SSL_CA/);
  });
  it("requires TLS and SASL in production", () => {
    expect(() => kafkaSecurityFromEnv({ NODE_ENV: "production" })).toThrow(/KAFKA_SSL=on and KAFKA_SASL_MECHANISM/);
    expect(() => kafkaSecurityFromEnv({ NODE_ENV: "production", KAFKA_SSL: "on" })).toThrow(/KAFKA_SASL_MECHANISM/);
    expect(() => kafkaSecurityFromEnv({ NODE_ENV: "production", KAFKA_SASL_MECHANISM: "plain", KAFKA_SASL_USERNAME: "u", KAFKA_SASL_PASSWORD: "p" })).toThrow(/KAFKA_SSL=on/);
  });
  it("rejects incomplete or unknown settings", () => {
    expect(() => kafkaSecurityFromEnv({ KAFKA_SASL_MECHANISM: "gssapi", KAFKA_SASL_USERNAME: "u", KAFKA_SASL_PASSWORD: "p" })).toThrow(/one of/);
    expect(() => kafkaSecurityFromEnv({ KAFKA_SASL_MECHANISM: "plain", KAFKA_SASL_USERNAME: "u" })).toThrow(/PASSWORD/);
    expect(() => kafkaSecurityFromEnv({ KAFKA_SASL_USERNAME: "u", KAFKA_SASL_PASSWORD: "p" })).toThrow(/MECHANISM is not/);
    expect(() => kafkaSecurityFromEnv({ KAFKA_SSL: "maybe" })).toThrow(/on or off/);
  });
});
