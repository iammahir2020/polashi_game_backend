# Migrate palassy-backend from Express+Socket.IO to idiomatic NestJS

**Branch:** `feat/nestjs-migration` · **Status:** Phase 1 in progress

This document is the migration's plan *and* its progress log. Check boxes off as steps land; record decisions inline as they're made.

---

## Context

`palassy-backend` is an ~840-line single-file Express + Socket.IO server (`server.js`) running a Bengali social-deduction game (Avalon-style, Battle of Plassey theme). All game state lives in one in-memory `rooms` object, 19 socket events are handled in a single `io.on("connection")` block, and game logs go to Firestore while a parallel MongoDB logger sits commented out.

Two goals, in priority order:

1. **Learn NestJS properly.** The rewrite is the vehicle, and the result should look like a Nest codebase a professional would recognise — not a `server.js` wearing decorators. Every file is written with a teaching layer: annotated as each Nest concept first appears, plus a `LEARNING.md` accumulating the old→new diffs and the reasoning.
2. **Get a maintainable backend.** The current file has real defects (unauthenticated assassination that can crash the process, a vote deadlock when a player leaves, secret intel that leaks team membership by list length). These are deliberately **not** fixed during the port — Phase 1 is a structural translation, so any breakage is unambiguously a port bug. Phase 2 fixes them on the new structure.

**Hard constraint: the client-facing contract cannot change.** The frontend is a *separate repo* (`palassy-game/`, React 19 + Vite, deployed to Vercel, remote `polashi_game_frontend`). It connects with `transports: ["websocket"]` only, to a hardcoded URL, and makes **no REST calls at all** — Socket.IO is the entire API surface. Every event name, payload field, and emitted room field must survive the port intact.

## Working agreement

- Old JS files stay on disk until the port is verified, then get deleted in a final commit.
- **Before writing each file, the old JS and new TS are shown side by side**, with a note on what moved where and which Nest concept is doing the work. This is the primary learning mechanism, not optional.
- One commit per step, each independently reviewable.

## Architecture

Standard Nest layering, with the boundaries enforced as actual rules rather than aspirations:

```
GameGateway          transport only — 3-5 lines per handler
     ↓ delegates
RoomService / GameService    orchestration: authz, side effects, broadcast
     ↓ calls                      ↓ injects
rules/*.ts (pure)          RoomsStore / GAME_LOG_STORE
no decorators, no I/O      @Injectable state + persistence port
```

Three rules that keep it honest:

1. **Services never import `socket.io`.** A service returns *what changed*; the gateway decides who to emit it to. This is what makes the game logic testable without a socket server.
2. **`rules/` has no Nest decorators and no I/O.** Vote resolution, deck construction, and intel derivation are pure functions over plain data — they unit-test in milliseconds with no `Test.createTestingModule` at all.
3. **Nothing reads `process.env` outside the config module.** `ConfigService` everywhere else, with the schema validated at boot so a missing `FIREBASE_PRIVATE_KEY` fails loudly on startup instead of mysteriously at the first game.

## Target structure

```
src/
  main.ts                          bootstrap: global pipes/filters, CORS, shutdown hooks
  app.module.ts                    root — imports Config, Logging, Game, Analytics
  app.controller.ts                GET / health check

  config/
    config.module.ts               @nestjs/config, isGlobal
    env.validation.ts              class-validator schema, fails fast at boot

  common/
    filters/ws-exception.filter.ts translates thrown errors → legacy `errorMessage`
    filters/http-exception.filter.ts

  game/
    game.module.ts
    game.gateway.ts                19 @SubscribeMessage handlers, thin
    room.service.ts                lobby: create/join/leave/kick/lock/reconnect
    game.service.ts                flow: start, general, propose, vote, guptochor
    room-view.service.ts           per-recipient personalization
    rooms.store.ts                 @Injectable wrapper over the in-memory Map
    rules/                         ← pure, decorator-free, no I/O
      deck.ts                      character selection + distribution
      voting.ts                    resolveVote(), mission thresholds
      intel.ts                     secret-intel derivation
      shuffle.ts
    constants/characters.ts        CharacterList, fake names, MISSION_CONFIGS
    dto/*.dto.ts                   one validated class per inbound event
    types/room.types.ts            Room, Player, Character, Voting

  logging/
    logging.module.ts              picks a driver from config at boot
    game-log.store.ts              GameLogStore interface + GAME_LOG_STORE token
    firestore-game-log.store.ts
    mongo-game-log.store.ts
    firebase-admin.provider.ts     async factory provider
    schemas/game-log.schema.ts     @Schema/@Prop

  analytics/
    analytics.module.ts
    analytics.controller.ts        4 routes, @ApiTags-documented
    dto/*.response.ts              typed response shapes for Swagger

test/                              *.spec.ts colocated; e2e here
scripts/smoke-client.ts            headless Socket.IO client, replays a full game
```

