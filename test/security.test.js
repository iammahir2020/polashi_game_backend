const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, next, silence, setupRoom, startGame } = require("./helpers");

const SECRET_FIELDS = ["socketId", "reconnectToken"];

function assertNoSecrets(room) {
  for (const p of room.players) {
    for (const f of SECRET_FIELDS) assert.equal(p[f], undefined, `player.${f} leaked`);
  }
  assert.equal(room.currentLogId, undefined);
  assert.equal(room.generalHistory, undefined);
}

test("room updates hide socket ids, reconnect secrets and other players' roles", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  const room = await startGame(srv, setup);
  assertNoSecrets(room);
  const host = setup.host;
  for (const p of room.players) {
    if (p.id === host.id) assert.ok(p.character, "own character visible");
    else assert.equal(p.character, null, "others' characters hidden");
  }
});

test("rejoining mid-game does not reveal anyone else's role", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  await startGame(srv, setup);
  const me = setup.players[2];
  me.socket.close();

  const fresh = await srv.client();
  const joined = next(fresh, "roomJoined");
  fresh.emit("reconnectPlayer", { roomCode: setup.roomCode, playerId: me.id, reconnectToken: me.token });
  const data = await joined;
  assertNoSecrets(data.room);
  for (const p of data.room.players) {
    if (p.id === me.id) assert.ok(p.character);
    else assert.equal(p.character, null);
  }
});

test("a seat cannot be taken over with just the public player id", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  const victim = setup.players[1];
  const attacker = await srv.client();

  const denied = next(attacker, "errorMessage");
  attacker.emit("reconnectPlayer", { roomCode: setup.roomCode, playerId: victim.id });
  assert.equal(await denied, "Player not found in room");

  const denied2 = next(attacker, "errorMessage");
  attacker.emit("reconnectPlayer", { roomCode: setup.roomCode, playerId: victim.id, reconnectToken: "x".repeat(43) });
  assert.equal(await denied2, "Player not found in room");

  // The real owner still can.
  const owner = await srv.client();
  const ok = next(owner, "roomJoined");
  owner.emit("reconnectPlayer", { roomCode: setup.roomCode, playerId: victim.id, reconnectToken: victim.token });
  assert.equal((await ok).playerId, victim.id);
});

test("host-only actions ignore a spoofed requesterId", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  const [host, victim, attacker] = setup.players;
  const spoof = { roomCode: setup.roomCode, requesterId: host.id };

  attacker.socket.emit("kickPlayer", { ...spoof, targetPlayerId: victim.id });
  attacker.socket.emit("setRoomLock", { ...spoof, locked: true });
  attacker.socket.emit("closeRoom", spoof);
  assert.equal(await silence(host.socket, "roomDissolved"), true);
  assert.equal(srv.rooms[setup.roomCode].locked, false);
  assert.equal(srv.rooms[setup.roomCode].players.length, 5);
});

test("leaveRoom only removes the sender", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 3);
  const [host, , attacker] = setup.players;
  attacker.socket.emit("leaveRoom", { roomCode: setup.roomCode, playerId: host.id });
  await new Promise((r) => setTimeout(r, 200));
  const room = srv.rooms[setup.roomCode];
  assert.ok(room.players.some((p) => p.id === host.id), "host still present");
  assert.ok(!room.players.some((p) => p.id === attacker.id), "attacker left instead");
});

test("votes are counted once per eligible player and cannot be stuffed", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  await startGame(srv, setup);
  const room = srv.rooms[setup.roomCode];
  room.players[0].isGeneral = true;
  const open = next(setup.host.socket, "roomUpdated", (r) => r.voting && r.voting.active);
  setup.host.socket.emit("startVote", { roomCode: setup.roomCode });
  await open;

  const attacker = setup.players[3];
  for (let i = 0; i < 10; i++) {
    attacker.socket.emit("castVote", { roomCode: setup.roomCode, playerId: `fake-${i}`, choice: "no" });
  }
  attacker.socket.emit("castVote", { roomCode: setup.roomCode, choice: "maybe" });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(Object.keys(room.voting.votes), [attacker.id]);
  assert.equal(room.voting.active, true, "vote still open: only 1 of 5 voted");
});

