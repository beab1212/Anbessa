// Kafka in: payment-service's refund outcomes update the refunds agents linked to tickets.
// Invalid messages are logged and skipped so one bad message can't block a partition; database
// errors are rethrown so kafkajs retries. Handling is idempotent (only REQUESTED links change).

import { Kafka, logLevel } from "kafkajs";
import { z, ZodError } from "zod";
import type { Logger } from "@ride-app/shared-utils";
import type { TicketService } from "../support/tickets.js";

export const TOPICS = ["refund.succeeded", "refund.failed"] as const;
const refundOutcome = z.object({ refundId: z.string().uuid() });

export function createConsumer(opts: { brokers: string[]; tickets: TicketService; logger: Logger; createTopics: boolean }) {
  const kafka = new Kafka({ clientId: "support-service", brokers: opts.brokers, logLevel: logLevel.WARN });
  const consumer = kafka.consumer({ groupId: "support-service" });

  /** One message (also used by the tests). */
  async function handle(topic: string, value: string | undefined) {
    try {
      const { refundId } = refundOutcome.parse(JSON.parse(value ?? ""));
      if (topic === "refund.succeeded") await opts.tickets.onRefundOutcome(refundId, "SUCCEEDED");
      else if (topic === "refund.failed") await opts.tickets.onRefundOutcome(refundId, "FAILED");
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof ZodError) {
        opts.logger.error({ topic, err: err.message.slice(0, 300) }, "skipping invalid event");
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
        const existing = await admin.listTopics();
        const missing = TOPICS.filter((t) => !existing.includes(t));
        if (missing.length) await admin.createTopics({ topics: missing.map((topic) => ({ topic })), waitForLeaders: true });
        await admin.disconnect();
      }
      await consumer.connect();
      await consumer.subscribe({ topics: [...TOPICS] });
      await consumer.run({ eachMessage: async ({ topic, message }) => handle(topic, message.value?.toString()) });
      opts.logger.info({ topics: TOPICS }, "consuming");
    },
    stop: () => consumer.disconnect(),
  };
}