`tsconfig` gets `strict: true` and path aliases (`@game/*`, `@logging/*`) so imports don't degrade into `../../..`.

## Where the old code goes

| Old | New | Nest concept it teaches |
|---|---|---|
| `server.js:12-28` express/cors/io setup | `main.ts` + `@WebSocketGateway` | bootstrap, adapters |
| `server.js:30-32` `mongoose.connect` | `MongooseModule.forRootAsync` | async module config |
| `server.js:37` `const rooms = {}` | `RoomsStore` | singleton providers, DI |
| `server.js:39-148` lookup tables | `game/constants/characters.ts` | `as const`, typed tables |
| `server.js:153-162` `shuffle` | `game/rules/shuffle.ts` | pure module, no DI |
| `server.js:164-238` `broadcastRoomUpdate` | `RoomViewService` + `rules/intel.ts` | splitting view-building from transport |
| `server.js:240-242` `GET /` | `AppController` | `@Controller`/`@Get` |
| `server.js:246-732` connection block | `GameGateway`, one method per event | `@SubscribeMessage`, `@MessageBody`, `OnGatewayConnection` |
| `server.js:463-527` vote resolution | `rules/voting.ts` | pure logic, trivially testable |
| `server.js:557-576` deck build | `rules/deck.ts` | same |
| `server.js:734-834` analytics routes | `AnalyticsController` | controllers, Swagger decorators |
| `GameLogger.js` | `FirestoreGameLogStore` | interface implementation |
| `GameLoggerMongo.js` | `MongoGameLogStore` | `@InjectModel` |
| `models/GameLog.js` | `schemas/game-log.schema.ts` | `@Schema`/`@Prop` |
| `firebase-admin.js` | `firebase-admin.provider.ts` | custom `useFactory` providers |
| `console.log` (11 sites) | `Logger` with per-class context | structured logging |

## Contract details that must not break

Load-bearing strings the frontend depends on. Each is a place where the idiomatic Nest default is *wrong* for this app:

- **`errorMessage` is emitted as a bare string, not an object** — and the client substring-matches `"not found"` on it to decide whether to purge localStorage. Nest's default WS exception handling emits an `exception` event with a structured body, which this client ignores entirely. **A custom `WsExceptionFilter` must translate thrown exceptions into `socket.emit('errorMessage', message)`.** Single highest-risk detail in the migration.
- **`guptochorResult.alliance`** must keep containing the substring `"Nawabs"` — the client branches on it.
- **`notification`** must keep carrying `requesterId` and `targetId`; the client uses them to suppress the message for the actor and rewrite it for the target.
- **Inconsistent actor field names must be preserved:** `requesterId` for GM commands, `playerId` for `castVote`/`leaveRoom`/`reconnectPlayer`, and `targetId` (not `targetPlayerId`) for `attemptAssassination`.
- **`closeRoom`'s 100 ms `setTimeout`** (`server.js:339`) must stay — the client needs `roomDissolved` to land before the room is deleted.
- **Default Socket.IO path `/socket.io`; websocket transport must work without a polling upgrade**, since the client disables polling.

### Client wire contract (reference)

Emitted by client → server:

| Event | Payload |
|---|---|
| `getCharacterList` | — |
| `createRoom` | `{ name }` |
| `joinRoom` | `{ roomCode, name }` |
| `reconnectPlayer` | `{ roomCode, playerId }` |
| `leaveRoom` | `{ roomCode, playerId }` |
| `closeRoom` | `{ roomCode, requesterId }` |
| `setRoomLock` | `{ roomCode, locked, requesterId }` |
| `kickPlayer` | `{ roomCode, targetPlayerId, requesterId }` |
| `startGame` | `{ roomCode, requesterId, activeIds, selectedCharIds, disableSecretIntelligence }` |
| `setDisableSecretIntelligence` | `{ roomCode, requesterId, disableSecretIntelligence }` |
| `assignGeneral` | `{ roomCode, requesterId }` |
| `resetGame` | `{ roomCode, requesterId }` |
| `startVote` / `startSecretVote` / `clearVote` | `{ roomCode, requesterId }` |
| `castVote` | `{ roomCode, playerId, choice }` |
| `proposeTeam` | `{ roomCode, playerIds }` |
| `investigatePlayer` | `{ roomCode, targetPlayerId, requesterId }` |
| `attemptAssassination` | `{ roomCode, targetId, requesterId }` |
| `makeMove` | `{ roomCode, playerId, move }` — dead, never called |

