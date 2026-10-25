import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createTokenVerifier, TokenError } from "../src/index.js";

const ISSUER = "https://auth.test";
let privateKey: CryptoKey;
let keySet: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" };
  keySet = createLocalJWKSet({ keys: [jwk] });
});

const sign = (claims: Record<string, unknown>, opts: { aud?: string; iss?: string; exp?: string } = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setSubject("user-1")
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? "ride-app")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "15m")
    .sign(privateKey);

describe("verifyAccessToken", () => {
  it("accepts a valid token and parses roles", async () => {
    const verify = createTokenVerifier({ issuer: ISSUER, keySet });
    const p = await verify(await sign({ roles: [{ r: "RIDER" }, { r: "FLEET_OWNER", org: "o1" }], pv: 2, amr: ["otp"] }), "ride-app");
    expect(p.userId).toBe("user-1");
    expect(p.roles).toEqual([{ role: "RIDER", scope: "SELF" }, { role: "FLEET_OWNER", scope: "ORG", orgId: "o1" }]);
    expect(p.permissionVersion).toBe(2);
  });

  it("rejects the wrong audience, issuer or an expired token", async () => {
    const verify = createTokenVerifier({ issuer: ISSUER, keySet });
    await expect(verify(await sign({}, { aud: "ride-admin" }), "ride-app")).rejects.toBeInstanceOf(TokenError);
    await expect(verify(await sign({}, { iss: "https://evil" }), "ride-app")).rejects.toBeInstanceOf(TokenError);
    await expect(verify(await sign({}, { exp: "-1m" }), "ride-app")).rejects.toBeInstanceOf(TokenError);
  });

  it("rejects an algorithm that isn't pinned (alg confusion)", async () => {
    const verify = createTokenVerifier({ issuer: ISSUER, keySet, algorithms: ["EdDSA"] });
    await expect(verify(await sign({}), "ride-app")).rejects.toBeInstanceOf(TokenError);
  });

  it("rejects suspended users and outdated permission versions", async () => {
    const denied = createTokenVerifier({ issuer: ISSUER, keySet, isDenied: async () => true });
    await expect(denied(await sign({}), "ride-app")).rejects.toMatchObject({ code: "token_revoked" });
    const outdated = createTokenVerifier({ issuer: ISSUER, keySet, currentPermissionVersion: async () => 3 });
    await expect(outdated(await sign({ pv: 2 }), "ride-app")).rejects.toMatchObject({ code: "token_outdated" });
  });

  it("drops staff roles smuggled into an app-audience token", async () => {
    const verify = createTokenVerifier({ issuer: ISSUER, keySet });
    const p = await verify(await sign({ roles: [{ r: "SUPER_ADMIN", g: true }, { r: "RIDER" }] }), "ride-app");
    expect(p.roles).toEqual([{ role: "RIDER", scope: "SELF" }]);
  });
});
