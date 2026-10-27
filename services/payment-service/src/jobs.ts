// Background work (one runner per job, never overlapping itself):
//   every 15 s   start due charge retries and interrupted charges
//   every minute ask providers about operations whose callback never came (reconciliation)
//   every 5 min  dues past their deadline → OVERDUE (blocks); expire old rule proposals;
//                a balance policy that just took effect recomputes its city's states
//   every 10 min the weekly settlement, Monday 00:00 Addis Ababa (SETTLEMENT_SCHEDULE=weekly)
//   every hour   ledger integrity (balance = Σ postings, all accounts sum to 0); logged loudly
//   every 5 min  money controls: expire undecided adjustments, write-offs, overrides and incentives;
//                recompute balances whose policy override window opened or closed; pay incentives
//                whose window closed

import type { Logger } from "@ride-app/shared-utils";
import type { Container } from "./container.js";
import { integrity } from "./ledger/ledger.js";
import { addisDate } from "./money/rules.js";

export function startJobs(c: Container, logger: Logger) {
  const timers: NodeJS.Timeout[] = [];
  let policyCheckedAt = c.now();
  let overridesCheckedAt = c.now();

  function every(ms: number, name: string, fn: () => Promise<unknown>) {
    let running = false;
    const t = setInterval(() => {
      if (running) return;
      running = true;
      fn().catch((err) => logger.error({ err, job: name }, "job failed")).finally(() => (running = false));
    }, ms);
    t.unref?.();
    timers.push(t);
  }

  every(15_000, "charges", () => c.payments.chargeDue());

  every(60_000, "reconcile", async () => {
    const after = c.config.RECONCILE_AFTER_SECONDS;
    const fixed = (await c.payments.reconcile(after)) + (await c.topUps.reconcile(after)) + (await c.payouts.reconcile(after));
    if (fixed) logger.info({ fixed }, "reconciliation applied provider results that never arrived by callback");
  });

  every(5 * 60_000, "dues-and-rules", async () => {
    const overdue = await c.payouts.overdueSweep();
    if (overdue) logger.info({ overdue }, "payment dues are overdue; those balances are blocked");
    await c.ruleChanges.expire();
    const since = policyCheckedAt;
    policyCheckedAt = c.now();
    const started = await c.db.balancePolicy.findMany({ where: { validFrom: { gt: since, lte: policyCheckedAt } }, select: { cityId: true } });
    for (const cityId of new Set(started.map((p) => p.cityId))) await c.ruleChanges.recomputeCity(cityId);
  });

  every(5 * 60_000, "money-controls", async () => {
    const expired = (await c.adjustments.expire()) + (await c.writeOffs.expire()) + (await c.policyOverrides.expire()) + (await c.incentives.expire());
    if (expired) logger.info({ expired }, "money requests expired without a decision");
    const since = overridesCheckedAt;
    overridesCheckedAt = c.now();
    const recomputed = await c.policyOverrides.boundaries(since, overridesCheckedAt);
    if (recomputed) logger.info({ recomputed }, "policy override windows opened or closed; balance states recomputed");
    const closed = await c.incentives.closeDue();
    if (closed) logger.info({ closed }, "incentive programs closed and paid");
  });

  if (c.config.SETTLEMENT_SCHEDULE === "weekly") {
    every(10 * 60_000, "weekly-settlement", async () => {
      const now = c.now();
      const addis = new Date(`${addisDate(now)}T00:00:00Z`);
      if (addis.getUTCDay() !== 1) return; // Monday
      const r = await c.payouts.run(null);
      if (r.created) logger.info({ batch: r.batch.id, lines: r.batch.lineCount, dues: r.batch.duesCreated }, "weekly settlement prepared; waiting for a finance manager");
    });
  }

  every(3600_000, "ledger-integrity", async () => {
    const r = await integrity(c.db);
    if (!r.ok) logger.error({ totalMinor: r.totalMinor, mismatched: r.mismatched }, "LEDGER INTEGRITY CHECK FAILED");
  });

  return () => timers.forEach(clearInterval);
}