Emitted by server → client: `characterListUpdate`, `roomJoined`, `roomUpdated`, `roomDissolved`, `triggerGeneralAnimation`, `errorMessage`, `kicked`, `guptochorResult`, `notification`.

Room fields the client **reads**: `players[]` (`id`, `name`, `online`, `isGameMaster`, `isGeneral`, `character`), `roomCode`, `locked`, `gameStarted`, `gameStatus`, `winner`, `currentRound`, `roundHistory`, `disableSecretIntelligence`, `secretIntel`, `voting` (incl. full `votes` map), `proposedTeam`, `activePlayerIds`, `guptochorId`, `guptochorUsed`.

Room fields the client **never reads** (safe to stop sending): `nextGuptochorId`, `generalHistory`, `turnIndex`, `scoreGreen`, `scoreRed`, `player.socketId`, `player.isObserver`.

---

## Phase 1 — structural port

Phase 1 is *contract-identical with the real client*, not byte-identical for every conceivable input: validation is on from the start (Step 1), so malformed payloads now get a clean `errorMessage` instead of silently corrupting state or crashing. The real frontend never sends those, so the observable contract is unchanged.

- [ ] **Step 0 — Scaffold.** Nest layout, `strict: true`, ESLint + Prettier, Jest. `main.ts` with `enableShutdownHooks()`, global pipes and filters. Health controller returns the same `{status, rooms}` shape.

  Add `@nestjs/{common,core,platform-express,websockets,platform-socket.io,config,mongoose,swagger,testing}`, `mongoose`, `socket.io`, `class-validator`, `class-transformer`, `reflect-metadata`, `rxjs`. Keep `firebase-admin`, `uuid`. Drop `cors` and `dotenv` (Nest covers both). Scripts: `build: nest build`, `start: node dist/main`, `start:dev: nest start --watch`, `lint`, `test`.

  > Verify `@nestjs/mongoose` supports the installed `mongoose@9.x`; pin mongoose down a major if not. Render's start command must change to run the build output, and `main.ts` should `listen(port, '0.0.0.0')`.

  Enable `@typescript-eslint/no-floating-promises` — it immediately flags three real bugs where the current code fires async logger calls without awaiting (`server.js:485`, `:512`, `:716`).

- [ ] **Step 1 — DTOs, validation, exception filter.** Done *before* porting logic, so every later handler inherits it. One DTO class per event with `class-validator` decorators; global `ValidationPipe({ transform: true, whitelist: true })`.

  > Use `whitelist` but **not** `forbidNonWhitelisted` — whitelist quietly strips unknown fields, whereas forbidding them would reject the whole payload over a single mis-derived field name. Strip, don't reject.

  Then the `WsExceptionFilter`. Test it first: throw from a handler, confirm the client receives a bare-string `errorMessage`.

- [ ] **Step 2 — Types, constants, pure rules.** Domain interfaces plus `rules/{deck,voting,intel,shuffle}.ts` ported literally. Unit-test each against cases derived from the old code — the safety net for everything that follows.

  `strict: true` will flag where the old code assumes values exist (the deck built from possibly-undefined characters at `server.js:563`). **Type these honestly as `Character | undefined` and leave the behavior alone** — Phase 2 fixes them; Phase 1 just makes the latent bug visible in the type system.

- [ ] **Step 3 — `RoomsStore` + `RoomService`.** Lobby operations, GM checks ported exactly as written.

- [ ] **Step 4 — `GameService` + `RoomViewService`.** Orchestration over `rules/`. Neither imports `socket.io`; both return descriptions of what changed.

  Port the red-herring block from `server.js:205-218` as-is even though it sits pointlessly inside the `forEach` — as a pure function it becomes trivially testable, which is exactly what makes the Phase 2 fix safe.

- [ ] **Step 5 — `GameGateway`.** One `@SubscribeMessage` per event, delegating immediately. Connection lifecycle via `OnGatewayConnection`/`OnGatewayDisconnect`. Include `getCharacterList` and the dead-but-harmless `makeMove`.

- [ ] **Step 6 — `LoggingModule`, both drivers behind one port.**

  ```ts
  export interface GameLogStore {
    logGameStart(roomCode: string, room: Room): Promise<void>;
    logRoundResult(logId: string, round: number, data: RoundLog): Promise<void>;
    logGameOver(logId: string, winner: string): Promise<void>;
    getWinRates(): Promise<WinRates>;                        // reads too, so analytics
    getRecentGames(limit: number): Promise<GameSummary[]>;   // works on either driver
    getAllPlayerNames(): Promise<string[]>;
    getLogCount(): Promise<{ total: number; latestLogId: string }>;
  }
  export const GAME_LOG_STORE = Symbol('GAME_LOG_STORE');
  ```

  Driver selected by `GAME_LOG_DRIVER=firestore|mongo` via a factory provider reading `ConfigService`; **default `firestore`**, which is what production uses today. Firebase init moves into an async factory provider with `OnModuleInit`. Teaches injection tokens, custom providers, and why you inject an interface rather than `require` a concrete module.

  Firestore has no aggregation pipeline, so `getWinRates`/`getAllPlayerNames` fetch completed docs and reduce in memory — fine at this scale, worth a `LEARNING.md` note.

