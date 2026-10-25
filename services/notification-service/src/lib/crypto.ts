import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/** HMAC-SHA256 of an E.164 number: lets us find recent attempts for a phone without storing it. */
export function phoneHasher(hexKey: string) {
  const key = Buffer.from(hexKey, "hex");
  // a plain Uint8Array (not a pooled Buffer): the type Prisma uses for bytea
  return (phone: string): Uint8Array<ArrayBuffer> => new Uint8Array(createHmac("sha256", key).update(phone).digest());
}

/** AES-256-GCM for short secrets kept in Redis (the OTP copy used by the SMS fallback). */
export function sealer(hexKey: string) {
  const key = Buffer.from(hexKey, "hex");
  return {
    seal(plain: string, aad: string): string {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(Buffer.from(aad));
      const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
    },
    /** Throws if the value was tampered with or sealed for another `aad`. */
    open(sealed: string, aad: string): string {
      const raw = Buffer.from(sealed, "base64");
      const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
    },
  };
}

export type Sealer = ReturnType<typeof sealer>;

export function maskPhone(phone: string): string {
  return phone.length > 7 ? `${phone.slice(0, 5)}••••${phone.slice(-3)}` : "•••";
}
