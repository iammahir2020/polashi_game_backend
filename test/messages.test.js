// Messages carry a code next to their English text, so the client can show them
// in the player's language (see game/messages.js). Older clients read only the
// English text, so that has to stay exactly as it was.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ERRORS, sendError, notification } = require("../game/messages");
const { startServer, next, setupRoom, startGame, playRound } = require("./helpers");

// Resolves with every argument of the next `event` (helpers.next keeps only the first).
function nextArgs(socket, event, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    socket.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

test("sendError sends the English text first and the code second", () => {
  const sent = [];
  sendError({ emit: (...args) => sent.push(args) }, "ROOM_FULL");
  assert.deepEqual(sent, [["errorMessage", "Room full", { code: "ROOM_FULL" }]]);
});

test("an unknown error or notification code is a bug, not a silent blank message", () => {
  assert.throws(() => sendError({ emit() {} }, "NO_SUCH_CODE"), /Unknown error code/);
  assert.throws(() => notification("NO_SUCH_CODE", {}), /Unknown notification code/);
});

test("every code the server sends is defined", () => {
  const source = fs.readFileSync(path.join(__dirname, "../game/createGameServer.js"), "utf-8");
  const used = [...source.matchAll(/sendError\(socket, "([A-Z_]+)"\)/g)].map((m) => m[1]);
  assert.ok(used.length >= 20, "found the sendError calls");
  for (const code of used) assert.ok(ERRORS[code], `${code} is not in ERRORS`);
  // No error is sent the old way, without a code.
  assert.doesNotMatch(source, /emit\("errorMessage"/);
});

test("notification text is unchanged for older clients", () => {
  assert.deepEqual(notification("GUPTOCHOR_DEPLOYED", { requester: "Asha", target: "Bilal" }, { type: "info" }), {
    message: "🕵️‍♂️ Intelligence Alert: Asha has deployed a Guptochor to investigate Bilal!",
    code: "GUPTOCHOR_DEPLOYED",
    params: { requester: "Asha", target: "Bilal" },
    type: "info",
  });
  assert.equal(
    notification("MIR_JAFOR_TURN", { name: "Clive" }).message,
    "🚨 Critical Alert: The Nawabs have the lead, but Clive is attempting a final betrayal!",
  );
});

test("a real error reaches the client with its code", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const s = await srv.client();
  const reply = nextArgs(s, "errorMessage");
  s.emit("joinRoom", { roomCode: "ZZZZZZ", name: "Asha" });
  assert.deepEqual(await reply, ["Room not found", { code: "ROOM_NOT_FOUND" }]);
});

test("the Guptochor notification carries its code and the two names", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 7);
  await startGame(srv, setup);
  await playRound(setup);
  const { room } = await playRound(setup);
  const spy = setup.players.find((p) => p.id === room.guptochorId);
  const target = setup.players.find((p) => p.id !== spy.id);

  const notice = next(target.socket, "notification", (n) => n.code === "GUPTOCHOR_DEPLOYED");
  spy.socket.emit("investigatePlayer", { roomCode: setup.roomCode, targetPlayerId: target.id, requesterId: spy.id });
  const n = await notice;
  assert.deepEqual(n.params, { requester: spy.name, target: target.name });
  assert.equal(n.message, `🕵️‍♂️ Intelligence Alert: ${spy.name} has deployed a Guptochor to investigate ${target.name}!`);
  assert.equal(n.requesterId, spy.id);
  assert.equal(n.targetId, target.id);
  assert.equal(n.type, "info");
});

test("the Mir Jafor notification names the player holding Mir Jafor", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const setup = await setupRoom(srv, 5);
  await startGame(srv, setup);
  const notice = next(setup.host.socket, "notification", (n) => n.code === "MIR_JAFOR_TURN");
  for (let i = 0; i < 3; i++) await playRound(setup);
  const n = await notice;
  const mirJafor = srv.rooms[setup.roomCode].players.find((p) => p.character?.id === 1);
  assert.deepEqual(n.params, { name: mirJafor.name });
  assert.equal(n.type, "warning");
});
