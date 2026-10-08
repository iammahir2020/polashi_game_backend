require("dotenv").config();
const crypto = require("crypto");
const os = require("os");
const { createPool } = require("./db/pool");
const { createGameLogger } = require("./GameLogger");
const { createRoomStore } = require("./db/roomStore");
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
// Saved rooms (PERSIST_ROOMS=1, needs DATABASE_URL and migration 002): rooms
// are saved as they change and survive a deploy or restart. See persist-rooms.md.
const persistRooms = /^(1|true|yes|on)$/i.test(process.env.PERSIST_ROOMS || "");
const roomStore = pool && persistRooms
  ? createRoomStore({ pool, instanceId: `${os.hostname()}-${crypto.randomUUID().slice(0, 8)}` })
  : null;
if (persistRooms && !pool) console.warn("PERSIST_ROOMS is set but DATABASE_URL isn't: rooms will not be saved.");
console.log(roomStore ? "Rooms are saved and survive restarts." : "Rooms live in memory only: a restart ends every game.");

// Games left in progress by an earlier run. Without saved rooms none of them
// can finish, so they are closed now. With saved rooms, start() below closes
// only those whose room was lost; the rest carry on once their players return.
if (!logger) {
  console.warn("DATABASE_URL is not set: games will not be logged.");
} else if (!roomStore) {
  logger.abandonUnfinished()
    .then((n) => n && console.log(`Marked ${n} unfinished game(s) from the last run as abandoned.`))
    .catch((err) => console.error("Game log (abandonUnfinished) failed:", err.message));
}

const { httpServer, start, handOff, close } = createGameServer({
  logger: logger || undefined,
  allowedOrigins: readAllowedOrigins(),
  maxRooms: intFromEnv("MAX_ROOMS", 1000),
  maxConnections: capFromEnv("MAX_CONNECTIONS", 5000),
  maxSocketsPerIp: capFromEnv("MAX_SOCKETS_PER_IP", 40),
  maxRoomsPerIp: capFromEnv("MAX_ROOMS_PER_IP", 10),
  roomStore: roomStore || undefined,
});

// Last-resort logging. Handlers are already wrapped; anything reaching here is a bug.
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err && err.stack ? err.stack : err));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err && err.stack ? err.stack : err));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
start().catch((err) => console.error("Saved rooms failed to start:", err && err.message));

// Render stops the old instance with SIGTERM on every deploy, once the new one
// is up. In order: stop changing rooms and let queued log writes finish (so
// each saved room has its game's database ids), save every room as handed on,
// then disconnect the clients, who reconnect to the new instance and find
// their rooms there. Without saved rooms, games in progress are closed as
// server_restart by the next instance.
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down.`);
  const timeout = new Promise((resolve) => setTimeout(resolve, 8000).unref());
  Promise.race([
    handOff({ beforeSave: () => logger && logger.flush() })
      .then(() => close())
      .then(() => logger && logger.flush())
      .then(() => pool && pool.end()),
    timeout,
  ])
    .catch((err) => console.error("Shutdown error:", err && err.message))
    .finally(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