test("votes stay hidden while open; mission choices are never tied to a player", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  await startGame(srv, setup);
  const room = srv.rooms[setup.roomCode];
  const host = setup.players[0];
  // The sabotage must come from a Company player (a Nawab's "no" counts as a
  // success). Of 5 players 2 are Company, so at least one isn't the host.
  const isEic = (p) => room.players.find((x) => x.id === p.id).character.team !== "Nawabs";
  const a = setup.players.find((p) => p !== host && isEic(p));
  const b = setup.players.find((p) => p !== host && p !== a);
  room.players.find((p) => p.id === host.id).isGeneral = true;
  room.proposedTeam = [a.id, b.id];
  room.voting = { active: false, votes: {}, result: "Yes", type: "teamApproval" };

  let update = next(host.socket, "roomUpdated", (r) => r.voting && r.voting.active && r.voting.type === "missionOutcome");
  host.socket.emit("startSecretVote", { roomCode: setup.roomCode });
  await update;

  update = next(host.socket, "roomUpdated", (r) => r.voting && Object.keys(r.voting.votes).length === 1);
  a.socket.emit("castVote", { roomCode: setup.roomCode, choice: "no" });
  const during = await update;
  assert.deepEqual(during.voting.votes, { [a.id]: true });

  update = next(host.socket, "roomUpdated", (r) => r.voting && !r.voting.active);
  b.socket.emit("castVote", { roomCode: setup.roomCode, choice: "yes" });
  const after = await update;
  assert.equal(after.voting.result, "No");
  const keys = Object.keys(after.voting.votes);
  assert.ok(!keys.includes(a.id) && !keys.includes(b.id), "choices are not keyed by player");
  assert.deepEqual(Object.values(after.voting.votes).sort(), ["no", "yes"]);
});

test("Mir Jafor's strike only works for Mir Jafor in the final phase", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  await startGame(srv, setup);
  const room = srv.rooms[setup.roomCode];
  const mirJafor = setup.players.find((p) => room.players.find((rp) => rp.id === p.id).character.id === 1);
  const someoneElse = setup.players.find((p) => p !== mirJafor);
  const target = { roomCode: setup.roomCode, targetId: someoneElse.id };

  mirJafor.socket.emit("attemptAssassination", target); // wrong phase
  someoneElse.socket.emit("attemptAssassination", { roomCode: setup.roomCode, targetId: mirJafor.id });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(room.gameStatus, "ACTIVE");

  room.gameStatus = "MIR_JAFOR_TURN";
  someoneElse.socket.emit("attemptAssassination", { roomCode: setup.roomCode, targetId: mirJafor.id });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(room.gameStatus, "MIR_JAFOR_TURN");

  const over = next(mirJafor.socket, "roomUpdated", (r) => r.gameStatus === "OVER");
  mirJafor.socket.emit("attemptAssassination", target);
  assertNoSecretsAfter(await over);
});

function assertNoSecretsAfter(room) {
  for (const p of room.players) assert.equal(p.socketId, undefined);
}

test("only the General proposes, only between votes, and never more than the mission size", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  await startGame(srv, setup);
  const room = srv.rooms[setup.roomCode];
  const [general, other] = setup.players;
  room.players[0].isGeneral = true;
  const ids = setup.players.map((p) => p.id);

  other.socket.emit("proposeTeam", { roomCode: setup.roomCode, playerIds: ids.slice(0, 2) });
  general.socket.emit("proposeTeam", { roomCode: setup.roomCode, playerIds: ids.slice(0, 4) }); // round 1 needs 2
  general.socket.emit("proposeTeam", { roomCode: setup.roomCode, playerIds: [ids[0], ids[0]] });
  general.socket.emit("proposeTeam", { roomCode: setup.roomCode, playerIds: [ids[0], "not-a-player"] });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(room.proposedTeam || [], []);

  const ok = next(general.socket, "roomUpdated", (r) => r.proposedTeam.length === 2);
  general.socket.emit("proposeTeam", { roomCode: setup.roomCode, playerIds: ids.slice(0, 2) });
  await ok;
});

test("the secret vote can only follow an approved council vote", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  await startGame(srv, setup);
  const room = srv.rooms[setup.roomCode];
  setup.host.socket.emit("startSecretVote", { roomCode: setup.roomCode });
  room.voting = { active: false, votes: {}, result: "No", type: "teamApproval" };
  setup.host.socket.emit("startSecretVote", { roomCode: setup.roomCode });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(room.voting.type, "teamApproval");
});

