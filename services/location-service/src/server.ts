import Fastify from "fastify";

// Same shape as auth-service (routes -> controllers -> services -> repositories).
// Consumes driver.location events from Kafka, exposes nearby-driver geo queries (backed by Redis GEO) and ETA lookups via mapping-service.
const app = Fastify({ logger: true });
app.get("/health", async () => ({ status: "ok" }));

app.listen({ port: 3003, host: "0.0.0.0" }).then(() => {
  console.log("location-service listening on :3003");
});
