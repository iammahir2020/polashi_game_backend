# Polashi game server

Real-time server for [The Battle of Polashi](https://the-great-polashi-game.vercel.app), an unofficial
online adaptation of Playground Inc.'s Polashi board game. Node 20, Express 5, Socket.IO 4. The
frontend lives in [polashi_game_frontend](https://github.com/iammahir2020/polashi_game_frontend).

Game state is held in memory on a single instance. Games are logged to Firestore
(`GameLogger.js`, `game_logs` collection).

## Layout

| Path | What it is |
|---|---|
| `server.js` | Entry point: environment, Firestore logger, `listen` |
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
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | yes | Service account for game logs |
| `MAX_ROOMS` | no | Live rooms allowed on this instance (default 1000, sized for 512 MB of RAM; see below) |
| `MAX_CONNECTIONS` | no | Open connections allowed on this instance (default 5000; `0` turns the cap off) |
| `MAX_SOCKETS_PER_IP` | no | Open connections from one address (default 40, enough for a full party on one Wi-Fi; `0` = off) |
| `MAX_ROOMS_PER_IP` | no | Live rooms created from one address (default 10; `0` = off) |

## Scripts

```sh
npm ci
npm start   # node server.js
npm test    # 43 tests: full games, security checks, validation; no external services needed
```

## Security model

- A socket acts only as the player it created, joined or reconnected as. `requesterId` and
  `playerId` in payloads are ignored for authorization.
- Each seat has a secret `reconnectToken`, sent only to its owner in `roomJoined`. Rejoining a seat
  (`reconnectPlayer`) requires it.
- Every room sent to a client goes through `roomViewer` in `game/room.js`: other players' characters
  are hidden until the game ends (observers see all, by design), open votes show only who has voted,
  closed mission votes are anonymous, and socket ids, tokens and log ids are never sent.
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

Measured locally with bots playing complete 7-player games over real sockets (Firestore
stubbed out):

| Concurrent games | Connected players | Server memory (RSS) |
|---|---|---|
| 200 | 1,400 | ~150 MB idle, ~320 MB peak |
| 1,000 | 7,000 | ~300 MB idle, ~480-500 MB peak |

A whole game costs about 20-35 ms of server CPU, so CPU isn't the limit; memory is (about 30 KB per
connected player on top of a ~90 MB baseline). On a 512 MB instance plan for roughly 500-700
simultaneous games and treat ~1,000 as the ceiling, which is why `MAX_ROOMS` defaults to 1000. Rooms
live in one process's memory, so the server can't be scaled across instances as it stands, and a
restart or deploy ends every game in progress.
