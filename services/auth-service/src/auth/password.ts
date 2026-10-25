import argon2 from "argon2";

// Staff passwords: argon2id (Auth.md S8). Existing hashes from the previous
// hand-written schema are argon2id too, so they keep working after migration.

export const passwordHasher = {
  hash: (password: string) => argon2.hash(password, { type: argon2.argon2id }),
  verify: async ({ hash, password }: { hash: string; password: string }) => {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  },
};

export const ETHIOPIAN_MOBILE = /^\+251[79]\d{8}$/;

/** Deterministic placeholder email for phone-only users (Better Auth requires an email). */
export const PHONE_EMAIL_DOMAIN = "phone.anbessa.invalid";

export function phoneToEmail(phoneNumber: string): string {
  return `${phoneNumber.replace(/^\+/, "")}@${PHONE_EMAIL_DOMAIN}`;
}

export function emailToPhone(email: string): string | undefined {
  const m = new RegExp(`^(\\d+)@${PHONE_EMAIL_DOMAIN.replace(/\./g, "\\.")}$`).exec(email);
  return m ? `+${m[1]}` : undefined;
}
