# Saved rooms: games that survive a deploy

Rooms used to live only in the server's memory, so every deploy, crash or free-plan sleep ended every
game in progress. With `PERSIST_ROOMS=1` the server keeps a copy of each live room in Postgres and a
new server process picks the rooms up where the old one left off. Players see "The server is
updating. Reconnecting you to your game..." for a few seconds and land back in the same game, with
the same roles, votes and score.

It is **off by default**. Without the flag the server behaves exactly as before.

## Turning it on

1. Apply the migration (once, as the `postgres` role): `npm run migrate`. This adds
   `db/migrations/002_live_rooms.sql`.
2. On Render, set `PERSIST_ROOMS=1` next to the existing `DATABASE_URL`. The startup log then says
   "Rooms are saved and survive restarts."
3. Deploy the frontend that understands `serverUpdating` (frontend branch
   `feat/server-updating-rejoin`) **before or with** this. An older frontend still rejoins, but
   during the few seconds a room is in transit it shows a "Room not found" style error instead of
   waiting.
4. Rehearse: start a game on two or three devices, trigger a manual deploy on Render partway through
   a mission, and check the game carries on. This also shows whether Render's free plan runs the old
   and new instances side by side during a deploy (the design works either way; see below).

To turn it off again, remove `PERSIST_ROOMS`. Saved rows left behind are harmless; the next start
with the flag sweeps any that expired.

## The pieces

| File | Job |
|---|---|
| `game/roomState.js` | Room to JSON and back (`serializeRoom` / `deserializeRoom`), versioned `{ v, room }` |
| `db/roomStore.js` | Reads and writes rows in `polashi_live`. Knows nothing about when to save |
| `game/roomPersistence.js` | Decides when: change tracking, the batched save, restore on demand, hand-off, sweeping |
| `game/createGameServer.js` | Calls the above: `roomStore` option, `start()`, `handOff()`, `restoreRoom()` |
| `server.js` | The `PERSIST_ROOMS` flag, start-up, and the shutdown order |
| `test/memoryRoomStore.js` | An in-memory `roomStore` with the same rules, for tests without Postgres |

### What is saved

Almost all of a room is plain data and is copied as it is, so a field added to rooms later is saved
without touching `roomState.js`. The exceptions:

- `socketId` / `online` only mean something to the process that set them. Saved as `null` / `false`;
  each player sets them again on reconnecting.
- `creatorIp` is not saved, so the database holds no IP addresses. The per-address room cap starts
  counting afresh after a restart.
- `playerStats` (a `Map`) is saved as `[id, stats]` pairs.
- `gameLog` belongs to `GameLogger`: only its database ids and the players' teams are saved, not
  its queue of pending writes. That is why the logger is flushed before the final save.
- `voting.startedAt` (a `Date`) is saved as an ISO string.

A 5-player room after one round is about 3.4 KB; a 10-player room about 6.1 KB.

### Where it is saved

Its own schema, `polashi_live`, apart from the game logs in `polashi`. A saved room holds every
player's rejoin secret and hidden role, so only the game server's role (`polashi_app`) may touch it.
`polashi_readonly` gets nothing there, and the weekly backup (which dumps only `polashi` as
`polashi_readonly`) never contains it. Supabase's API roles are explicitly revoked and RLS is on.

- `polashi_live.instances`: one row per running server process, with a heartbeat every 10 s.
- `polashi_live.rooms`: one row per live room: `state` (jsonb), `owner` (an instance id),
  `released`, `last_activity`.

Rows live only as long as their room: they are deleted when the room is closed, emptied or swept.

## How it works

### Saving never holds up play

Every change to a room already goes through `broadcastRoomUpdate`, so that is where the room is
marked as changed. Once a second, every changed room is written in **one** query. A burst of votes is
one write, about 30–60 writes per game. A failed write is logged (at most once a minute per kind)
and retried on the next tick, so if the database is down the game carries on exactly as it would
without saving. A crash loses at most about a second of changes.

### Ownership

Every saved room has an owner: the process holding it in memory. Only the owner writes a room. Another
process may take a room over only when:

- its owner **released** it (on shutdown), or
- its owner's heartbeat is **older than 30 s** (it crashed or was killed).

That is what lets two processes run side by side during a deploy without both changing the same room.

### A deploy, step by step

Render starts the new instance, routes traffic to it, then sends SIGTERM to the old one. On SIGTERM
the old server (`server.js` → `handOff()` → `close()`):

