import { describe, expect, it } from "vitest";
import { trustProxyFromEnv, type TrustProxyFn } from "../src/proxy.js";

const hopsOf = (v: string | undefined) => (trustProxyFromEnv(v) as TrustProxyFn).hops;

describe("trustProxyFromEnv", () => {
  it("defaults to one hop (Kong)", () => {
    expect(hopsOf(undefined)).toBe(1);
    expect(hopsOf("  ")).toBe(1);
    const fn = trustProxyFromEnv(undefined) as TrustProxyFn;
    expect(fn("10.0.0.5", 0)).toBe(true); // Kong, the socket peer
    expect(fn("6.6.6.6", 1)).toBe(false); // whatever the client wrote into X-Forwarded-For
  });
  it("accepts hop counts", () => {
    expect(hopsOf("2")).toBe(2);
    expect(hopsOf("0")).toBe(0);
    expect(hopsOf("false")).toBe(0);
  });
  it("accepts CIDR lists and proxy-addr keywords", () => {
    expect(trustProxyFromEnv("10.0.0.0/8, 172.16.0.0/12,loopback")).toEqual(["10.0.0.0/8", "172.16.0.0/12", "loopback"]);
    expect(trustProxyFromEnv("fd00::/8")).toEqual(["fd00::/8"]);
  });
  it("never trusts every hop", () => {
    expect(() => trustProxyFromEnv("true")).toThrow(/X-Forwarded-For/);
    expect(() => trustProxyFromEnv("*")).toThrow();
  });
  it("rejects garbage", () => {
    expect(() => trustProxyFromEnv("kong.internal")).toThrow(/not a hop count/);
  });
});
