import type { FastifyInstance, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import type { Db } from "../db.js";
import { isAllowed } from "../auth/allowlist.js";

interface Handler {
  handler: (request: Request) => Promise<Response>;
}

const NOT_FOUND = { error: "not_found", message: "Not found" };

/** Collect organization references from query and JSON body (Better Auth org endpoints). */
function referencedOrganization(req: FastifyRequest): { id?: string; slug?: string } {
  const q = (req.query ?? {}) as Record<string, unknown>;
  const b = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : typeof q[k] === "string" ? (q[k] as string) : undefined);
  return { id: pick("organizationId"), slug: pick("organizationSlug") };
}

/**
 * Mount a Better Auth instance under `prefix`, serving only allowlisted endpoints.
 * On the app surface, organization endpoints may never target staff organizations.
 */
export function mountBetterAuth(app: FastifyInstance, auth: Handler, opts: { prefix: string; surface: "app" | "admin"; db: Db }) {
  app.route({
    method: ["GET", "POST"],
    url: `${opts.prefix}/*`,
    config: { rateLimit: false }, // Better Auth applies its own, per-endpoint limits
    async handler(request, reply) {
      const path = request.url.split("?")[0]!.slice(opts.prefix.length) || "/";
      if (!isAllowed(opts.surface, request.method, path)) return reply.status(404).send(NOT_FOUND);

      // Changing the phone number of an existing account is a support flow, not self-service:
      // the phone is the identity (and the invitation address is derived from it).
      if (path === "/phone-number/verify" && (request.body as { updatePhoneNumber?: unknown } | undefined)?.updatePhoneNumber) {
        return reply.status(400).send({ error: "bad_request", message: "changing the phone number is not supported" });
      }

      if (opts.surface === "app" && path.startsWith("/organization/")) {
        const ref = referencedOrganization(request);
        if (ref.id || ref.slug) {
          const org = await opts.db.organization.findFirst({
            where: ref.id ? { id: ref.id } : { slug: ref.slug },
            select: { kind: true },
          }).catch(() => null);
          if (org && (org.kind === "STAFF_CITY" || org.kind === "STAFF_HQ")) return reply.status(404).send(NOT_FOUND);
        }
      }

      const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
      const req = new Request(url.toString(), {
        method: request.method,
        headers: fromNodeHeaders(request.headers),
        ...(request.body !== undefined && request.method !== "GET" ? { body: JSON.stringify(request.body) } : {}),
      });
      const res = await auth.handler(req);

      reply.status(res.status);
      for (const [key, value] of res.headers) {
        if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
      }
      const cookies = res.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);
      return reply.send(res.body ? await res.text() : null);
    },
  });
}
