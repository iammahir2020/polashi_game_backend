# Polashi game server

Real-time server for [The Battle of Polashi](https://the-great-polashi-game.vercel.app), an unofficial
online adaptation of Playground Inc.'s Polashi board game. Node 20, Express 5, Socket.IO 4. The
frontend lives in [polashi_game_frontend](https://github.com/iammahir2020/polashi_game_frontend).

Game state is held in memory on a single instance. Finished games are logged to Firestore
(`GameLogger.js`); the read-only statistics endpoints query MongoDB (`models/GameLog.js`).

## Layout

| Path | What it is |
|---|---|
| `server.js` | Entry point: environment, MongoDB, Firestore logger, analytics routes, `listen` |
| `game/createGameServer.js` | Express + Socket.IO server and every socket event handler |
| `game/room.js` | Per-player room view (what each client may see), secret intel, codes and tokens |
| `game/validation.js` | Payload schemas (zod) and player-name rules |
| `game/constants.js` | Characters, decoy names, mission sizes, team distribution |
| `routes/analytics.js` | `/api/analytics/*` |
| `test/` | `npm test` (Node's built-in test runner) |

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `PORT` | no | Listen port (default 3000; Render sets it) |
| `CLIENT_URL` | recommended | Allowed browser origins, comma-separated. Defaults to the production site and local dev servers |
| `MONGODB_URI` | for analytics | MongoDB connection string |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | yes | Service account for game logs |
| `ADMIN_TOKEN` | no | At least 16 characters. Enables `GET /api/analytics/all-players` with `Authorization: Bearer <token>` |
| `MAX_ROOMS` | no | Live rooms allowed on this instance (default 5000) |

## Scripts

```sh
npm ci
npm start   # node server.js
npm test    # 33 tests: full games, security checks, validation; no external services needed
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
- The WebSocket upgrade checks the `Origin` header against `CLIENT_URL`.

## Deploying with the frontend

Deploy the frontend first, then this server. The current frontend stores and sends the reconnect
token; an older frontend doesn't, so after this server is deployed a player on an old tab who
refreshes mid-game is asked to join again instead of being put back in their seat.
