import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { loggerOptions, safeLogUrl, serializeRequest } from "../src/logger.js";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { lines.push(JSON.parse(String(chunk))); cb(); } });
  return { logger: pino(loggerOptions("test-service", "production"), stream), lines };
}

describe("safeLogUrl", () => {
  it("drops the query string", () => {
    expect(safeLogUrl("/api/location/nearby?lat=9.0301&lng=38.7469")).toBe("/api/location/nearby?[redacted]");
    expect(safeLogUrl("/socket?token=eyJabc")).toBe("/socket?[redacted]");
    expect(safeLogUrl("/health")).toBe("/health");
  });
  it("masks share tokens in the path", () => {
    expect(safeLogUrl("/api/trips/shared/s3cr3t-token")).toBe("/api/trips/shared/[redacted]");
    expect(safeLogUrl("/api/trips/shared/s3cr3t?x=1")).toBe("/api/trips/shared/[redacted]?[redacted]");
    expect(safeLogUrl("/t/abc123")).toBe("/t/[redacted]");
    expect(safeLogUrl("/api/trips/123/share")).toBe("/api/trips/123/share");
  });
});

describe("serializeRequest", () => {
  it("keeps method, masked url and ip but no headers", () => {
    const out = serializeRequest({ method: "GET", url: "/api/trips/shared/tok?a=b", ip: "10.0.0.1", hostname: "api", headers: { authorization: "Bearer x" } });
    expect(out).toEqual({ method: "GET", url: "/api/trips/shared/[redacted]?[redacted]", host: "api", remoteAddress: "10.0.0.1" });
  });
});

describe("createLogger options", () => {
  it("serializes req through the safe serializer", () => {
    const { logger, lines } = capture();
    logger.info({ req: { method: "GET", url: "/t/abc?lat=1", headers: { cookie: "sid=1" } } }, "incoming request");
    expect(lines[0]!.req).toEqual({ method: "GET", url: "/t/[redacted]?[redacted]" });
  });
  it("redacts secrets at the top level and one level down", () => {
    const { logger, lines } = capture();
    logger.info({ phone: "+251911000000", otp: "123456", password: "pw", body: { token: "t", phone: "+2519" }, headers: { authorization: "Bearer x", cookie: "c" } }, "x");
    const line = lines[0]!;
    expect(line.phone).toBe("[redacted]");
    expect(line.otp).toBe("[redacted]");
    expect(line.password).toBe("[redacted]");
    expect(line.body).toEqual({ token: "[redacted]", phone: "[redacted]" });
    expect(line.headers).toEqual({ authorization: "[redacted]", cookie: "[redacted]" });
  });
  it("keeps error codes readable", () => {
    const { logger, lines } = capture();
    const err = Object.assign(new Error("boom"), { code: "P2002" });
    logger.error({ err }, "failed");
    expect((lines[0]!.err as { code: string }).code).toBe("P2002");
  });
});
