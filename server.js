require("dotenv").config();
const { GameLogger } = require("./GameLogger");
const { createGameServer, DEFAULT_ORIGINS } = require("./game/createGameServer");

// Browser origins allowed to connect: CLIENT_URL as a comma-separated list, or
// the production site plus local dev servers when it isn't set. "*" is still
// honoured if set explicitly, but isn't the default any more.
function readAllowedOrigins() {
  const raw = process.env.CLIENT_URL;
  if (!raw) return DEFAULT_ORIGINS;
  const list = raw.split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
  if (list.includes("*")) console.warn("CLIENT_URL allows every origin (*). Set it to the site's URL.");
  return list.length ? list : DEFAULT_ORIGINS;
}

const intFromEnv = (name, fallback) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
// Like intFromEnv, but 0 is allowed (it switches that cap off).
const capFromEnv = (name, fallback) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const { httpServer } = createGameServer({
  logger: GameLogger,
  allowedOrigins: readAllowedOrigins(),
  maxRooms: intFromEnv("MAX_ROOMS", 1000),
  maxConnections: capFromEnv("MAX_CONNECTIONS", 5000),
  maxSocketsPerIp: capFromEnv("MAX_SOCKETS_PER_IP", 40),
  maxRoomsPerIp: capFromEnv("MAX_ROOMS_PER_IP", 10),
});

// Last-resort logging. Handlers are already wrapped; anything reaching here is a bug.
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err && err.stack ? err.stack : err));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err && err.stack ? err.stack : err));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
