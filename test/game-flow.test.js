const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, next, setupRoom, startGame } = require("./helpers");
const { MISSION_CONFIGS } = require("../game/constants");

// Plays one round the way the UI does: host appoints a General, the General
// proposes a team and calls the council vote, everyone votes, the host calls the
// secret vote, the team votes.
async function playRound(setup, { council = "yes", mission = "yes" } = {}) {
  const { roomCode, players, host } = setup;
  let update = next(host.socket, "roomUpdated", (r) => r.players.some((p) => p.isGeneral));
  host.socket.emit("assignGeneral", { roomCode, requesterId: host.id });
  let room = await update;
  const generalId = room.players.find((p) => p.isGeneral).id;
  const general = players.find((p) => p.id === generalId);
  const size = MISSION_CONFIGS[room.activePlayerIds.length][room.currentRound - 1].players;
  const team = room.activePlayerIds.slice(0, size);

  for (let i = 1; i <= team.length; i++) {
    update = next(host.socket, "roomUpdated", (r) => r.proposedTeam.length === i);
    general.socket.emit("proposeTeam", { roomCode, playerIds: team.slice(0, i) });
    await update;
  }

  update = next(host.socket, "roomUpdated", (r) => r.voting && r.voting.active && r.voting.type === "teamApproval");
  general.socket.emit("startVote", { roomCode, requesterId: general.id });
  await update;

  update = next(host.socket, "roomUpdated", (r) => r.voting && !r.voting.active);
  players.forEach((p) => p.socket.emit("castVote", { roomCode, playerId: p.id, choice: council }));
  room = await update;
  if (room.voting.result !== "Yes") return { room, team };

  update = next(host.socket, "roomUpdated", (r) => r.voting && r.voting.active && r.voting.type === "missionOutcome");
  host.socket.emit("startSecretVote", { roomCode, requesterId: host.id });
  await update;

  update = next(host.socket, "roomUpdated", (r) => r.voting && !r.voting.active);
  players.filter((p) => team.includes(p.id)).forEach((p) =>
    p.socket.emit("castVote", { roomCode, playerId: p.id, choice: mission }),
  );
  room = await update;
  return { room, team };
}

test("a full game plays through to the Mir Jafor ending exactly as before", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 7);
  let room = await startGame(srv, setup);
  assert.equal(room.gameStatus, "ACTIVE");
  assert.equal(room.currentRound, 1);

  for (let i = 0; i < 3; i++) ({ room } = await playRound(setup));
  assert.equal(room.scoreGreen, 3);
  assert.equal(room.gameStatus, "MIR_JAFOR_TURN");

  // Only Mir Jafor can strike; everyone tries, one succeeds.
  const over = next(setup.host.socket, "roomUpdated", (r) => r.gameStatus === "OVER");
  setup.players.forEach((p) =>
    p.socket.emit("attemptAssassination", {
      roomCode: setup.roomCode,
      targetId: setup.players.find((o) => o.id !== p.id).id,
      requesterId: p.id,
    }),
  );
  room = await over;
  assert.match(room.winner, /Nawabs|East India Company/);
  // After the game every role is revealed.
  assert.ok(room.players.every((p) => p.character));

  assert.deepEqual(srv.calls.map((c) => c[0]), ["start", "round", "round", "round", "over"]);
});

test("three failed missions end the game for the Company", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  let room = await startGame(srv, setup);
  for (let i = 0; i < 3; i++) ({ room } = await playRound(setup, { mission: "no" }));
  assert.equal(room.gameStatus, "OVER");
  assert.equal(room.winner, "EIC (Red)");
  assert.deepEqual(room.roundHistory, ["Red", "Red", "Red"]);
});

test("a rejected team does not start a mission or change the score", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 6);
  await startGame(srv, setup);
  const { room } = await playRound(setup, { council: "no" });
  assert.equal(room.voting.result, "No");
  assert.equal(room.scoreGreen, 0);
  assert.equal(room.scoreRed, 0);
  assert.equal(room.currentRound, 1);
});

test("the Guptochor (round 2 General) can investigate once after round 2", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 7);
  await startGame(srv, setup);
  await playRound(setup);
  const { room } = await playRound(setup);
  assert.ok(room.guptochorId, "round 2 General becomes the Guptochor");
  const spy = setup.players.find((p) => p.id === room.guptochorId);
  const target = setup.players.find((p) => p.id !== spy.id);

  const result = next(spy.socket, "guptochorResult");
  const notice = next(target.socket, "notification", (n) => n.targetId === target.id);
  spy.socket.emit("investigatePlayer", { roomCode: setup.roomCode, targetPlayerId: target.id, requesterId: spy.id });
  const report = await result;
  assert.equal(report.targetName, target.name);
  assert.match(report.alliance, /Nawabs|East India Company/);
  await notice;
});

test("reset returns the room to the lobby and a new game can start", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  await startGame(srv, setup);
  const reset = next(setup.host.socket, "roomUpdated", (r) => !r.gameStarted);
  setup.host.socket.emit("resetGame", { roomCode: setup.roomCode, requesterId: setup.host.id });
  const room = await reset;
  assert.equal(room.gameStatus, "WAITING");
  assert.ok(room.players.every((p) => p.character === null));
  const again = await startGame(srv, setup);
  assert.equal(again.gameStatus, "ACTIVE");
});