- [ ] **Step 7 — `AnalyticsModule`.** Four routes reading through `GAME_LOG_STORE`, `@ApiTags`-documented, Swagger UI at `/api/docs`.

  > **The only intentional deviation in Phase 1:** these endpoints currently query Mongo while logs are written to Firestore, so they always return zeros. Routed through the port they start returning real data. No frontend consumes them, so this is risk-free.

- [ ] **Step 8 — Verify, then delete.** `scripts/smoke-client.ts` drives a real Socket.IO client through create → 5 joins → startGame → assign general → propose → approve → secret vote, ×3 rounds, asserting emitted payloads. Run against old `server.js` for a baseline, then against the Nest app, and diff. Then delete `server.js`, `GameLogger.js`, `GameLoggerMongo.js`, `models/`, `firebase-admin.js`.

## Phase 2 — fixes

Each is a self-contained lesson, in payoff order:

- [ ] **1. Bind socket → player identity.** Store `{playerId, roomCode}` on `socket.data` at join/reconnect; derive the actor server-side instead of trusting `requesterId`. Collapses most auth holes at once: `proposeTeam` accepting any team from anyone, `castVote` accepting an arbitrary `playerId` (ballot stuffing), `leaveRoom` removing any player, `reconnectPlayer` handing over another player's identity and character. Teaches guards + `ExecutionContext`.
- [ ] **2. Assassination** (`server.js:704-720`): require the caller to be Mir Jafar, null-guard `room` and `targetPlayer` (an unknown `targetId` currently throws and kills the process), and route through the personalized broadcast instead of `io.to(roomCode).emit("roomUpdated", room)`, which leaks every character.
- [ ] **3. Crash guards:** `turnIndex %= 0` → `NaN` in `kickPlayer`; `assignGeneral` on an empty eligible list; `startGame` deck validation when required characters aren't selected.
- [ ] **4. Vote deadlock:** `activePlayerIds` isn't updated on leave/kick, so `targetCount` counts someone who can never vote and the round hangs forever with no reset path.
- [ ] **5. Secret-intel length leak:** a plain Nawab always gets exactly 2 fake names while a standard EIC gets (teamSize − 1) real ones — in a 5-player game that's 2 vs 1, so counting reveals your team. Fix by hoisting the loop-invariant block out of the `forEach` and matching the expected count distribution.
- [ ] **6. Room GC:** rooms are never deleted; `disconnect` only sets `online: false`. TTL sweep with `@nestjs/schedule` — teaches cron providers.
- [ ] **7. Room-code collisions:** `Math.random().toString(36).substring(2,8)` can yield fewer than 6 chars and is never checked against existing rooms, so a new room can silently overwrite a live one.
- [ ] **8. CORS:** `origin: "*"` with `credentials: true` is rejected by browsers; make the allowlist explicit.
- [ ] **9. Vote-choice redaction** — *requires a coordinated frontend change, do last.* During an active secret vote, send a `{playerId: hasVoted}` presence map instead of actual choices. The client genuinely needs the per-player map (it renders "who hasn't voted yet"), so the server can't simply drop it — `VotingSystem` in the frontend repo must change in the same commit.

## Verification

- **Per step:** `npm run build` (with `strict: true` the compiler is the first line of defence), `npm run lint`, `npm run start:dev` boots clean.
- **Unit:** pure `rules/` functions tested directly, no Nest bootstrapping. Services tested via `Test.createTestingModule` with `GAME_LOG_STORE` mocked at the token — the concrete demonstration of why DI was worth it.
- **Contract:** `scripts/smoke-client.ts` against old vs. new, payloads diffed. The real proof the port is faithful.
- **Error path:** explicitly assert that a failed GM check reaches the client as a bare-string `errorMessage`, and that a "Room not found" case still contains that substring.
- **End-to-end:** run the frontend locally against localhost. Note `src/services/socket.ts` **hardcodes** the Render URL and ignores the existing `VITE_SOCKET_URL` env var — a one-line change in the other repo, or a temporary edit to the constant.
- **Deploy:** merge to `main` only after the smoke client passes against a Render preview, since the production frontend points at a hardcoded backend URL with no fallback.
