const crypto = require("crypto");
const GameLog = require("../models/GameLog");

// Read-only game statistics. Aggregates are public; the list of every player
// name ever logged is personal data, so it needs ADMIN_TOKEN (sent as
// "Authorization: Bearer <token>") and is disabled when no token is configured.
function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  const header = req.get("authorization") || "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const ok =
    typeof expected === "string" &&
    expected.length >= 16 &&
    given.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return res.status(404).json({ error: "Not found" });
  next();
}

function registerAnalyticsRoutes(app) {
  app.get("/api/analytics/win-rates", async (req, res) => {
    try {
      const stats = await GameLog.aggregate([
        { $match: { status: "COMPLETED" } },
        {
          $group: {
            _id: null,
            totalGames: { $sum: 1 },
            nawabWins: { 
              $sum: { $cond: [{ $regexMatch: { input: "$winner", regex: /Nawab/i } }, 1, 0] } 
            },
            eicWins: { 
              $sum: { $cond: [{ $regexMatch: { input: "$winner", regex: /EIC/i } }, 1, 0] } 
            }
          }
        },
        {
          $project: {
            _id: 0,
            totalGames: 1,
            nawabWins: 1,
            eicWins: 1,
            nawabWinPercentage: { 
              $multiply: [{ $divide: ["$nawabWins", "$totalGames"] }, 100] 
            },
            eicWinPercentage: { 
              $multiply: [{ $divide: ["$eicWins", "$totalGames"] }, 100] 
            }
          }
        }
      ]);
      res.json(stats[0] || { totalGames: 0, nawabWins: 0, eicWins: 0 });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch win rates" });
    }
  });

  app.get("/api/analytics/recent-games", async (req, res) => {
    try {
      const games = await GameLog.find({ status: "COMPLETED" })
        .sort({ endTime: -1 })
        .limit(10)
        .select("roomCode winner playerCount startTime endTime");
      
      res.json(games);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch recent games" });
    }
  });

  app.get("/api/analytics/all-players", requireAdmin, async (req, res) => {
    try {
      const players = await GameLog.aggregate([
        // 1. Only look at completed games
        { $match: { status: "COMPLETED" } },
        
        // 2. Convert identities Map to Array
        { $project: { identities: { $objectToArray: "$identities" } } },
        
        // 3. Flatten the array of players
        { $unwind: "$identities" },
        
        // 4. Group by name to get unique names
        {
          $group: {
            _id: "$identities.v.name"
          }
        },
        
        // 5. Sort alphabetically
        { $sort: { _id: 1 } }
      ]);
      
      // Map the result to a clean array of strings
      const playerNames = players.map(p => p._id);
      
      res.json(playerNames);
    } catch (err) {
      console.error("Analytics error:", err && err.message);
      res.status(500).json({ error: "Failed to fetch players" });
    }
  });
}

module.exports = { registerAnalyticsRoutes };
