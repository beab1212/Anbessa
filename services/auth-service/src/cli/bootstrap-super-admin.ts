// Break-glass bootstrap for the first super admins (Auth.md §9.4).
//
//   pnpm --filter @ride-app/auth-service bootstrap:super-admin -- --email a@x.et --name "Abebe K."
//
// Works only while fewer than two super admins exist. After that, staff roles are
// granted through maker–checker only. It prints a one-time temporary password; the
// account can't use staff roles until it changes the password and enrols TOTP.

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { v7 as uuidv7 } from "uuid";
import { ROLES } from "@ride-app/shared-authz";
import { loadConfig } from "../config/index.js";
import { createDb } from "../db.js";
import { passwordHasher } from "../auth/password.js";
import { audit, writeOutbox } from "../outbox/outbox.js";

const SUPER = ROLES.SUPER_ADMIN.stored;

async function main() {
  const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" } } });
  const email = values.email?.trim().toLowerCase();
  const name = values.name?.trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) {
    throw new Error('usage: bootstrap:super-admin --email <email> --name "<full name>"');
  }

  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  try {
    const temporaryPassword = randomBytes(18).toString("base64url");
    const hash = await passwordHasher.hash(temporaryPassword);
    const userId = await db.$transaction(async (tx) => {
      // serialize concurrent bootstraps
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bootstrap-super-admin'))`;
      const supers = await tx.user.count({ where: { role: { contains: SUPER } } });
      if (supers >= 2) throw new Error("two super admins already exist; use the maker–checker flow instead");
      if (await tx.user.findUnique({ where: { email } })) throw new Error("a user with this email already exists");

      const u = await tx.user.create({
        data: { id: uuidv7(), name, email, emailVerified: true, role: SUPER, mustChangePassword: true, permissionVersion: 1 },
      });
      await tx.account.create({ data: { id: uuidv7(), accountId: u.id, providerId: "credential", userId: u.id, password: hash } });
      await writeOutbox(tx,
        { topic: "user.created", key: u.id, payload: { userId: u.id, guest: false } },
        { topic: "role.granted", key: u.id, payload: { userId: u.id, role: "SUPER_ADMIN", byUserId: null } },
        audit({ actorId: null, action: "staff:bootstrap_super_admin", resource: { type: "user", id: u.id }, outcome: "EXECUTED" }),
      );
      return u.id;
    });

    process.stdout.write(
      `super admin created\n  userId:             ${userId}\n  email:              ${email}\n  temporary password: ${temporaryPassword}\n` +
        "Sign in to the staff dashboard, change the password and enrol TOTP. This password is not shown again.\n",
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
