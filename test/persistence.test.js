// Saved rooms: a game survives the server it started on. Two servers over one
// in-memory database (test/memoryRoomStore.js) stand in for the old and new
// process during a deploy. test/db.test.js runs the same hand-off against
// Postgres. See persist-rooms.md.
const test = require("node:test");
const assert = require("node:assert/strict");
const { MISSION_CONFIGS } = require("../game/constants");
const { serializeRoom, deserializeRoom } = require("../game/roomState");
const { createRoomPersistence } = require("../game/roomPersistence");
const { createMemoryDb, createMemoryRoomStore } = require("./memoryRoomStore");
const { startServer, next, silence, setupRoom, startGame, playRound, rejoinAll } = require("./helpers");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Records game log events by the game's database id, the way GameLogger
// would see them, so a restored game can be shown to carry its id across.
function fakeLogger() {
  const calls = [];
  let games = 0;
  const record = (event) => (game, data) => {
    if (event === "gameStarted") game.id = String(++games);
    calls.push([event, game.id, data]);
  };
  return {
    calls,
    gameStarted: record("gameStarted"),
    proposalResolved: record("proposalResolved"),
    missionResolved: record("missionResolved"),
    investigation: record("investigation"),
    gameEnded: record("gameEnded"),
  };
}

// A server that saves its rooms to `db`, as process `id`.
async function savingServer(db, id, options = {}) {
  const srv = await startServer({ roomStore: createMemoryRoomStore(db, id), persistFlushMs: 20, ...options });
  await srv.start();
  return srv;
}

// One player returns to `srv` with their saved seat, as the frontend does after
// a disconnect. Their socket in `setup` is replaced by the new one.
async function rejoin(srv, player, roomCode) {
  const socket = await srv.client();
  const joined = next(socket, "roomJoined");
  socket.emit("reconnectPlayer", { roomCode, playerId: player.id, reconnectToken: player.token });
  const data = await joined;
  player.socket = socket;
  return data;
}

// The room as saved, minus what legitimately changes when players return.
function comparable(room) {
  const { room: saved } = serializeRoom(room);
  delete saved.lastActivity;
  return saved;
}

// Plays a round up to an open council vote that `voters` have voted in.
async function openCouncilVote(setup, voters) {
  const { roomCode, players, host } = setup;
  let update = next(host.socket, "roomUpdated", (r) => r.players.some((p) => p.isGeneral));
  host.socket.emit("assignGeneral", { roomCode });
  let room = await update;
  const general = players.find((p) => p.id === room.players.find((q) => q.isGeneral).id);
  const size = MISSION_CONFIGS[room.activePlayerIds.length][room.currentRound - 1].players;
  const team = room.activePlayerIds.slice(0, size);
  for (let i = 1; i <= team.length; i++) {
    update = next(host.socket, "roomUpdated", (r) => r.proposedTeam.length === i);
    general.socket.emit("proposeTeam", { roomCode, playerIds: team.slice(0, i) });
    await update;
  }
  update = next(host.socket, "roomUpdated", (r) => r.voting?.active && r.voting.type === "teamApproval");
  general.socket.emit("startVote", { roomCode });
  await update;
  update = next(host.socket, "roomUpdated", (r) => r.voting && Object.keys(r.voting.votes).length === voters.length);
  voters.forEach((p) => p.socket.emit("castVote", { roomCode, choice: "yes" }));
  await update;
  return team;
}

// --- Converting rooms ---------------------------------------------------------

