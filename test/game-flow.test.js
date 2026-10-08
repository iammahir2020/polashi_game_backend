const test = require("node:test");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { startServer, next, setupRoom, startGame, playRound } = require("./helpers");

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

  assert.deepEqual(srv.calls.map((c) => c[0]), [
    "gameStarted",
    "proposalResolved", "missionResolved",
    "proposalResolved", "missionResolved",
    "proposalResolved", "missionResolved",
    "gameEnded",
  ]);
  const [, started] = srv.calls[0];
  assert.equal(started.roomCode, setup.roomCode);
  assert.equal(started.gameNumber, 1);
  assert.equal(started.players.length, 7);
  assert.ok(started.players.every((p) => p.characterId && p.team && !p.isObserver));
  assert.deepEqual(started.players.map((p) => p.seat), [0, 1, 2, 3, 4, 5, 6]);

  const proposals = srv.calls.filter((c) => c[0] === "proposalResolved").map((c) => c[1]);
  assert.deepEqual(proposals.map((p) => [p.round, p.attempt, p.approved]), [[1, 1, true], [2, 1, true], [3, 1, true]]);
  assert.equal(Object.keys(proposals[0].votes).length, 7);
  assert.ok(proposals[0].proposedAt instanceof Date);

  const missions = srv.calls.filter((c) => c[0] === "missionResolved").map((c) => c[1]);
  assert.deepEqual(missions.map((m) => [m.sabotages, m.result]), [[0, "S"], [0, "S"], [0, "S"]]);

  const [, ended] = srv.calls.at(-1);
  assert.equal(ended.status, "completed");
  assert.match(ended.reason, /^assassin_(hit|missed)$/);
  assert.equal(ended.assassinHit, ended.reason === "assassin_hit");
  assert.ok(ended.assassinTargetId);
  assert.equal(ended.winner, room.winner);
  assert.equal(ended.missionResults, "SSS");
});

test("three failed missions end the game for the Company", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  let room = await startGame(srv, setup);
  // Only the Company can sabotage (a Nawab's "no" counts as a success), so
  // put the Company's players on every team first.
  const isEic = (id) => srv.rooms[setup.roomCode].players.find((p) => p.id === id).character.team !== "Nawabs";
  const teamOrder = [...room.activePlayerIds].sort((a, b) => isEic(b) - isEic(a));
  for (let i = 0; i < 3; i++) ({ room } = await playRound(setup, { mission: "no", teamOrder }));
  assert.equal(room.gameStatus, "OVER");
  assert.equal(room.winner, "East India Company (Red)");
  assert.deepEqual(room.roundHistory, ["Red", "Red", "Red"]);

  const missions = srv.calls.filter((c) => c[0] === "missionResolved").map((c) => c[1]);
  assert.ok(missions.every((m) => m.result === "F" && m.sabotages >= 1));
  // Votes are logged as counted: a Nawab's "no" is recorded as "yes".
  for (const m of missions) {
    for (const [id, vote] of Object.entries(m.votes)) if (!isEic(id)) assert.equal(vote, "yes");
  }
  const [event, ended] = srv.calls.at(-1);
  assert.equal(event, "gameEnded");
  assert.deepEqual(
    [ended.status, ended.reason, ended.winner, ended.missionResults],
    ["completed", "three_fails", "East India Company (Red)", "FFF"],
  );
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

  // The rejected team is logged, and the next try in the round is attempt 2.
  await playRound(setup);
  const proposals = srv.calls.filter((c) => c[0] === "proposalResolved").map((c) => c[1]);
  assert.deepEqual(proposals.map((p) => [p.round, p.attempt, p.approved]), [[1, 1, false], [1, 2, true]]);
  assert.ok(Object.values(proposals[0].votes).every((v) => v === "no"));
  assert.equal(srv.calls.filter((c) => c[0] === "missionResolved").length, 1);
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

  const [, logged] = srv.calls.find((c) => c[0] === "investigation");
  assert.deepEqual(logged, { game: 1, round: 3, investigatorId: spy.id, targetId: target.id, shownTeam: report.alliance });
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

  const starts = srv.calls.filter((c) => c[0] === "gameStarted").map((c) => c[1]);
  const ends = srv.calls.filter((c) => c[0] === "gameEnded").map((c) => c[1]);
  assert.deepEqual(ends.map((e) => [e.game, e.status, e.reason, e.winner]), [[1, "reset", "reset_by_host", null]]);
  // Both games belong to one series in the room.
  assert.deepEqual(starts.map((s) => s.gameNumber), [1, 2]);
  assert.ok(starts[0].seriesId && starts[0].seriesId === starts[1].seriesId);
});

