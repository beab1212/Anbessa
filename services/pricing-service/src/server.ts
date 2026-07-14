import Fastify from "fastify";

// Same shape as auth-service (routes -> controllers -> services -> repositories).
// Calculates fare estimates and surge multipliers from trip distance/duration (via mapping-service) and live demand signals.
const app = Fastify({ logger: true });
app.get("/health", async () => ({ status: "ok" }));

app.listen({ port: 3004, host: "0.0.0.0" }).then(() => {
  console.log("pricing-service listening on :3004");
});