test("a room survives the trip to JSON and back, minus what belongs to the old process", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 7);
  await startGame(srv, setup);
  await playRound(setup);
  await openCouncilVote(setup, setup.players.slice(0, 3));
  const room = srv.rooms[setup.roomCode];
  room.gameLog.id = "42";
  room.gameLog.openProposalId = "7";
  room.gameLog.teams = new Map([["a", "EIC"]]);

  const saved = JSON.parse(JSON.stringify(serializeRoom(room)));
  assert.equal(JSON.stringify(saved).includes(room.creatorIp), false);
  assert.ok(saved.room.players.every((p) => p.socketId === null && p.online === false));

  const back = deserializeRoom(saved);
  assert.equal(back.creatorIp, undefined);
  assert.ok(back.players.every((p) => p.socketId === null && !p.online && p.awaitingRestore));
  assert.ok(back.playerStats instanceof Map);
  assert.deepEqual([...back.playerStats], [...room.playerStats]);
  assert.ok(back.voting.startedAt instanceof Date);
  assert.equal(back.voting.startedAt.getTime(), room.voting.startedAt.getTime());
  assert.deepEqual(back.gameLog, { id: "42", openProposalId: "7", teams: new Map([["a", "EIC"]]) });

  // Everything else comes back exactly: roles, votes, scores, history, secrets.
  const { creatorIp, gameLog, playerStats, voting, ...rest } = room;
  for (const [key, value] of Object.entries(rest)) {
    if (key === "players") continue;
    assert.deepEqual(back[key], value, key);
  }
  assert.deepEqual(back.voting.votes, voting.votes);
  back.players.forEach((p, i) => {
    const { socketId, online, awaitingRestore, ...was } = { ...room.players[i], awaitingRestore: true };
    const { socketId: s2, online: o2, awaitingRestore: a2, ...now } = p;
    // JSON drops fields set to undefined (a missing playerKey), which every
    // reader treats the same as absent.
    assert.deepEqual(now, JSON.parse(JSON.stringify(was)));
  });
});

test("the saved copy is taken at once and doesn't follow later changes", () => {
  const room = { players: [{ id: "a", name: "A", socketId: "s", online: true }], scoreGreen: 1, lastActivity: 1 };
  const saved = serializeRoom(room);
  room.scoreGreen = 2;
  room.players[0].name = "B";
  assert.equal(saved.room.scoreGreen, 1);
  assert.equal(saved.room.players[0].name, "A");
});

test("a saved room in a format this version doesn't know is refused, not guessed at", () => {
  assert.throws(() => deserializeRoom({ v: 99, room: { players: [] } }), /Unrecognised/);
  assert.throws(() => deserializeRoom(null), /Unrecognised/);
  assert.throws(() => deserializeRoom({ v: 1, room: {} }), /Unrecognised/);
});

// --- Deploys ----------------------------------------------------------------------

