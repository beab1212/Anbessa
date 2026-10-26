// Development sign-in (DEV_LOGIN=on only; config refuses it in production and Kong has no
// /api/dev route). The web app's dev panel lists the `seed:dev` accounts and signs in through
// the normal Better Auth endpoints, asking here for the code a person would read from their
// authenticator app or SMS.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { DEV_ACCOUNTS, DEV_ORGS, DEV_PASSWORD, devTotp, type OtpInbox } from "../dev/accounts.js";
import { phoneToEmail } from "../auth/password.js";

export function registerDevRoutes(app: FastifyInstance, deps: { db: Db; inbox: OtpInbox }) {
  app.get("/api/dev/accounts", async () => {
    const emails = DEV_ACCOUNTS.map((a) => (a.surface === "staff" ? a.email : phoneToEmail(a.phone)));
    const users = new Map((await deps.db.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true } })).map((u) => [u.email, u.id]));
    const orgs = await deps.db.organization.findMany({ where: { slug: { in: DEV_ORGS.map((o) => o.slug) } }, select: { id: true, slug: true } });
    return {
      accounts: DEV_ACCOUNTS.map((a) =>
        a.surface === "staff"
          ? { key: a.key, surface: a.surface, name: a.name, label: a.label, email: a.email, password: DEV_PASSWORD, userId: users.get(a.email) ?? null, seeded: users.has(a.email) }
          : { key: a.key, surface: a.surface, app: a.app ?? "web", name: a.name, label: a.label, phone: a.phone, userId: users.get(phoneToEmail(a.phone)) ?? null, seeded: users.has(phoneToEmail(a.phone)) },
      ),
      orgs: orgs.map((o) => ({ slug: o.slug, id: o.id })),
    };
  });

  // ?email= a dev staff account's current TOTP · ?phone= the last OTP sent to that number
  app.get("/api/dev/code", async (req, reply) => {
    const q = z.object({ email: z.string().optional(), phone: z.string().optional() }).parse(req.query);
    if (q.email) {
      if (!DEV_ACCOUNTS.some((a) => a.surface === "staff" && a.email === q.email)) return reply.status(404).send({ error: "not_a_dev_account" });
      return { code: devTotp() };
    }
    const code = q.phone ? deps.inbox.latest(q.phone) : undefined;
    if (!code) return reply.status(404).send({ error: "no_code_yet" });
    return { code };
  });
}