1. Stops changing rooms. From here a returning player gets `serverUpdating`, and a create or join
   gets "The server is updating. Please try again in a few seconds."
2. Flushes the game logger, so each saved room carries its game's database ids.
3. Saves every room one last time, marks them all `released` and deletes its heartbeat, in one
   transaction.
4. Disconnects the clients. They reconnect (to the new instance) and send `reconnectPlayer`.

The new server doesn't have the room in memory, so it loads it from Postgres (taking ownership) and
answers with the room as usual. When a whole room reconnects at once the load runs once.

If a player reaches the new server **before** the old one has released the room (the overlap), the
room is "busy": the server answers `serverUpdating { retryInMs: 2000 }` and the client asks again.
The same answer is given when the database doesn't reply within 3 s, so a slow query never makes a
seat look lost.

If Render does not overlap instances on the free plan, nothing changes in the design: the old one
saves and exits, the new one boots, and clients keep retrying their connection until it is up
(30–60 s on a cold start). They see the reconnecting screen for longer, then land back in the game.

### Restarts without a deploy

- **Crash or out-of-memory kill:** no hand-off happens, but the rooms were saved within the last
  second. The next process takes them over once the dead one's heartbeat is 30 s old.
- **Free-plan sleep** (15 idle minutes): rooms are saved, so a group coming back within the idle
  limit finds its game.

### Expiry and game logs

- Rooms in memory expire as before (`sweepRooms`). The rule is now one function, `isExpired`, used
  for saved rooms too.
- Every 5 minutes (and at start-up) the server sweeps **saved rooms nobody holds** by the same rule,
  deletes them, and closes their game logs as `abandoned` / `swept_idle`.
- `abandonUnfinished()` (which closed every in-progress game at start-up) is no longer run when
  rooms are saved: it would close games about to be restored. Instead `abandonOrphanedGames()`
  closes only in-progress games no saved room refers to, older than 2 minutes.

### Room codes

`createRoom` claims a new code in the database (`insert ... on conflict do nothing`) before using it,
so a new server can never hand out a code a saved room still uses. Up to 5 codes are tried. If the
database doesn't answer, the room is created anyway and the save timer keeps trying. Only codes of
the generated shape (`/^[A-Z0-9]{6}$/`) are ever looked up, and a code found missing is remembered
for 5 s, so mistyped or random codes cost no queries.

### Reconnect stats

The first reconnect after a restore is not counted in the player's `reconnects` stat. The restart
caused it, not the player.

## The client side

The frontend handles `serverUpdating` in `src/components/GameDashboard/index.tsx`:

- the saved seat (room code, player id, rejoin token) is kept, unlike for "not found";
- it shows "The server is updating. Reconnecting you to your game..." and re-sends the rejoin after
  `retryInMs` (clamped to 0.5–10 s in `src/services/payloads.ts`);
- nothing is re-sent while disconnected; `socket.ts` rejoins by itself on `connect`;
- a real answer (the room, or an error) ends the wait;
- after 30 retries in a row (about a minute) it stops and asks the player to refresh later, seat
  still saved.

## Load on the free plans

Measured and estimated on 2026-10-08:

- **Supabase:** the rooms table usually holds under 100 KB. About one write per second at most,
  1–2 ms each (same region as Render). Reads only happen after a restart. Uses the existing pool of
  5 connections, shared with the logger.
- **Render:** one pending snapshot per changed room in memory; serializing a room takes well under a
  millisecond. Adds about 0.3 MB of outbound traffic per game. The hand-off fits inside the
  existing 8 s shutdown window.

If the database is down at the moment of a deploy, games are lost exactly as they were before this
change. Nothing ends up worse than without it.

## Tests

- `test/persistence.test.js`: two servers over a shared in-memory store, playing the old and new
  process. A game in mid-council-vote carries on after a deploy and plays to the end; a hand-off
  freezes the old server; a crashed server's rooms are taken over after its heartbeat lapses; saved
  rooms expire and their logs close; the database going down never stops play; hidden fields of
  restored players never reach a client; without a store nothing changes.
- `test/db.test.js` (with `TEST_DATABASE_URL`): the real Postgres store. Only the owner writes; a
  room is taken over only once free; a full deploy with the game log carrying on; only orphaned games
  are closed at start-up; `polashi_readonly` and the backup can't see `polashi_live`.
