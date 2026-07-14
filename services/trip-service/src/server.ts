import Fastify from "fastify";

// Same shape as auth-service (routes -> controllers -> services -> repositories).
// Owns the ride lifecycle state machine (requested -> matched -> en_route -> in_progress -> completed -> cancelled) and driver-rider matching.
const app = Fastify({ logger: true });
app.get("/health", async () => ({ status: "ok" }));

app.listen({ port: 3002, host: "0.0.0.0" }).then(() => {
  console.log("trip-service listening on :3002");
});
