const { serializeRoom, deserializeRoom } = require("./roomState");

// Keeps the saved copies of the rooms up to date, and brings saved rooms back.
// See persist-rooms.md.
//
// Saving never holds up play. The server only notes which rooms changed; every
// `flushMs` the changed rooms are written in one batch. A failed write is
// logged and retried on the next tick, so if the database is down the game
// carries on exactly as it would without saving, and a crash loses at most the
// last second of changes.
//
// store: db/roomStore.js, or test/memoryRoomStore.js in tests.
// rooms: the server's live room table, which restore() adds to.
function createRoomPersistence({
  store,
  rooms,
  log = console,
  flushMs = 1000,
  heartbeatMs = 10 * 1000,
  requestTimeoutMs = 3000,
  missingCacheMs = 5000,
}) {
  const dirty = new Set();   // rooms changed since their last save
  const removed = new Set(); // rooms deleted since the last save
  const loading = new Map(); // code -> pending restore, so a room loads once
  const missing = new Map(); // code -> time until which "missing" is remembered
  let chain = Promise.resolve();
  let flushing = false;
  let stopped = false;
  let timers = [];

  // The database being down would otherwise log the same error every second.
  const lastWarned = new Map();
  function warn(what, err) {
    const now = Date.now();
    if (now - (lastWarned.get(what) || 0) < 60 * 1000) return;
    lastWarned.set(what, now);
    log.error(`Saved rooms (${what}) failed:`, err && err.message ? err.message : err);
  }

  function withTimeout(promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${requestTimeoutMs} ms`)), requestTimeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function entryFor(code) {
    const room = rooms[code];
    if (!room) return null;
    return { code, data: serializeRoom(room), lastActivity: room.lastActivity };
  }

  async function writeChanges() {
    const codes = [...dirty];
    const gone = [...removed];
    dirty.clear();
    removed.clear();
    const entries = [];
    for (const code of codes) {
      try {
        const entry = entryFor(code);
        if (entry) entries.push(entry);
        else if (!gone.includes(code)) gone.push(code);
      } catch (err) {
        log.error(`Saved rooms: room ${code} could not be serialized:`, err && err.message);
      }
    }
    if (!entries.length && !gone.length) return;
    try {
      if (gone.length) await store.remove(gone);
      if (entries.length) {
        const written = new Set(await store.save(entries));
        for (const { code } of entries) {
          // Another process holds this room's saved copy, so it wasn't overwritten.
          if (!written.has(code)) warn(`room ${code} is held elsewhere`, "not saved");
        }
      }
    } catch (err) {
      // Try again next tick, unless the room changed state again meanwhile.
      for (const { code } of entries) if (!removed.has(code)) dirty.add(code);
      for (const code of gone) if (!dirty.has(code)) removed.add(code);
      warn("save", err);
    }
  }

  // Resolves after a write that started after this call.
  function flush() {
    flushing = true;
    chain = chain.then(writeChanges).finally(() => { flushing = false; });
    return chain;
  }

  async function heartbeat() {
    try {
      await store.heartbeat();
    } catch (err) {
      warn("heartbeat", err);
    }
  }

  return {
    // Starts the heartbeat and the save timer.
    async start() {
      await heartbeat();
      const every = (fn, ms) => {
        const t = setInterval(fn, ms);
        if (t.unref) t.unref();
        timers.push(t);
      };
      every(heartbeat, heartbeatMs);
      every(() => { if (!flushing) flush(); }, flushMs);
    },

    changed(code) {
      if (stopped || !code) return;
      removed.delete(code);
      dirty.add(code);
    },

    deleted(code) {
      if (stopped || !code) return;
      dirty.delete(code);
      removed.add(code);
    },

    flush,

    // Saves a new room before it is used, so its code can't clash with a saved
    // room. "ok", "taken" (pick another code) or "unsaved" (the database didn't
    // answer: play on, and the save timer keeps trying).
    async create(code, room) {
      missing.delete(code);
      try {
        const ok = await withTimeout(store.create(code, serializeRoom(room), room.lastActivity));
        return ok ? "ok" : "taken";
      } catch (err) {
        warn("create", err);
        dirty.add(code);
        return "unsaved";
      }
    },

    // Brings a saved room back into `rooms`. "ok", "missing" (no such room),
    // "busy" (another process still holds it, e.g. the old one during a
    // deploy) or "error" (the database didn't answer). "busy" and "error" mean
    // try again shortly.
    restore(code) {
      if (stopped) return Promise.resolve("busy");
      if (rooms[code]) return Promise.resolve("ok");
      if (loading.has(code)) return loading.get(code);
      const until = missing.get(code);
      if (until && until > Date.now()) return Promise.resolve("missing");

      const pending = (async () => {
        let result;
        try {
          result = await withTimeout(store.load(code));
        } catch (err) {
          warn("load", err);
          return "error";
        }
        if (result.status === "missing") {
          if (missing.size > 1000) missing.clear();
          missing.set(code, Date.now() + missingCacheMs);
        }
        if (result.status !== "ok") return result.status;
        if (rooms[code]) return "ok";
        try {
          rooms[code] = deserializeRoom(result.data);
        } catch (err) {
          // A row this version can't read would otherwise be retried forever.
          log.error(`Saved rooms: room ${code} could not be restored:`, err && err.message);
          store.remove([code]).catch((e) => warn("remove", e));
          return "missing";
        }
        log.info(`Restored room ${code}.`);
        return "ok";
      })().finally(() => loading.delete(code));
      loading.set(code, pending);
      return pending;
    },

    // Deletes saved rooms nobody holds for which `isExpired(room)` is true, and
    // hands each to `onExpired(code, room)` (to close its game log). Then
    // closes the logs of games whose room was never saved. `minIdleMs` is the
    // shortest idle time that can expire a room.
    async sweepSaved({ minIdleMs, isExpired, onExpired }) {
      if (stopped) return;
      try {
        const candidates = await store.listIdle(minIdleMs);
        const expired = candidates
          .filter(({ data }) => {
            try {
              return isExpired(deserializeRoom(data));
            } catch {
              return true;
            }
          })
          .map(({ code }) => code);
        for (const { code, data } of await store.removeUnowned(expired)) {
          let room = null;
          try {
            room = deserializeRoom(data);
          } catch {
            // Unreadable: nothing to close.
          }
          if (room) onExpired(code, room);
        }
        const closed = await store.abandonOrphanedGames();
        if (closed) log.info(`Closed ${closed} game log(s) whose room was lost.`);
      } catch (err) {
        warn("sweep", err);
      }
    },

    // On shutdown: stops saving, waits for a save in progress, then saves every
    // room one last time and marks them handed on, so the next process can take
    // them over at once instead of waiting for this one's heartbeat to lapse.
    async handOff() {
      if (stopped) return;
      stopped = true;
      timers.forEach(clearInterval);
      timers = [];
      await chain;
      try {
        if (removed.size) await store.remove([...removed]);
        const entries = [];
        for (const code of Object.keys(rooms)) {
          try {
            entries.push(entryFor(code));
          } catch (err) {
            log.error(`Saved rooms: room ${code} could not be serialized:`, err && err.message);
          }
        }
        await store.release(entries);
        log.info(`Handed on ${entries.length} room(s).`);
      } catch (err) {
        log.error("Saved rooms (hand-off) failed:", err && err.message);
      }
    },

    // Stops the timers without handing anything on (tests, or a failed start).
    stop() {
      stopped = true;
      timers.forEach(clearInterval);
      timers = [];
    },
  };
}

module.exports = { createRoomPersistence };
