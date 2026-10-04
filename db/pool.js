const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// Supabase's pooler presents a certificate signed by Supabase's own root, which
// the standard certificate store doesn't know, so it is checked against this file.
const SUPABASE_CA = path.join(__dirname, "prod-ca-2021.crt");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Builds a pg pool from a connection string. Remote databases are always
// reached over TLS with the certificate verified; local ones (tests, a
// developer's Postgres) without TLS. Any sslmode in the string is ignored, as
// pg would let it override the settings here.
function createPool(connectionString, { log = console, ...options } = {}) {
  if (!connectionString) return null;
  const url = new URL(connectionString);
  for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(key);
  const local = LOCAL_HOSTS.has(url.hostname);

  const pool = new Pool({
    connectionString: url.toString(),
    ssl: local ? false : { ca: fs.readFileSync(SUPABASE_CA, "utf8"), rejectUnauthorized: true },
    max: 5,
    idleTimeoutMillis: 30 * 1000,
    connectionTimeoutMillis: 10 * 1000,
    statement_timeout: 10 * 1000,
    application_name: "polashi-backend",
    ...options,
  });
  // An idle connection dropped by the server must not crash the process.
  pool.on("error", (err) => log.error("Database connection error:", err && err.message));
  return pool;
}

module.exports = { createPool };
