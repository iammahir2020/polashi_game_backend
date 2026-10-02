require("dotenv").config();
const mongoose = require("mongoose");
const { GameLogger } = require("./GameLogger");
const { createGameServer, DEFAULT_ORIGINS } = require("./game/createGameServer");
const { registerAnalyticsRoutes } = require("./routes/analytics");

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

if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("✅ Successfully connected to MongoDB Atlas"))
    .catch(err => console.error("❌ MongoDB connection error:", err && err.message));
} else {
  console.warn("MONGODB_URI not set: analytics endpoints will fail.");
}

const { httpServer } = createGameServer({
  logger: GameLogger,
  allowedOrigins: readAllowedOrigins(),
  maxRooms: intFromEnv("MAX_ROOMS", 1000),
  configureApp: registerAnalyticsRoutes,
});

// Last-resort logging. Handlers are already wrapped; anything reaching here is a bug.
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err && err.stack ? err.stack : err));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err && err.stack ? err.stack : err));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
