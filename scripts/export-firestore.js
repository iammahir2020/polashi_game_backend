// Saves every document in Firestore's game_logs collection to a JSON file,
// for scripts/import-firestore.js. Read-only: Firestore is not changed.
//   node scripts/export-firestore.js [out-file]   (default exports/game_logs-<date>.json)
// Needs the FIREBASE_* variables in .env. The file holds player names: it goes
// in exports/, which is gitignored.
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { db, admin } = require("../firebase-admin");

// Firestore timestamps become ISO strings; everything else is plain JSON.
function plain(value) {
  if (value instanceof admin.firestore.Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

async function main() {
  const date = new Date().toISOString().slice(0, 10);
  const out = process.argv[2] || path.join(__dirname, "..", "exports", `game_logs-${date}.json`);
  const snapshot = await db.collection("game_logs").get();
  const docs = snapshot.docs.map((d) => ({ id: d.id, ...plain(d.data()) }));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ exportedAt: new Date().toISOString(), docs }, null, 2));
  console.log(`Saved ${docs.length} documents to ${path.relative(process.cwd(), out)}`);
}

main()
  .catch((err) => {
    console.error("Export failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => admin.app().delete());
