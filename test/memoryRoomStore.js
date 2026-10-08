// An in-memory stand-in for db/roomStore.js with the same rules (ownership,
// hand-off, heartbeats), so the server's saving and restoring can be tested
// without Postgres. Two servers given stores over the same `db` behave like two
// processes sharing one database during a deploy. test/db.test.js runs the
// real store against Postgres.
//
// db.failing = true makes every call throw, like an unreachable database.
// db.delayMs delays every call.

const ALIVE_MS = 30 * 1000;

function createMemoryDb() {
  return { rooms: new Map(), instances: new Map(), games: new Map(), failing: false, delayMs: 0, now: () => Date.now() };
}

function createMemoryRoomStore(db, instanceId) {
  const clone = (x) => JSON.parse(JSON.stringify(x));

  async function call(fn) {
    if (db.delayMs) await new Promise((r) => setTimeout(r, db.delayMs));
    if (db.failing) throw new Error("database unreachable");
    return fn();
  }

  function unowned(row) {
    if (row.released) return true;
    const beat = db.instances.get(row.owner);
    return !beat || beat <= db.now() - ALIVE_MS;
  }

  function upsert(entries, released) {
    const written = [];
    for (const { code, data, lastActivity } of entries) {
      const row = db.rooms.get(code);
      if (row && row.owner !== instanceId) continue;
      db.rooms.set(code, { state: clone(data), owner: instanceId, released, lastActivity: Number(lastActivity) || db.now() });
      written.push(code);
    }
    return written;
  }

  return {
    instanceId,
    heartbeat: () => call(() => { db.instances.set(instanceId, db.now()); }),
    create: (code, data, lastActivity) => call(() => {
      if (db.rooms.has(code)) return false;
      db.rooms.set(code, { state: clone(data), owner: instanceId, released: false, lastActivity: Number(lastActivity) || db.now() });
      return true;
    }),
    save: (entries) => call(() => upsert(entries, false)),
    remove: (codes) => call(() => {
      for (const code of codes) if (db.rooms.get(code)?.owner === instanceId) db.rooms.delete(code);
    }),
    load: (code) => call(() => {
      const row = db.rooms.get(code);
      if (!row) return { status: "missing" };
      if (row.owner !== instanceId && !unowned(row)) return { status: "busy" };
      row.owner = instanceId;
      row.released = false;
      return { status: "ok", data: clone(row.state) };
    }),
    release: (entries) => call(() => {
      upsert(entries, true);
      for (const row of db.rooms.values()) if (row.owner === instanceId) row.released = true;
      db.instances.delete(instanceId);
    }),
    listIdle: (idleMs) => call(() =>
      [...db.rooms].filter(([, row]) => row.lastActivity < db.now() - idleMs && unowned(row))
        .map(([code, row]) => ({ code, data: clone(row.state) }))),
    removeUnowned: (codes) => call(() => {
      const out = [];
      for (const code of codes) {
        const row = db.rooms.get(code);
        if (row && unowned(row)) {
          db.rooms.delete(code);
          out.push({ code, data: clone(row.state) });
        }
      }
      return out;
    }),
    abandonOrphanedGames: () => call(() => 0),
  };
}

module.exports = { createMemoryDb, createMemoryRoomStore };
