// The permission matrix in the auth database: seeded from libs/shared-authz the first time,
// then read by every service as a snapshot (GET /internal/authz/snapshot).

import { builtInSnapshot, type AuthzSnapshot, type RoleInfo, type ScopeLetter } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";

type Tx = Prisma.TransactionClient | Db;

/** First start (or a fresh database): copy the built-in roles and matrix in. Later code additions come with migrations. */
export async function ensureAuthzSeeded(db: Db): Promise<boolean> {
  if ((await db.roleDefinition.count()) > 0) return false;
  const seed = builtInSnapshot();
  await db.$transaction(async (tx) => {
    for (const r of seed.roles) {
      await tx.roleDefinition.create({
        data: {
          code: r.code, label: r.label, audience: r.audience, storageType: r.storage.type,
          orgKinds: r.storage.type === "member" ? [...r.storage.orgKinds] : [], stored: r.stored, builtIn: true,
        },
      });
    }
    await tx.rolePermission.createMany({
      data: Object.entries(seed.matrix).flatMap(([roleCode, grants]) => Object.entries(grants).map(([permission, scope]) => ({ roleCode, permission, scope: scope! }))),
    });
    await tx.authzVersion.upsert({ where: { id: 1 }, update: { version: { increment: 1 } }, create: { id: 1, version: 1 } });
  });
  return true;
}

export async function loadAuthzSnapshot(db: Tx): Promise<AuthzSnapshot> {
  const [roles, perms, version] = await Promise.all([
    db.roleDefinition.findMany({ orderBy: [{ builtIn: "desc" }, { code: "asc" }] }),
    db.rolePermission.findMany(),
    db.authzVersion.findUnique({ where: { id: 1 } }),
  ]);
  const matrix: AuthzSnapshot["matrix"] = Object.fromEntries(roles.map((r) => [r.code, {}]));
  for (const p of perms) (matrix[p.roleCode] as Record<string, ScopeLetter>)[p.permission] = p.scope as ScopeLetter;
  return {
    version: version?.version ?? 0,
    roles: roles.map((r): RoleInfo => ({
      code: r.code, label: r.label, ...(r.description ? { description: r.description } : {}),
      audience: r.audience as RoleInfo["audience"],
      storage: r.storageType === "member" ? { type: "member", orgKinds: r.orgKinds as never } : { type: "user" },
      stored: r.stored, builtIn: r.builtIn, ...(r.archived ? { archived: true } : {}),
    })),
    matrix,
  };
}
