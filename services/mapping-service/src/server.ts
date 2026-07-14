import Fastify from "fastify";

// Same shape as auth-service (routes -> controllers -> services -> repositories).
// Thin internal wrapper around the self-hosted OSRM (routing/ETA), Nominatim (geocoding) and tile server, so other services never call them directly.
const app = Fastify({ logger: true });
app.get("/health", async () => ({ status: "ok" }));

app.listen({ port: 3007, host: "0.0.0.0" }).then(() => {
  console.log("mapping-service listening on :3007");
});
