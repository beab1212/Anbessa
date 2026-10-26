// Kafka in: `audit.recorded` from every service. Invalid events are logged and skipped so one bad
// message can't block a partition; database errors are retried by kafkajs.

import { Kafka, logLevel } from "kafkajs";
import { ZodError } from "zod";
import type { Logger } from "@ride-app/shared-utils";
import { auditEvent, type AuditStore } from "../store.js";

export function createConsumer(opts: { brokers: string[]; store: AuditStore; logger: Logger; createTopics: boolean }) {
  const kafka = new Kafka({ clientId: "audit-service", brokers: opts.brokers, logLevel: logLevel.WARN });
  const consumer = kafka.consumer({ groupId: "audit-service" });

  /** One message (also used by the tests). */
  async function handle(value: string | undefined) {
    try {
      await opts.store.insert(auditEvent.parse(JSON.parse(value ?? "")));
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof ZodError) {
        opts.logger.error({ err: err.message.slice(0, 300) }, "skipping invalid audit event");
        return;
      }
      throw err;
    }
  }

  return {
    handle,
    async start() {
      if (opts.createTopics) {
        const admin = kafka.admin();
        await admin.connect();
        if (!(await admin.listTopics()).includes("audit.recorded")) await admin.createTopics({ topics: [{ topic: "audit.recorded" }], waitForLeaders: true });
        await admin.disconnect();
      }
      await consumer.connect();
      await consumer.subscribe({ topics: ["audit.recorded"], fromBeginning: true });
      await consumer.run({ eachMessage: async ({ message }) => handle(message.value?.toString()) });
      opts.logger.info("consuming audit.recorded");
    },
    stop: () => consumer.disconnect(),
  };
}
