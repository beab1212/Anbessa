import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createVerifier } from "../../src/lib/auth.js";

const ISSUER = "http://localhost:3001";

describe("token verifier (Auth.md §9.5)", async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" };
  const sign = (sub: string, pv: number) =>
    new SignJWT({ roles: [{ r: "RIDER" }], pv, amr: ["otp"] }).setProtectedHeader({ alg: "ES256", kid: "k" })
      .setSubject(sub).setIssuer(ISSUER).setAudience("ride-app").setIssuedAt().setExpirationTime("15m").sign(privateKey);
  const store = new Map<string, string>();
  const redis = {
    exists: async (k: string) => (store.has(k) ? 1 : 0),
    get: async (k: string) => store.get(k) ?? null,
  };
  const verify = createVerifier({ issuer: ISSUER, keySet: createLocalJWKSet({ keys: [jwk as never] }) }, redis as never);

  it("accepts a normal token", async () => {
    await expect(verify(await sign("u1", 0), "ride-app")).resolves.toMatchObject({ userId: "u1" });
  });
  it("refuses a suspended user's token", async () => {
    store.set("deny:u2", "1");
    await expect(verify(await sign("u2", 0), "ride-app")).rejects.toMatchObject({ code: "token_revoked" });
  });
  it("refuses a token older than the user's last role change", async () => {
    store.set("pv:u3", "2");
    await expect(verify(await sign("u3", 1), "ride-app")).rejects.toMatchObject({ code: "token_outdated" });
    await expect(verify(await sign("u3", 2), "ride-app")).resolves.toMatchObject({ userId: "u3" });
  });
  it("answers 503 when Redis can't be read", async () => {
    const down = createVerifier({ issuer: ISSUER, keySet: createLocalJWKSet({ keys: [jwk as never] }) }, {
      exists: async () => { throw new Error("redis down"); }, get: async () => null,
    } as never);
    await expect(down(await sign("u4", 0), "ride-app")).rejects.toMatchObject({ code: "auth_unavailable" });
  });
});
