require("dotenv").config();
const { createPool } = require("./db/pool");
const { createGameLogger } = require("./GameLogger");
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

// Game logs go to Postgres. Without DATABASE_URL (local development) the game
// runs as usual and nothing is logged.
const pool = createPool(process.env.DATABASE_URL);
const logger = pool
  ? createGameLogger({ pool, serverVersion: process.env.RENDER_GIT_COMMIT || null })
  : null;
if (logger) {
  logger.abandonUnfinished()
    .then((n) => n && console.log(`Marked ${n} unfinished game(s) from the last run as abandoned.`))
    .catch((err) => console.error("Game log (abandonUnfinished) failed:", err.message));
} else {
  console.warn("DATABASE_URL is not set: games will not be logged.");
}

const { httpServer, close } = createGameServer({
  logger: logger || undefined,
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

// Render stops the old instance with SIGTERM on every deploy. Let queued log
// writes finish (games still in progress are closed as server_restart by the
// next instance), then exit.
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down.`);
  const timeout = new Promise((resolve) => setTimeout(resolve, 8000).unref());
  Promise.race([
    Promise.resolve(close()).then(() => logger && logger.flush()).then(() => pool && pool.end()),
    timeout,
  ])
    .catch((err) => console.error("Shutdown error:", err && err.message))
    .finally(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