test("startGame rejects strangers in the battalion and incomplete character sets", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  const ids = setup.players.map((p) => p.id);
  const err1 = next(setup.host.socket, "errorMessage");
  setup.host.socket.emit("startGame", { roomCode: setup.roomCode, activeIds: [...ids.slice(0, 4), "stranger"], selectedCharIds: [1, 2, 5, 6, 8] });
  assert.match(await err1, /not in this room/);
  const err2 = next(setup.host.socket, "errorMessage");
  setup.host.socket.emit("startGame", { roomCode: setup.roomCode, activeIds: ids, selectedCharIds: [2, 5, 6, 7, 8] });
  assert.match(await err2, /enough characters/);
  assert.equal(srv.rooms[setup.roomCode].gameStarted, false);

  // Exactly what the launcher sends for 5 players (3 Nawabs incl. Mir Madan, 2 Company incl. Mir Jafor).
  const started = next(setup.host.socket, "roomUpdated", (r) => r.gameStarted);
  setup.host.socket.emit("startGame", { roomCode: setup.roomCode, activeIds: ids, selectedCharIds: [1, 2, 5, 6, 8] });
  await started;
});

test("malformed events never crash the server", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const s = await srv.client();
  const junk = [undefined, null, 42, "x", [], { roomCode: { $ne: 1 } }, { roomCode: "NOPE00", targetId: "x" }];
  const events = ["createRoom", "joinRoom", "reconnectPlayer", "leaveRoom", "closeRoom", "investigatePlayer",
    "assignGeneral", "startVote", "startSecretVote", "castVote", "clearVote", "startGame", "resetGame",
    "proposeTeam", "setRoomLock", "setDisableSecretIntelligence", "kickPlayer", "attemptAssassination"];
  for (const e of events) for (const j of junk) s.emit(e, j);
  s.emit("joinRoom", { roomCode: "ABCDEF", name: { toString: 1 } });
  await new Promise((r) => setTimeout(r, 300));

  // Still alive and answering.
  const fresh = await srv.client();
  const list = next(fresh, "characterListUpdate");
  fresh.emit("getCharacterList");
  assert.equal((await list).length, 10);
});

test("names are cleaned, clipped and kept unique within a room", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 3, ["Siraj", "S\u200Bir\u202Eaj", "  " + "x".repeat(80)]);
  const names = srv.rooms[setup.roomCode].players.map((p) => p.name);
  assert.deepEqual(names, ["Siraj", "Siraj 2", "x".repeat(24)]);

  const s = await srv.client();
  const err = next(s, "errorMessage");
  s.emit("joinRoom", { roomCode: setup.roomCode, name: " \u200B\u200B " });
  assert.equal(await err, "Please enter a name.");
});

test("event floods are throttled without disconnecting the player", async (t) => {
  const srv = await startServer({ rateLimit: { capacity: 10, refillPerSec: 5 } });
  t.after(() => srv.stop());
  const s = await srv.client();
  const warned = next(s, "errorMessage", (m) => /slow down/i.test(m));
  for (let i = 0; i < 50; i++) s.emit("getCharacterList");
  await warned;
  assert.equal(s.connected, true);
  await new Promise((r) => setTimeout(r, 400));
  const list = next(s, "characterListUpdate");
  s.emit("getCharacterList");
  await list;
});

test("rooms nobody is connected to are swept after the idle window", async (t) => {
  const srv = await startServer({ roomIdleMs: 50 });
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 2);
  setup.players.forEach((p) => p.socket.close());
  await new Promise((r) => setTimeout(r, 200));
  srv.sweepRooms();
  assert.equal(srv.rooms[setup.roomCode], undefined);
});

test("rooms with someone connected survive the idle sweep", async (t) => {
  const srv = await startServer({ roomIdleMs: 50 });
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 2);
  await new Promise((r) => setTimeout(r, 100));
  srv.sweepRooms();
  assert.ok(srv.rooms[setup.roomCode]);
});

