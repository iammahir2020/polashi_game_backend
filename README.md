# Polashi game server

Real-time server for [The Battle of Polashi](https://the-great-polashi-game.vercel.app), an unofficial
online adaptation of Playground Inc.'s Polashi board game. Node 20, Express 5, Socket.IO 4. The
frontend lives in [polashi_game_frontend](https://github.com/iammahir2020/polashi_game_frontend).

Game state is held in memory on a single instance. Games are logged to Postgres on Supabase
(`GameLogger.js`, schema `polashi`), each event as it happens: the game and its players, every team
proposal with its votes, mission results and Guptochor investigations. The data model and its
reasons are in `postgres-migration.md`.

## Layout

| Path | What it is |
|---|---|
| `server.js` | Entry point: environment, game logger, `listen`, shutdown |
| `GameLogger.js` | Writes game events to Postgres, in order per game; failures never interrupt play |
| `db/pool.js` | Postgres pool (5 connections, TLS verified with `db/prod-ca-2021.crt`) |
| `db/migrate.js`, `db/migrations/` | `npm run migrate`: applies numbered SQL files once each |
| `game/createGameServer.js` | Express + Socket.IO server and every socket event handler |
| `game/room.js` | Per-player room view (what each client may see), secret intel, codes and tokens |
| `game/validation.js` | Payload schemas (zod) and player-name rules |
| `game/limits.js` | Client address, token buckets and the HTTP rate limiter |
| `game/constants.js` | Characters, decoy names, mission sizes, team distribution |
| `test/` | `npm test` (Node's built-in test runner) |

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `PORT` | no | Listen port (default 3000; Render sets it) |
| `CLIENT_URL` | recommended | Allowed browser origins, comma-separated. Defaults to the production site and local dev servers |
| `DATABASE_URL` | yes, in production | Supabase session pooler string for the `polashi_app` role. Without it the game runs and nothing is logged |
| `MAX_ROOMS` | no | Live rooms allowed on this instance (default 1000, sized for 512 MB of RAM; see below) |
| `MAX_CONNECTIONS` | no | Open connections allowed on this instance (default 5000; `0` turns the cap off) |
| `MAX_SOCKETS_PER_IP` | no | Open connections from one address (default 40, enough for a full party on one Wi-Fi; `0` = off) |
| `MAX_ROOMS_PER_IP` | no | Live rooms created from one address (default 10; `0` = off) |

## Scripts

```sh
npm ci
npm start         # node server.js
npm test          # full games, security checks, validation, game log events; no external services needed
npm run migrate   # apply new files in db/migrations; DATABASE_URL must be the postgres role's string
```

The database tests run only when `TEST_DATABASE_URL` points at a local Postgres they may wipe:

```sh
docker run -d --name polashi-test-pg -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:54329/postgres npm test
```

Games logged to Firestore before the move were copied in with `scripts/import-firestore.js`
(`postgres-migration.md`, section 6). Firebase has since been removed from the server.

`.github/workflows/db-keepalive.yml` queries the database every 3 days, so the free Supabase
project never pauses, and takes an encrypted backup every Sunday (secrets `BACKUP_DATABASE_URL`, for
the read-only `polashi_readonly` role, and `BACKUP_PASSPHRASE`). To restore one, download the
artifact and run `gpg -d polashi-<date>.dump.gpg > polashi.dump`, then `pg_restore`.

## Security model

- A socket acts only as the player it created, joined or reconnected as. `requesterId` and
  `playerId` in payloads are ignored for authorization.
- Each seat has a secret `reconnectToken`, sent only to its owner in `roomJoined`. Rejoining a seat
  (`reconnectPlayer`) requires it.
- Every room sent to a client goes through `roomViewer` in `game/room.js`: other players' characters
  are hidden until the game ends (observers see all, by design), open votes show only who has voted,
  closed mission votes are anonymous, and socket ids, tokens, device keys and log state are never
  sent. The game logs record who sabotaged each mission; nothing a player can reach reads them.
- Every event payload is validated; handlers can't crash the process. Each socket is rate limited,
  messages are capped at 16 KB, rooms are capped and swept when abandoned (nobody online for 30
  minutes, or no activity for 12 hours).
- The WebSocket upgrade checks the `Origin` header against `CLIENT_URL`. That stops other websites,
  not scripts (which send any Origin), so connections are also capped per address and in total.
- Per address: at most `MAX_SOCKETS_PER_IP` open connections, `MAX_ROOMS_PER_IP` live rooms, one
  event budget shared by all of its sockets, and 120 HTTP requests a minute. A room nobody joined
  is removed 10 minutes after its host goes offline instead of 30.
- The address is read from `CF-Connecting-IP`, which Render's Cloudflare edge always overwrites, so
  it can't be forged. On startup the first connection logs `Client addresses are read from: ...`;
  on Render it should say `cf-connecting-ip`. If it says anything else, every visitor may share one
  address: raise or switch off the per-address caps until that's resolved.

## Deploying with the frontend

Deploy the frontend first, then this server. The current frontend stores and sends the reconnect
token; an older frontend doesn't, so after this server is deployed a player on an old tab who
refreshes mid-game is asked to join again instead of being put back in their seat.

## Capacity

Measured on 2026-10-03 against the deployed server (`polashi-game-backend.onrender.com`), with bots
playing complete games over real sockets from one machine. One address may hold 40 connections and
10 rooms (`MAX_SOCKETS_PER_IP`, `MAX_ROOMS_PER_IP`), so the runs stay at that ceiling: they show how
the live server behaves with several busy parties, not where the instance runs out.

| Run (5 minutes each) | Open sockets | Games completed | Events/s | Action latency p50 / p95 / p99 | Steps that stalled |
|---|---|---|---|---|---|
| 4 games x 7 players | 34 | 131 | 23 | 256 / 709 / 1,460 ms | 0 |
| 7 games x 5 players | 39 | 101 | 15 | 311 / 2,294 / 4,780 ms | 11 |
| 5 games x 7 players | 35 | 58 | 10 | 269 / 1,595 / 4,263 ms | 31 |

Latency is the time from a bot's action to the host receiving the resulting room update, and it
includes the network: an idle round trip from the test machine took 250-300 ms, so the medians are
almost entirely network time.

- The server kept up in every run. No action was rate limited, the health check answered in about
  300 ms throughout, and the instance didn't restart.
- The per-address cap works in production: the 40th connection from the test machine was refused
  (HTTP 400).
- Connections fail at Render's Cloudflare edge whether or not there is load. Opening 30 websockets
  one at a time with nothing else running, 6 were refused with HTTP 520. In the last run 7
  connections also dropped mid-game (`ping timeout`). The bots don't reconnect, so their games
  stalled, which is why the later runs completed fewer games. The frontend retries (from 1 s up to
  30 s apart) and rejoins with its reconnect token, so a player sees a delay instead of losing
  their seat.
- The tests sent about 180 MB of outbound traffic (Render's Metrics tab), roughly 0.6 MB per
  completed game. That is an upper bound, since it also covers the stalled games and the
  connection tests.
- Memory and CPU weren't measured. The instance is on Render's free plan, whose Metrics tab shows
  only outbound bandwidth; memory and CPU need a paid plan. Finding the instance's real limit also
  needs more addresses than one machine has, or the per-address caps raised for the duration of a
  test.

`MAX_ROOMS` defaults to 1000 because earlier local measurements (about 30 KB per connected player on
a ~90 MB baseline) put that near the ceiling of a 512 MB instance. Rooms live in one process's
memory, so the server can't be scaled across instances as it stands, and a restart or deploy ends
every game in progress.