test("a game in the middle of a council vote carries on after a deploy, and plays to the end", async (t) => {
  const db = createMemoryDb();
  const logger = fakeLogger();
  const a = await savingServer(db, "old", { logger });
  t.after(() => a.stop());
  const setup = await setupRoom(a, 7);
  const { roomCode } = setup;
  await startGame(a, setup);
  await playRound(setup);
  const team = await openCouncilVote(setup, setup.players.slice(0, 3));
  const before = comparable(a.rooms[roomCode]);

  // The new server starts while the old one is still running (Render overlaps them).
  const b = await savingServer(db, "new", { logger });
  t.after(() => b.stop());

  // A player whose connection dropped reaches the new server early. The old
  // one still holds the room, so they are asked to wait, not sent away.
  const early = await b.client();
  const wait = next(early, "serverUpdating");
  const sentAway = silence(early, "roomDissolved", () => true, 300);
  early.emit("reconnectPlayer", { roomCode, playerId: setup.players[3].id, reconnectToken: setup.players[3].token });
  assert.deepEqual(await wait, { retryInMs: 2000 });
  assert.equal(await sentAway, true);
  assert.equal(b.rooms[roomCode], undefined);

  // The old server gets SIGTERM: it hands its rooms on and disconnects everyone.
  await a.handOff();
  await a.stop();

  // Everyone reconnects to the new server and is back in their seat.
  const views = await rejoinAll(b, setup);
  for (const [i, { room }] of views.entries()) {
    const p = setup.players[i];
    const me = room.players.find((q) => q.id === p.id);
    assert.ok(me.character, "each player sees their own role again");
    assert.ok(room.players.filter((q) => q.id !== p.id).every((q) => q.character === null), "and nobody else's");
  }
  assert.deepEqual(comparable(b.rooms[roomCode]), before);

  // The open vote kept its three votes; the other four finish it.
  const council = next(setup.host.socket, "roomUpdated", (r) => r.voting && !r.voting.active);
  setup.players.slice(3).forEach((p) => p.socket.emit("castVote", { roomCode, choice: "yes" }));
  assert.equal((await council).voting.result, "Yes");

  let update = next(setup.host.socket, "roomUpdated", (r) => r.voting?.active && r.voting.type === "missionOutcome");
  setup.host.socket.emit("startSecretVote", { roomCode });
  await update;
  update = next(setup.host.socket, "roomUpdated", (r) => r.voting && !r.voting.active);
  setup.players.filter((p) => team.includes(p.id)).forEach((p) => p.socket.emit("castVote", { roomCode, choice: "yes" }));
  let room = await update;
  assert.equal(room.scoreGreen, 2);

  ({ room } = await playRound(setup));
  assert.equal(room.gameStatus, "MIR_JAFOR_TURN");
  const server = b.rooms[roomCode];
  const mirJafor = setup.players.find((p) => p.id === server.players.find((q) => q.character?.id === 1).id);
  const over = next(setup.host.socket, "roomUpdated", (r) => r.gameStatus === "OVER");
  mirJafor.socket.emit("attemptAssassination", { roomCode, targetId: setup.players.find((p) => p !== mirJafor).id });
  await over;

  // Every log event, before and after the deploy, belongs to the one game.
  assert.deepEqual(logger.calls.map((c) => c[1]), logger.calls.map(() => "1"));
  assert.deepEqual(logger.calls.map((c) => c[0]), [
    "gameStarted",
    "proposalResolved", "missionResolved",
    "proposalResolved", "missionResolved",
    "proposalResolved", "missionResolved",
    "gameEnded",
  ]);
  // The deploy isn't held against anyone: no disconnects or reconnects counted.
  const [, , ended] = logger.calls.at(-1);
  assert.ok(ended.players.every((p) => p.disconnects === 0 && p.reconnects === 0));
});

test("after a hand-off, the old server changes nothing and sends returning players on", async (t) => {
  const db = createMemoryDb();
  const a = await savingServer(db, "old");
  t.after(() => a.stop());
  const setup = await setupRoom(a, 5);
  await startGame(a, setup);
  await a.handOff();

  // Too late to change anything here: the saved copy is final.
  const quiet = silence(setup.host.socket, "roomUpdated");
  setup.host.socket.emit("assignGeneral", { roomCode: setup.roomCode });
  assert.equal(await quiet, true);

  const wait = next(setup.players[1].socket, "serverUpdating");
  setup.players[1].socket.emit("reconnectPlayer", {
    roomCode: setup.roomCode, playerId: setup.players[1].id, reconnectToken: setup.players[1].token,
  });
  assert.deepEqual(await wait, { retryInMs: 2000 });

  const refused = next(setup.host.socket, "errorMessage");
  setup.host.socket.emit("createRoom", { name: "Late" });
  assert.match(await refused, /updating/);
  assert.equal(db.rooms.get(setup.roomCode).released, true);
});

test("a crashed server's rooms are taken over once its heartbeat runs out", async (t) => {
  const db = createMemoryDb();
  const a = await savingServer(db, "crashed");
  const setup = await setupRoom(a, 5);
  await startGame(a, setup);
  await a.persistence.flush();
  // No hand-off: the process just dies.
  await a.stop();

  const b = await savingServer(db, "new");
  t.after(() => b.stop());
  const s = await b.client();
  const wait = next(s, "serverUpdating");
  s.emit("reconnectPlayer", { roomCode: setup.roomCode, playerId: setup.host.id, reconnectToken: setup.host.token });
  await wait;

  // Thirty seconds without a heartbeat and the room is free to take.
  const realNow = db.now;
  db.now = () => realNow() + 31 * 1000;
  const { room } = await rejoin(b, setup.host, setup.roomCode);
  assert.equal(room.gameStarted, true);
});

