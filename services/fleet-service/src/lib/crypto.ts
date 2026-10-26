// Application-level protection for licence numbers (Database.md §17) and the HMAC-signed
// tickets used for uploads and local file URLs.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface PiiCrypto {
  encrypt(plain: string): Uint8Array<ArrayBuffer>;
  decrypt(blob: Uint8Array): string;
  /** Deterministic lookup key: the same licence always gives the same hash. */
  blindIndex(value: string): Uint8Array<ArrayBuffer>;
}

/** Licence numbers are compared without spaces, dashes or case. */
export const normalizeLicence = (v: string) => v.replace(/[\s-]/g, "").toUpperCase();

export function piiCrypto(encryptionKeyHex: string, blindIndexKeyHex: string): PiiCrypto {
  const key = Buffer.from(encryptionKeyHex, "hex");
  const indexKey = Buffer.from(blindIndexKeyHex, "hex");
  return {
    encrypt(plain) {
      // layout: version (1) · iv (12) · tag (16) · ciphertext
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return new Uint8Array(Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]));
    },
    decrypt(blob) {
      const b = Buffer.from(blob);
      if (b[0] !== 1) throw new Error("unknown ciphertext version");
      const d = createDecipheriv("aes-256-gcm", key, b.subarray(1, 13));
      d.setAuthTag(b.subarray(13, 29));
      return Buffer.concat([d.update(b.subarray(29)), d.final()]).toString("utf8");
    },
    blindIndex(value) {
      return new Uint8Array(createHmac("sha256", indexKey).update(normalizeLicence(value)).digest());
    },
  };
}

export interface Signer {
  sign<T extends object>(data: T, ttlSeconds: number): string;
  /** The data, or null when the signature is wrong or the ticket expired. */
  verify<T extends object>(token: string): T | null;
}

/** Compact signed tickets: base64url(JSON {d, exp}) "." base64url(HMAC-SHA256). */
export function signer(keyHex: string, now: () => number = Date.now): Signer {
  const key = Buffer.from(keyHex, "hex");
  const mac = (s: string) => createHmac("sha256", key).update(s).digest("base64url");
  return {
    sign(data, ttlSeconds) {
      const body = Buffer.from(JSON.stringify({ d: data, exp: Math.floor(now() / 1000) + ttlSeconds })).toString("base64url");
      return `${body}.${mac(body)}`;
    },
    verify<T extends object>(token: string) {
      const [body, sig] = token.split(".");
      if (!body || !sig) return null;
      const expected = Buffer.from(mac(body));
      const given = Buffer.from(sig);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      try {
        const { d, exp } = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { d: T; exp: number };
        return exp * 1000 > now() ? d : null;
      } catch {
        return null;
      }
    },
  };
}