test("a reset after the game is over logs nothing more", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  const room = await startGame(srv, setup);
  const isEic = (id) => srv.rooms[setup.roomCode].players.find((p) => p.id === id).character.team !== "Nawabs";
  const teamOrder = [...room.activePlayerIds].sort((a, b) => isEic(b) - isEic(a));
  for (let i = 0; i < 3; i++) await playRound(setup, { mission: "no", teamOrder });
  const reset = next(setup.host.socket, "roomUpdated", (r) => !r.gameStarted);
  setup.host.socket.emit("resetGame", { roomCode: setup.roomCode });
  await reset;
  assert.deepEqual(srv.calls.filter((c) => c[0] === "gameEnded").map((c) => c[1].reason), ["three_fails"]);
});

test("closing the room mid-game logs the game as abandoned", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  await startGame(srv, setup);
  const dissolved = next(setup.players[1].socket, "roomDissolved");
  setup.host.socket.emit("closeRoom", { roomCode: setup.roomCode });
  // The other players are told who closed it, so their screen can say so.
  assert.deepEqual(await dissolved, { reason: "closed_by_host" });
  const [event, ended] = srv.calls.at(-1);
  assert.equal(event, "gameEnded");
  assert.deepEqual([ended.status, ended.reason, ended.winner, ended.missionResults], ["abandoned", "room_closed", null, ""]);
});

test("rooms swept while idle log their game as abandoned", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  await startGame(srv, setup);
  srv.sweepRooms(Date.now() + 13 * 60 * 60 * 1000);
  assert.equal(srv.rooms[setup.roomCode], undefined);
  assert.deepEqual(srv.calls.at(-1)[1].reason, "swept_idle");
});

test("disconnects, reconnects, leaving and kicks are counted per player", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 7);
  await startGame(srv, setup);
  const { roomCode, players, host } = setup;
  const [, dropper, leaver, kicked] = players;

  // One player drops and comes back on a new connection.
  let update = next(host.socket, "roomUpdated", (r) => r.players.some((p) => p.id === dropper.id && !p.online));
  dropper.socket.close();
  await update;
  const fresh = await srv.client();
  const back = next(fresh, "roomJoined");
  fresh.emit("reconnectPlayer", { roomCode, playerId: dropper.id, reconnectToken: dropper.token });
  await back;

  update = next(host.socket, "roomUpdated", (r) => !r.players.some((p) => p.id === leaver.id));
  leaver.socket.emit("leaveRoom", { roomCode });
  await update;
  update = next(host.socket, "roomUpdated", (r) => !r.players.some((p) => p.id === kicked.id));
  host.socket.emit("kickPlayer", { roomCode, targetPlayerId: kicked.id });
  await update;

  update = next(host.socket, "roomUpdated", (r) => !r.gameStarted);
  host.socket.emit("resetGame", { roomCode });
  await update;

  const [, ended] = srv.calls.find((c) => c[0] === "gameEnded");
  const stats = Object.fromEntries(ended.players.map(({ id, ...s }) => [id, s]));
  assert.equal(ended.players.length, 7, "players who left are still counted");
  assert.deepEqual(stats[dropper.id], { disconnects: 1, reconnects: 1, leftEarly: false, kicked: false });
  assert.deepEqual(stats[leaver.id], { disconnects: 0, reconnects: 0, leftEarly: true, kicked: false });
  assert.deepEqual(stats[kicked.id], { disconnects: 0, reconnects: 0, leftEarly: false, kicked: true });
  assert.deepEqual(stats[host.id], { disconnects: 0, reconnects: 0, leftEarly: false, kicked: false });
});

test("a player key from the client is logged, and a malformed one is ignored", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const hostKey = crypto.randomUUID();
  const host = await srv.client();
  let joined = next(host, "roomJoined");
  host.emit("createRoom", { name: "Host", playerKey: hostKey });
  const { roomCode, playerId: hostId } = await joined;
  const players = [{ socket: host, id: hostId }];
  for (let i = 1; i < 5; i++) {
    const s = await srv.client();
    joined = next(s, "roomJoined");
    s.emit("joinRoom", { roomCode, name: `P${i}`, playerKey: i === 1 ? "not-a-uuid" : undefined });
    players.push({ socket: s, id: (await joined).playerId });
  }
  await startGame(srv, { roomCode, players, host: players[0] });
  const [, started] = srv.calls[0];
  assert.deepEqual(started.players.map((p) => p.playerKey), [hostKey, null, null, null, null]);
});