test("browsers on other sites cannot open a socket", async (t) => {
  const srv = await startServer({ allowedOrigins: ["https://the-great-polashi-game.vercel.app"] });
  t.after(() => srv.stop());
  await assert.rejects(srv.client({ extraHeaders: { origin: "https://evil.example" } }));
  const ok = await srv.client({ extraHeaders: { origin: "https://the-great-polashi-game.vercel.app" } });
  assert.equal(ok.connected, true);
});

test("a mistyped or odd room code gets a clear answer", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const s = await srv.client();
  for (const code of ["AB", "toString", "__proto__", "ab cd!"]) {
    const err = next(s, "errorMessage");
    s.emit("joinRoom", { roomCode: code, name: "Ann" });
    assert.equal(await err, "Room not found");
  }
});

test("the room cap refuses new rooms instead of running out of memory", async (t) => {
  const srv = await startServer({ maxRooms: 1 });
  t.after(() => srv.stop());
  await setupRoom(srv, 1);
  const s = await srv.client();
  const err = next(s, "errorMessage");
  s.emit("createRoom", { name: "Late" });
  assert.match(await err, /server is full/i);
});

// Opens a secret mission vote for `team` directly in the server's room state,
// as if the council had just approved it.
async function openMissionVote(srv, setup, team) {
  const room = srv.rooms[setup.roomCode];
  const host = setup.players[0];
  room.players.find((p) => p.id === host.id).isGeneral = true;
  room.proposedTeam = team.map((p) => p.id);
  room.voting = { active: false, votes: {}, result: "Yes", type: "teamApproval" };
  const update = next(host.socket, "roomUpdated", (r) => r.voting && r.voting.active && r.voting.type === "missionOutcome");
  host.socket.emit("startSecretVote", { roomCode: setup.roomCode });
  await update;
  return room;
}

test("a Nawab's sabotage counts as a success, whatever the client sends", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  await startGame(srv, setup);
  const roles = srv.rooms[setup.roomCode].players;
  const nawabs = setup.players.filter((p) => roles.find((r) => r.id === p.id).character.team === "Nawabs").slice(0, 2);
  await openMissionVote(srv, setup, nawabs);

  // A modified client sends "no" for both Nawabs. The official client turns
  // a Nawab's SABOTAGE into a success before sending; the server now does too.
  const done = next(setup.players[0].socket, "roomUpdated", (r) => r.voting && !r.voting.active);
  nawabs.forEach((p) => p.socket.emit("castVote", { roomCode: setup.roomCode, choice: "no" }));
  const after = await done;
  assert.equal(after.voting.result, "Yes");
  assert.deepEqual(Object.values(after.voting.votes), ["yes", "yes"]);
  assert.deepEqual(after.roundHistory, ["Green"]);
});

test("a Company player's sabotage still fails the mission", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  await startGame(srv, setup);
  const roles = srv.rooms[setup.roomCode].players;
  const eic = setup.players.find((p) => roles.find((r) => r.id === p.id).character.team !== "Nawabs");
  await openMissionVote(srv, setup, [eic]);

  const done = next(setup.players[0].socket, "roomUpdated", (r) => r.voting && !r.voting.active);
  eic.socket.emit("castVote", { roomCode: setup.roomCode, choice: "no" });
  const after = await done;
  assert.equal(after.voting.result, "No");
  assert.deepEqual(after.roundHistory, ["Red"]);
});

test("Mir Jafor's strike names the winner with the same labels as the rest of the game", async (t) => {
  for (const hitMirMadan of [true, false]) {
    const srv = await startServer();
    const setup = await setupRoom(srv, 5);
    await startGame(srv, setup);
    const room = srv.rooms[setup.roomCode];
    const roleOf = (p) => room.players.find((r) => r.id === p.id).character.id;
    const mirJafor = setup.players.find((p) => roleOf(p) === 1);
    const target = setup.players.find((p) => p !== mirJafor && (roleOf(p) === 8) === hitMirMadan);
    room.gameStatus = "MIR_JAFOR_TURN";

    const over = next(mirJafor.socket, "roomUpdated", (r) => r.gameStatus === "OVER");
    mirJafor.socket.emit("attemptAssassination", { roomCode: setup.roomCode, targetId: target.id });
    const { winner } = await over;
    // "East India Company (Red)" is also what three failed missions produce.
    assert.equal(winner, hitMirMadan ? "East India Company (Red)" : "Nawabs (Green)");
    await srv.stop();
  }
});