test("a new player can join a saved lobby on the new server", async (t) => {
  const db = createMemoryDb();
  const a = await savingServer(db, "old");
  const setup = await setupRoom(a, 3);
  await a.handOff();
  await a.stop();

  const b = await savingServer(db, "new");
  t.after(() => b.stop());
  const s = await b.client();
  const joined = next(s, "roomJoined");
  s.emit("joinRoom", { roomCode: setup.roomCode.toLowerCase(), name: "Latecomer" });
  const { room } = await joined;
  assert.deepEqual(room.players.map((p) => p.name), ["Host", "Player 1", "Player 2", "Latecomer"]);
  // The players who haven't come back yet show as offline.
  assert.deepEqual(room.players.map((p) => p.online), [false, false, false, true]);
});

test("players who never come back: the saved room expires and its game log is closed", async (t) => {
  const db = createMemoryDb();
  const logger = fakeLogger();
  const a = await savingServer(db, "old", { logger });
  const setup = await setupRoom(a, 5);
  await startGame(a, setup);
  await a.handOff();
  await a.stop();

  const b = await savingServer(db, "new", { logger, roomIdleMs: 50, loneRoomIdleMs: 50 });
  t.after(() => b.stop());
  await sleep(80);
  await b.sweepSavedRooms();
  assert.equal(db.rooms.size, 0);
  const [event, gameId, data] = logger.calls.at(-1);
  assert.deepEqual([event, gameId, data.status, data.reason], ["gameEnded", "1", "abandoned", "swept_idle"]);
});

test("a saved room that is still in use, or not idle long enough, is not swept", async (t) => {
  const db = createMemoryDb();
  const a = await savingServer(db, "old", { roomIdleMs: 50, loneRoomIdleMs: 50 });
  t.after(() => a.stop());
  const setup = await setupRoom(a, 3);
  await a.persistence.flush();
  await sleep(80);

  // Idle long enough, but the old server is alive and holds it.
  const b = await savingServer(db, "new", { roomIdleMs: 50, loneRoomIdleMs: 50 });
  t.after(() => b.stop());
  await b.sweepSavedRooms();
  assert.ok(db.rooms.has(setup.roomCode));

  // Handed on, but not idle long enough on the new server's clock.
  const c = await savingServer(db, "third", { roomIdleMs: 60 * 60 * 1000, loneRoomIdleMs: 60 * 60 * 1000 });
  t.after(() => c.stop());
  await a.handOff();
  await c.sweepSavedRooms();
  assert.ok(db.rooms.has(setup.roomCode));
});

// --- While running -----------------------------------------------------------------

test("every change is saved within a moment, and deleted rooms are deleted", async (t) => {
  const db = createMemoryDb();
  const a = await savingServer(db, "only");
  t.after(() => a.stop());
  const setup = await setupRoom(a, 5);
  assert.ok(db.rooms.has(setup.roomCode), "a new room is saved before it is used");
  await startGame(a, setup);
  await sleep(60);
  assert.equal(db.rooms.get(setup.roomCode).state.room.gameStarted, true);

  // Closed by the host.
  const dissolved = next(setup.players[1].socket, "roomDissolved");
  setup.host.socket.emit("closeRoom", { roomCode: setup.roomCode });
  await dissolved;
  await sleep(200);
  assert.equal(db.rooms.has(setup.roomCode), false);

  // Emptied by its last player leaving.
  const lone = await setupRoom(a, 1);
  assert.ok(db.rooms.has(lone.roomCode));
  lone.host.socket.emit("leaveRoom", { roomCode: lone.roomCode });
  await sleep(100);
  assert.equal(db.rooms.has(lone.roomCode), false);
});

