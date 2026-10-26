import { createServer } from "node:http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { createAuthzSync, fetchAuthzSnapshotFrom } from "@ride-app/shared-authz";
import { createLogger } from "@ride-app/shared-utils";
import { config } from "./config/index.js";
import { kafkaLocationPublisher, noopPublisher } from "./kafka.js";
import { createSocketAuth } from "./middlewares/auth.middleware.js";
import { registerLocationHandlers } from "./sockets/location.handler.js";

const logger = createLogger("realtime-gateway", config.NODE_ENV);

// Redis adapter is what makes this horizontally scalable: any gateway pod can
// reach any socket, because room membership and broadcasts go through Redis
// instead of an in-process map.
const pubClient = new Redis(config.REDIS_URL);
const subClient = pubClient.duplicate();

const publisher = config.KAFKA_BROKERS
  ? kafkaLocationPublisher(config.KAFKA_BROKERS.split(",").map((b) => b.trim()), (err) => logger.warn({ err: err.message }, "driver.location publish failed"))
  : noopPublisher;
if (!config.KAFKA_BROKERS) logger.warn("KAFKA_BROKERS not set: driver.location is not published (Redis still updates)");

const httpServer = createServer((req, res) => {
  if (req.url === "/health" || req.url === "/health/live") {
    res.writeHead(200);
    return res.end("ok");
  }
  if (req.url === "/health/ready") {
    pubClient.ping().then(
      () => (res.writeHead(200), res.end(JSON.stringify({ status: "ok", kafka: publisher.stats() }))),
      () => (res.writeHead(503), res.end(JSON.stringify({ status: "unavailable" }))),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

// Tokens travel in the handshake (auth.token), not cookies, so any origin may connect.
const io = new Server(httpServer, { cors: { origin: true }, maxHttpBufferSize: 16 * 1024 });
io.adapter(createAdapter(pubClient, subClient));
io.use(createSocketAuth(pubClient));

io.on("connection", (socket) => {
  // services push to people, not connections: trip-service emits trip:offer / trip:status to
  // user:{id} through the Redis emitter, and every device of that user receives it
  void socket.join(`user:${socket.data.userId as string}`);
  registerLocationHandlers(io, socket, { redis: pubClient, publisher });

  // A suspension must also end connections opened before it (Auth.md §9.5).
  const userId = socket.data.userId as string;
  const recheck = setInterval(async () => {
    if ((await pubClient.exists(`deny:${userId}`).catch(() => 0)) === 1) socket.disconnect(true);
  }, 60_000);
  socket.on("disconnect", () => clearInterval(recheck));
});

// the permission matrix follows auth-service live (Role.md §8); without the service token, the built-in one
if (config.INTERNAL_SERVICE_TOKEN) {
  void createAuthzSync({ fetchSnapshot: fetchAuthzSnapshotFrom(config.AUTH_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN), redis: pubClient, logger }).start();
} else {
  logger.warn("INTERNAL_SERVICE_TOKEN not set: using the built-in permission matrix");
}

httpServer.listen(config.PORT, () => logger.info(`realtime-gateway listening on :${config.PORT}`));

let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    logger.info(`${signal} received, shutting down`);
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await publisher.stop();
    pubClient.disconnect();
    subClient.disconnect();
    process.exit(0);
  });
}
