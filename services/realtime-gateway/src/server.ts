import { createServer } from "node:http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { config } from "./config/index.js";
import { createSocketAuth } from "./middlewares/auth.middleware.js";
import { registerLocationHandlers } from "./sockets/location.handler.js";

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200);
    return res.end("ok");
  }
  res.writeHead(404);
  res.end();
});

const io = new Server(httpServer, { cors: { origin: true } });

// Redis adapter is what makes this horizontally scalable: any gateway pod can
// reach any socket, because room membership and broadcasts go through Redis
// instead of an in-process map.
const pubClient = new Redis(config.REDIS_URL);
const subClient = pubClient.duplicate();
io.adapter(createAdapter(pubClient, subClient));

io.use(createSocketAuth(pubClient));

io.on("connection", (socket) => {
  socket.on("trip:subscribe", (tripId: string) => socket.join(`trip:${tripId}`));
  registerLocationHandlers(io, socket);
});

httpServer.listen(config.PORT, () => console.log(`realtime-gateway listening on :${config.PORT}`));
