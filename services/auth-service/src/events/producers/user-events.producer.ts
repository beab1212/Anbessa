import { Kafka } from "kafkajs";
import { config } from "../../config/index.js";

const kafka = new Kafka({ clientId: "auth-service", brokers: config.KAFKA_BROKERS.split(",") });
const producer = kafka.producer();

export async function publishUserCreated(userId: string, role: string) {
  await producer.connect();
  await producer.send({
    topic: "user.created",
    messages: [{ key: userId, value: JSON.stringify({ userId, role, at: new Date().toISOString() }) }],
  });
}
