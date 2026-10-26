// The write-once audit log: insert (idempotent per event), search, export.

import { z } from "zod";
import { authorize, type Principal } from "@ride-app/shared-authz";
import type { Db } from "./db.js";
import { Prisma } from "./generated/prisma/client.js";

/** What every service writes on `audit.recorded` (their outbox.ts `audit()`). */
export const auditEvent = z.object({
  eventId: z.string().uuid(),
  at: z.string().datetime({ offset: true }),
  actorId: z.string().uuid().nullable(),
  action: z.string().min(1).max(80),
  resource: z.object({ type: z.string().min(1).max(60), id: z.string().min(1).max(200) }),
  outcome: z.enum(["ALLOWED", "DENIED", "PENDING_APPROVAL", "EXECUTED"]),
  reason: z.string().max(2000).optional(),
  onBehalfOf: z.string().uuid().optional(),
  service: z.string().max(60).optional(),
});
export type AuditEvent = z.infer<typeof auditEvent>;

export interface AuditQuery {
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  outcome?: string;
  service?: string;
  from?: Date;
  to?: Date;
  /** "at|eventId" of the last row seen */
  cursor?: string;
  limit: number;
}

export function createAuditStore(db: Db) {
  async function insert(e: AuditEvent): Promise<boolean> {
    const n = await db.$executeRaw`
      INSERT INTO audit_entry (event_id, at, actor_id, action, resource_type, resource_id, outcome, reason, on_behalf_of, service)
      VALUES (${e.eventId}::uuid, ${new Date(e.at)}, ${e.actorId}::uuid, ${e.action}, ${e.resource.type}, ${e.resource.id}, ${e.outcome},
              ${e.reason ?? null}, ${e.onBehalfOf ?? null}::uuid, ${e.service ?? null})
      ON CONFLICT (at, event_id) DO NOTHING`;
    return n === 1;
  }

  function where(q: AuditQuery): Prisma.AuditEntryWhereInput {
    const [cursorAt, cursorId] = q.cursor?.split("|") ?? [];
    return {
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.resourceType ? { resourceType: q.resourceType } : {}),
      ...(q.resourceId ? { resourceId: q.resourceId } : {}),
      ...(q.outcome ? { outcome: q.outcome } : {}),
      ...(q.service ? { service: q.service } : {}),
      ...(q.from || q.to ? { at: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      ...(cursorAt && cursorId ? { OR: [{ at: { lt: new Date(cursorAt) } }, { at: new Date(cursorAt), eventId: { lt: cursorId } }] } : {}),
    };
  }

  return {
    insert,

    async search(p: Principal, q: AuditQuery) {
      authorize(p, "audit_log:read");
      const rows = await db.auditEntry.findMany({ where: where(q), orderBy: [{ at: "desc" }, { eventId: "desc" }], take: q.limit });
      const last = rows.at(-1);
      return { entries: rows, next: rows.length === q.limit && last ? `${last.at.toISOString()}|${last.eventId}` : null };
    },

    /** CSV export (max 50 000 rows). The export itself is recorded. */
    async exportCsv(p: Principal, q: Omit<AuditQuery, "limit" | "cursor">) {
      authorize(p, "audit_log:read");
      const rows = await db.auditEntry.findMany({ where: where({ ...q, limit: 50_000 }), orderBy: [{ at: "desc" }, { eventId: "desc" }], take: 50_000 });
      await insert({
        eventId: crypto.randomUUID(), at: new Date().toISOString(), actorId: p.userId, action: "audit_log:export",
        resource: { type: "audit_log", id: "export" }, outcome: "EXECUTED", reason: `${rows.length} rows · ${JSON.stringify(q)}`, service: "audit-service",
      });
      const cell = (v: unknown) => {
        const s = v instanceof Date ? v.toISOString() : v === null || v === undefined ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = ["at", "service", "actor_id", "action", "resource_type", "resource_id", "outcome", "reason", "on_behalf_of", "event_id"];
      const lines = rows.map((r) => [r.at, r.service, r.actorId, r.action, r.resourceType, r.resourceId, r.outcome, r.reason, r.onBehalfOf, r.eventId].map(cell).join(","));
      return [header.join(","), ...lines].join("\n") + "\n";
    },
  };
}

export type AuditStore = ReturnType<typeof createAuditStore>;
