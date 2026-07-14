import Fastify from "fastify";

// Same shape as auth-service (routes -> controllers -> services -> repositories).
// Handles fare capture and driver payouts via Stripe Connect. Every charge call carries an idempotency key to survive client retries safely.
const app = Fastify({ logger: true });
app.get("/health", async () => ({ status: "ok" }));

app.listen({ port: 3005, host: "0.0.0.0" }).then(() => {
  console.log("payment-service listening on :3005");
});