test("the database going down never stops play, and saving catches up when it's back", async (t) => {
  const db = createMemoryDb();
  const errors = [];
  const a = await savingServer(db, "only", { log: { info() {}, warn() {}, error: (...m) => errors.push(m.join(" ")) } });
  t.after(() => a.stop());
  db.failing = true;
  const setup = await setupRoom(a, 5);
  await startGame(a, setup);
  const { room } = await playRound(setup);
  assert.equal(room.scoreGreen, 1);
  assert.equal(db.rooms.size, 0);
  // Logged once, not once a second.
  await sleep(100);
  assert.equal(errors.filter((e) => e.includes("(save)")).length, 1);

  db.failing = false;
  await a.persistence.flush();
  assert.equal(db.rooms.get(setup.roomCode).state.room.scoreGreen, 1);
});

test("a returning player whose room can't be looked up keeps their seat and is asked to retry", async (t) => {
  const db = createMemoryDb();
  const a = await savingServer(db, "old");
  const setup = await setupRoom(a, 5);
  await a.handOff();
  await a.stop();

  const b = await savingServer(db, "new");
  t.after(() => b.stop());
  db.failing = true;
  const s = await b.client();
  const wait = next(s, "serverUpdating");
  const sentAway = silence(s, "roomDissolved", () => true, 300);
  s.emit("reconnectPlayer", { roomCode: setup.roomCode, playerId: setup.host.id, reconnectToken: setup.host.token });
  await wait;
  assert.equal(await sentAway, true);

  db.failing = false;
  await rejoin(b, setup.host, setup.roomCode);
});

test("a room that really is gone is still reported gone", async (t) => {
  const db = createMemoryDb();
  const b = await savingServer(db, "new");
  t.after(() => b.stop());
  const s = await b.client();
  const gone = next(s, "roomDissolved");
  s.emit("reconnectPlayer", { roomCode: "ZZZZZZ", playerId: "p", reconnectToken: "t" });
  assert.deepEqual(await gone, { reason: "room_gone" });
});

test("only real room codes reach the database, and a missing one is remembered briefly", async (t) => {
  const db = createMemoryDb();
  const store = createMemoryRoomStore(db, "only");
  let loads = 0;
  const load = store.load;
  store.load = (code) => { loads++; return load(code); };
  const srv = await startServer({ roomStore: store, persistFlushMs: 20 });
  t.after(() => srv.stop());
  await srv.start();
  const s = await srv.client();
  for (const code of ["abc", "TOOLONGCODE", "ZZZZZZ", "zzzzzz"]) {
    const reply = next(s, "errorMessage");
    s.emit("joinRoom", { roomCode: code, name: "X" });
    assert.equal(await reply, "Room not found");
  }
  assert.equal(loads, 1);
});

test("a code already used by a saved room is never handed out again", async () => {
  const db = createMemoryDb();
  const rooms = Object.create(null);
  const persistence = createRoomPersistence({ store: createMemoryRoomStore(db, "a"), rooms, log: console });
  const room = { players: [{ id: "h", name: "H" }], lastActivity: Date.now() };
  assert.equal(await persistence.create("ABCDEF", room), "ok");
  const other = createRoomPersistence({ store: createMemoryRoomStore(db, "b"), rooms: Object.create(null), log: console });
  assert.equal(await other.create("ABCDEF", room), "taken");
  persistence.stop();
  other.stop();
});

test("restored players' hidden fields never reach a client", async (t) => {
  const db = createMemoryDb();
  const a = await savingServer(db, "old");
  const setup = await setupRoom(a, 5);
  await startGame(a, setup);
  await a.handOff();
  await a.stop();
  const b = await savingServer(db, "new");
  t.after(() => b.stop());
  const { room } = await rejoin(b, setup.host, setup.roomCode);
  for (const p of room.players) {
    assert.deepEqual(Object.keys(p).filter((k) => ["socketId", "reconnectToken", "awaitingRestore", "playerKey"].includes(k)), []);
  }
});

test("without a room store nothing is saved and the server behaves as before", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  assert.equal(srv.persistence, null);
  await srv.start();
  const setup = await setupRoom(srv, 5);
  await startGame(srv, setup);
  await srv.handOff();
  // Handing off still stops the server taking new rooms, and saves nothing.
  const s = await srv.client();
  const refused = next(s, "errorMessage");
  s.emit("createRoom", { name: "Late" });
  assert.match(await refused, /updating/);
});
