// Applies the numbered SQL files in db/migrations that haven't run yet, each in
// its own transaction, and records them in polashi.schema_migrations.
// Run as the database owner (`postgres`), not as polashi_app:
//   npm run migrate              uses DATABASE_URL from the environment or .env
const fs = require("fs");
const path = require("path");
const { createPool } = require("./pool");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function migrate(pool, { log = console } = {}) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  try {
    // Two runs at once would apply the same file twice.
    await client.query("select pg_advisory_lock(hashtext('polashi_migrations'))");
    await client.query(`
      create schema if not exists polashi;
      create table if not exists polashi.schema_migrations (
        version    text primary key,
        applied_at timestamptz not null default now()
      );
    `);
    const { rows } = await client.query("select version from polashi.schema_migrations");
    const done = new Set(rows.map((r) => r.version));
    const applied = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into polashi.schema_migrations (version) values ($1)", [file]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw new Error(`${file}: ${err.message}`);
      }
      log.info(`Applied ${file}`);
      applied.push(file);
    }
    if (!applied.length) log.info("Database is up to date.");
    return applied;
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('polashi_migrations'))").catch(() => {});
    client.release();
  }
}

if (require.main === module) {
  require("dotenv").config({ quiet: true });
  const pool = createPool(process.env.DATABASE_URL);
  if (!pool) {
    console.error("Set DATABASE_URL to the postgres role's connection string.");
    process.exit(1);
  }
  migrate(pool)
    .catch((err) => {
      console.error("Migration failed:", err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = { migrate };
