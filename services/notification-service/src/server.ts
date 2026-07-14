import Fastify from "fastify";

// Same shape as auth-service (routes -> controllers -> services -> repositories).
// Consumes trip/payment events from Kafka and fans them out as push (FCM) and SMS (Twilio) notifications. No HTTP API of its own beyond /health.
const app = Fastify({ logger: true });
app.get("/health", async () => ({ status: "ok" }));

app.listen({ port: 3006, host: "0.0.0.0" }).then(() => {
  console.log("notification-service listening on :3006");
});
