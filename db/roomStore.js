// Saved rooms in Postgres (schema in db/migrations/002_live_rooms.sql). This
// file only reads and writes rows; when to save and what to do with the answer
// is game/roomPersistence.js. See persist-rooms.md.
//
// Every room row has an owner: the server process holding it in memory. Only
// the owner writes a room. Another process may take a room over when its owner
// handed it on (`released`, on shutdown) or stopped sending heartbeats (it
// crashed). That is what lets two processes run side by side during a deploy
// without both holding the same room.

// A process whose heartbeat is older than this is treated as gone.
const ALIVE_SECONDS = 30;

// A room nobody holds: its owner released it, or the owner is gone.
const UNOWNED = `(r.released or not exists (
  select 1 from polashi_live.instances i
  where i.id = r.owner and i.heartbeat_at > now() - interval '${ALIVE_SECONDS} seconds'))`;

function createRoomStore({ pool, instanceId }) {
  if (!pool) throw new Error("createRoomStore needs a pool");
  if (!instanceId) throw new Error("createRoomStore needs an instanceId");

  // entries: [{ code, data, lastActivity }]. Inserts new rooms and updates this
  // process's own; a row another process owns is left alone. Returns the codes
  // that were written.
  async function upsert(db, entries, released) {
    if (!entries.length) return [];
    const { rows } = await db.query(
      `insert into polashi_live.rooms as r (code, state, owner, released, last_activity, saved_at)
       select u.code, u.state::jsonb, $1, $2, to_timestamp(u.ms / 1000.0), now()
       from unnest($3::text[], $4::text[], $5::float8[]) as u(code, state, ms)
       on conflict (code) do update
         set state = excluded.state, released = excluded.released,
             last_activity = excluded.last_activity, saved_at = now()
         where r.owner = excluded.owner
       returning code`,
      [
        instanceId,
        released,
        entries.map((e) => e.code),
        entries.map((e) => JSON.stringify(e.data)),
        entries.map((e) => Number(e.lastActivity) || Date.now()),
      ],
    );
    return rows.map((r) => r.code);
  }

  return {
    instanceId,

    // Says this process is alive. Called on start and every few seconds.
    async heartbeat() {
      await pool.query(
        `insert into polashi_live.instances (id) values ($1)
         on conflict (id) do update set heartbeat_at = now()`,
        [instanceId],
      );
    },

    // Saves a brand-new room. False if the code is already taken by a saved room.
    async create(code, data, lastActivity) {
      const { rowCount } = await pool.query(
        `insert into polashi_live.rooms (code, state, owner, last_activity)
         values ($1, $2::jsonb, $3, to_timestamp($4 / 1000.0))
         on conflict (code) do nothing`,
        [code, JSON.stringify(data), instanceId, Number(lastActivity) || Date.now()],
      );
      return rowCount === 1;
    },

    save(entries) {
      return upsert(pool, entries, false);
    },

    async remove(codes) {
      if (!codes.length) return;
      await pool.query("delete from polashi_live.rooms where code = any($1) and owner = $2", [codes, instanceId]);
    },

    // Takes a saved room over and returns it: { status: "ok", data }. "busy"
    // when a live process still holds it, "missing" when there is no such room.
    async load(code) {
      const { rows } = await pool.query(
        `update polashi_live.rooms r set owner = $2, released = false, saved_at = now()
         where r.code = $1 and (r.owner = $2 or ${UNOWNED})
         returning state`,
        [code, instanceId],
      );
      if (rows.length) return { status: "ok", data: rows[0].state };
      const { rowCount } = await pool.query("select 1 from polashi_live.rooms where code = $1", [code]);
      return { status: rowCount ? "busy" : "missing" };
    },

    // On shutdown: saves every room one last time, marks all of this process's
    // rooms as handed on, and removes its heartbeat so nothing waits for it.
    async release(entries) {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query("begin");
        await upsert(client, entries, true);
        await client.query("update polashi_live.rooms set released = true where owner = $1", [instanceId]);
        await client.query("delete from polashi_live.instances where id = $1", [instanceId]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => { broken = true; });
        throw err;
      } finally {
        client.release(broken);
      }
    },

    // Rooms nobody holds that have been idle at least `idleMs`: [{ code, data }].
    async listIdle(idleMs, limit = 200) {
      const { rows } = await pool.query(
        `select code, state from polashi_live.rooms r
         where r.last_activity < now() - make_interval(secs => $1 / 1000.0) and ${UNOWNED}
         order by r.last_activity
         limit $2`,
        [idleMs, limit],
      );
      return rows.map((r) => ({ code: r.code, data: r.state }));
    },

    // Deletes the given rooms if nobody has taken them over in the meantime.
    // Returns the rooms actually deleted.
    async removeUnowned(codes) {
      if (!codes.length) return [];
      const { rows } = await pool.query(
        `delete from polashi_live.rooms r where r.code = any($1) and ${UNOWNED} returning code, state`,
        [codes],
      );
      return rows.map((r) => ({ code: r.code, data: r.state }));
    },

    // Closes the logs of games that can never finish: still in progress, but no
    // saved room refers to them (the process running them died before saving).
    // Games younger than two minutes are left alone, as their room may not have
    // been saved yet. Also forgets processes gone for a day. Returns the number
    // of games closed.
    async abandonOrphanedGames() {
      const { rowCount } = await pool.query(
        `update polashi.games g
         set status = 'abandoned', end_reason = 'server_restart', ended_at = now()
         where g.status = 'in_progress'
           and g.started_at < now() - interval '2 minutes'
           and not exists (
             select 1 from polashi_live.rooms r
             where r.state -> 'room' -> 'gameLog' ->> 'id' = g.id::text)`,
      );
      await pool.query("delete from polashi_live.instances where heartbeat_at < now() - interval '1 day'");
      return rowCount;
    },
  };
}

module.exports = { createRoomStore, ALIVE_SECONDS };
