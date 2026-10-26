// Development accounts for the web app's dev sign-in (see ./accounts.ts).
//
//   pnpm --filter @ride-app/auth-service seed:dev
//
// Refuses to run unless NODE_ENV=development. Safe to run again: it puts every account back to
// its listed state (password, authenticator, roles, organisations). Roles are written directly,
// skipping maker–checker, which is why this never runs anywhere else.

import { symmetricEncrypt } from "better-auth/crypto";
import { v7 as uuidv7 } from "uuid";
import { ROLES } from "@ride-app/shared-authz";
import { loadConfig } from "../config/index.js";
import { createDb, type Db } from "../db.js";
import { passwordHasher, phoneToEmail } from "../auth/password.js";
import { joinRoles } from "../auth/roles-codec.js";
import { writeOutbox } from "../outbox/outbox.js";
import { DEV_ACCOUNTS, DEV_CITY, DEV_ORGS, DEV_PASSWORD, DEV_TOTP_SECRET, type DevPartner, type DevStaff } from "./accounts.js";

type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

async function upsertUser(tx: Tx, email: string, data: { name: string; role: string; phoneNumber?: string; twoFactorEnabled: boolean }) {
  const fields = {
    name: data.name,
    emailVerified: true,
    role: data.role,
    phoneNumber: data.phoneNumber ?? null,
    phoneNumberVerified: data.phoneNumber ? true : null,
    twoFactorEnabled: data.twoFactorEnabled,
    mustChangePassword: false,
    accountStatus: "ACTIVE",
    banned: false,
    banReason: null,
  };
  const existing = await tx.user.findUnique({ where: { email } });
  if (existing) {
    // a new permission version makes open sessions pick up the roles below
    return tx.user.update({ where: { id: existing.id }, data: { ...fields, permissionVersion: { increment: 1 } } });
  }
  const u = await tx.user.create({ data: { id: uuidv7(), email, ...fields, permissionVersion: 1 } });
  await writeOutbox(tx, { topic: "user.created", key: u.id, payload: { userId: u.id, guest: false } });
  return u;
}

/** Replaces the user's roles in one organisation (removes the membership when there are none). */
async function setMemberRoles(tx: Tx, organizationId: string, userId: string, roles: string[]) {
  const member = await tx.member.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
  if (roles.length === 0) {
    if (member) await tx.member.delete({ where: { id: member.id } });
  } else if (member) {
    await tx.member.update({ where: { id: member.id }, data: { role: joinRoles(roles) } });
  } else {
    await tx.member.create({ data: { id: uuidv7(), organizationId, userId, role: joinRoles(roles), createdAt: new Date() } });
  }
}

async function seedStaff(tx: Tx, a: DevStaff, secret: string, hash: string, staffOrgId: string) {
  const global = a.roles.filter((r) => ROLES[r].storage.type === "user").map((r) => ROLES[r].stored);
  const city = a.roles.filter((r) => ROLES[r].storage.type === "member").map((r) => ROLES[r].stored);
  const u = await upsertUser(tx, a.email, { name: a.name, role: joinRoles(global), twoFactorEnabled: true });

  const account = await tx.account.findFirst({ where: { userId: u.id, providerId: "credential" } });
  if (account) await tx.account.update({ where: { id: account.id }, data: { password: hash } });
  else await tx.account.create({ data: { id: uuidv7(), accountId: u.id, providerId: "credential", userId: u.id, password: hash } });

  // the authenticator, stored exactly as Better Auth's two-factor plugin stores it
  await tx.twoFactor.deleteMany({ where: { userId: u.id } });
  await tx.twoFactor.create({
    data: { id: uuidv7(), userId: u.id, secret: await symmetricEncrypt({ key: secret, data: DEV_TOTP_SECRET }), backupCodes: "[]", verified: true },
  });

  await setMemberRoles(tx, staffOrgId, u.id, city);
}

async function seedPartner(tx: Tx, a: DevPartner, orgIds: Map<string, string>) {
  const u = await upsertUser(tx, phoneToEmail(a.phone), { name: a.name, role: ROLES.RIDER.stored, phoneNumber: a.phone, twoFactorEnabled: false });
  for (const [slug, orgId] of orgIds) {
    await setMemberRoles(tx, orgId, u.id, a.memberships.filter((m) => m.org === slug).map((m) => ROLES[m.role].stored));
  }
}

async function main() {
  const config = loadConfig();
  if (config.NODE_ENV !== "development") throw new Error(`seed:dev only runs with NODE_ENV=development (got ${config.NODE_ENV})`);
  if (config.AUTH_BASE_URL.startsWith("https://")) throw new Error("seed:dev refuses an https AUTH_BASE_URL: this looks like a real environment");

  const db = createDb(config.DATABASE_URL);
  try {
    const hash = await passwordHasher.hash(DEV_PASSWORD);
    await db.$transaction(async (tx) => {
      const staffOrg = await tx.organization.findFirst({ where: { kind: "STAFF_CITY", cityId: DEV_CITY } });
      if (!staffOrg) throw new Error(`no staff organisation for ${DEV_CITY}: run the migrations first`);

      const orgIds = new Map<string, string>();
      for (const o of DEV_ORGS) {
        const data = { name: o.name, kind: o.kind, cityId: DEV_CITY, legalName: o.legalName, tin: o.tin, status: "VERIFIED" };
        const org = await tx.organization.upsert({
          where: { slug: o.slug },
          update: data,
          create: { id: uuidv7(), slug: o.slug, createdAt: new Date(), ...data },
        });
        orgIds.set(o.slug, org.id);
      }

      for (const a of DEV_ACCOUNTS) {
        if (a.surface === "staff") await seedStaff(tx, a, config.BETTER_AUTH_SECRET, hash, staffOrg.id);
        else await seedPartner(tx, a, orgIds);
      }
    }, { timeout: 30_000 });
  } finally {
    await db.$disconnect();
  }

  const rows = DEV_ACCOUNTS.map((a) => `  ${(a.surface === "staff" ? a.email : a.phone).padEnd(40)} ${a.label}`);
  process.stdout.write(
    `dev accounts ready (staff password: ${DEV_PASSWORD})\n${rows.join("\n")}\n` +
      "Sign in from the web app's dev panel (DEV_LOGIN=on), or by hand: staff codes from GET /api/dev/code?email=…,\n" +
      "partner codes from the auth-service log.\n",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
