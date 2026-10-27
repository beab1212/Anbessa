// Document expiry (workflow 02 part C, rule V10): hourly, expired documents suspend their
// vehicle or driver, and undecided ownership transfers expire after 7 days; once a day, reminders go out 30, 7 and 1 days ahead.

import type { Logger } from "@ride-app/shared-utils";
import type { FleetService } from "../fleet/service.js";

export function startExpiryJob(fleet: FleetService, logger: Logger, everyMs = 3_600_000) {
  let lastReminderDay = "";
  const run = async () => {
    try {
      await fleet.expireDocuments();
      await fleet.expireTransfers();
      const today = new Date().toISOString().slice(0, 10);
      if (today !== lastReminderDay) {
        lastReminderDay = today;
        await fleet.remindExpiring();
      }
    } catch (err) {
      logger.error({ err }, "document expiry job failed");
    }
  };
  void run();
  const timer = setInterval(() => void run(), everyMs);
  return () => clearInterval(timer);
}
