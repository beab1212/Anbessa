import { afterEach, describe, expect, it } from "vitest";
import { AxiosError, AxiosHeaders, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { api, ApiError, authCall, authHttp, forgetTokens, http } from "../src/lib/api";

// a JWT whose payload the client can decode (signature unused in the browser)
const jwt = (sub: string) => `x.${btoa(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 600, pv: 1, amr: ["otp"], roles: [] }))}.y`;

function reply(config: InternalAxiosRequestConfig, status: number, data: unknown): Promise<AxiosResponse> {
  const res = { status, statusText: String(status), data, headers: {}, config } as AxiosResponse;
  return status < 400 ? Promise.resolve(res) : Promise.reject(new AxiosError("fail", String(status), config, null, res));
}

const original = { auth: authHttp.defaults.adapter, http: http.defaults.adapter };
afterEach(() => {
  authHttp.defaults.adapter = original.auth;
  http.defaults.adapter = original.http;
  forgetTokens("partner");
});

describe("api client", () => {
  it("sends the surface's bearer token and the idempotency key", async () => {
    authHttp.defaults.adapter = ((c) => reply(c, 200, { token: jwt("u1") })) as AxiosAdapter;
    let seen: AxiosHeaders | undefined;
    http.defaults.adapter = ((c) => {
      seen = c.headers;
      return reply(c, 201, { id: "t1" });
    }) as AxiosAdapter;
    await expect(api("partner", "/api/trips", { body: { a: 1 }, idempotencyKey: "k1" })).resolves.toEqual({ id: "t1" });
    expect(seen?.get("Authorization")).toBe(`Bearer ${jwt("u1")}`);
    expect(seen?.get("Idempotency-Key")).toBe("k1");
  });

  it("refreshes the token once after a 401, then gives up", async () => {
    let tokens = 0;
    authHttp.defaults.adapter = ((c) => reply(c, 200, { token: jwt(`u${++tokens}`) })) as AxiosAdapter;
    let calls = 0;
    http.defaults.adapter = ((c) => (++calls === 1 ? reply(c, 401, {}) : reply(c, 200, { ok: true }))) as AxiosAdapter;
    await expect(api("partner", "/api/x")).resolves.toEqual({ ok: true });
    expect([tokens, calls]).toEqual([2, 2]);

    http.defaults.adapter = ((c) => reply(c, 401, {})) as AxiosAdapter;
    await expect(api("partner", "/api/x")).rejects.toMatchObject({ status: 401, code: "signed_out" });
  });

  it("turns failures into ApiError with the server's message", async () => {
    authHttp.defaults.adapter = ((c) => reply(c, 409, { code: "conflict", message: "Already exists" })) as AxiosAdapter;
    const err = await authCall("partner", "/organization/create", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "conflict", message: "Already exists" });

    authHttp.defaults.adapter = (() => Promise.reject(new AxiosError("Network Error", "ERR_NETWORK"))) as AxiosAdapter;
    await expect(authCall("partner", "/token")).rejects.toMatchObject({ status: 0, code: "network" });
  });

  it("treats a missing session as signed out", async () => {
    authHttp.defaults.adapter = ((c) => reply(c, 401, {})) as AxiosAdapter;
    await expect(api("partner", "/api/x")).rejects.toMatchObject({ status: 401, code: "signed_out" });
  });
});
