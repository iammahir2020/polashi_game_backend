const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeName, uniqueName, schemas } = require("../game/validation");
const { computeSecretIntel, personalizeRoom, visibleVoting, generateRoomCode, tokensMatch } = require("../game/room");
const { CharacterList, fakeHistoricalNames } = require("../game/constants");

const char = (id) => CharacterList.find((c) => c.id === id);

test("normalizeName strips invisible and direction characters and clips", () => {
  assert.equal(normalizeName("  Siraj  "), "Siraj");
  assert.equal(normalizeName("Si\u200Braj"), "Siraj");
  assert.equal(normalizeName("\u202Ejaris"), "jaris");
  assert.equal(normalizeName("a\n\tb"), "ab");
  assert.equal(normalizeName("a    b"), "a b");
  assert.equal(normalizeName("ｗｉｄｅ"), "wide");
  assert.equal(normalizeName("পলাশী"), "পলাশী");
  assert.equal(normalizeName("x".repeat(100)), "x".repeat(24));
  assert.equal(normalizeName("\u200B \u200D"), "");
  assert.equal(normalizeName(42), "");
  assert.equal(normalizeName({}), "");
});

test("uniqueName appends a number on a case-insensitive clash", () => {
  assert.equal(uniqueName("Siraj", ["Clive"]), "Siraj");
  assert.equal(uniqueName("siraj", ["Siraj"]), "siraj 2");
  assert.equal(uniqueName("Siraj", ["Siraj", "Siraj 2"]), "Siraj 3");
  assert.equal(uniqueName("y".repeat(24), ["y".repeat(24)]).length, 24);
});

test("schemas accept what the client sends and reject junk", () => {
  assert.ok(schemas.joinRoom.safeParse({ roomCode: "ab12cd", name: "x" }).success);
  assert.equal(schemas.leaveRoom.parse({ roomCode: " ab12cd " }).roomCode, "AB12CD");
  assert.ok(!schemas.reconnectPlayer.safeParse({ roomCode: "../../x", playerId: "p" }).success);
  assert.ok(!schemas.castVote.safeParse({ roomCode: "AB12CD", choice: "maybe" }).success);
  assert.ok(schemas.startGame.safeParse({ roomCode: "AB12CD", activeIds: ["a"], selectedCharIds: [1, 8], requesterId: "x", disableSecretIntelligence: false }).success);
  assert.ok(!schemas.startGame.safeParse({ roomCode: "AB12CD", activeIds: new Array(50).fill("a"), selectedCharIds: [] }).success);
});

function gameRoom(assignments) {
  const players = assignments.map(([name, id]) => ({ id: name, name, character: char(id), online: true, socketId: `s-${name}` }));
  return { players, activePlayerIds: players.map((p) => p.id), gameStarted: true, gameStatus: "ACTIVE", disableSecretIntelligence: false };
}

test("secret intel follows the original rules", () => {
  const room = gameRoom([
    ["MirJafor", 1], ["RaiDurlabh", 2], ["Omichand", 4], ["MirMadan", 8], ["Mohanlal", 9], ["Ghaseti", 3], ["Siraj", 5],
  ]);
  const intelOf = (name) => computeSecretIntel(room, room.players.find((p) => p.name === name)).sort();

  // Company players (except Omichand) see their side, and Omichand by role.
  assert.deepEqual(intelOf("MirJafor"), ["Ghaseti (EIC)", "Omichand (EIC - ওমিচাঁদ)", "RaiDurlabh (EIC)"].sort());
  // Mir Madan sees the Company, except Rai Durlabh.
  assert.deepEqual(intelOf("MirMadan"), ["Ghaseti (EIC)", "MirJafor (EIC)", "Omichand (EIC)"].sort());
  // Mohanlal sees Mir Madan and Ghaseti Begum, unlabelled.
  assert.deepEqual(intelOf("Mohanlal"), ["Ghaseti", "MirMadan"]);
  // Omichand isn't told his allies; like a loyal Nawab he gets two decoy names.
  assert.equal(intelOf("Omichand").length, 2);
  assert.ok(intelOf("Omichand").every((n) => fakeHistoricalNames.includes(n)));
  // A standard Nawab gets two decoy names.
  const decoys = intelOf("Siraj");
  assert.equal(decoys.length, 2);
  assert.ok(decoys.every((n) => fakeHistoricalNames.includes(n)));

  room.disableSecretIntelligence = true;
  assert.deepEqual(intelOf("MirJafor"), []);
});

test("personalizeRoom shows only what the viewer may see", () => {
  const room = gameRoom([["A", 1], ["B", 5], ["C", 8], ["D", 2], ["E", 6]]);
  room.players[0].reconnectToken = "secret";
  room.currentLogId = "log";
  room.generalHistory = ["A"];
  room.players.push({ id: "Obs", name: "Obs", character: null, isObserver: true, online: true });
  const viewA = personalizeRoom(room, room.players[0]);
  assert.equal(viewA.players[0].character.id, 1);
  assert.ok(viewA.players.slice(1).every((p) => p.character === null));
  assert.ok(viewA.players.every((p) => p.socketId === undefined && p.reconnectToken === undefined));
  assert.equal(viewA.currentLogId, undefined);
  assert.equal(viewA.generalHistory, undefined);
  assert.ok(Array.isArray(viewA.secretIntel));

  // Observers (not in the battalion) see every role, as before.
  const viewObs = personalizeRoom(room, room.players[5]);
  assert.ok(viewObs.players.slice(0, 5).every((p) => p.character));

  room.gameStatus = "OVER";
  assert.ok(personalizeRoom(room, room.players[1]).players.slice(0, 5).every((p) => p.character));
});

test("visibleVoting redacts open votes and anonymises closed mission votes", () => {
  assert.equal(visibleVoting(null), null);
  const open = visibleVoting({ active: true, votes: { a: "no", b: "yes" }, result: null, type: "teamApproval" });
  assert.deepEqual(open.votes, { a: true, b: true });
  const council = visibleVoting({ active: false, votes: { a: "no", b: "yes" }, result: "Yes", type: "teamApproval" });
  assert.deepEqual(council.votes, { a: "no", b: "yes" });
  const mission = visibleVoting({ active: false, votes: { a: "no", b: "yes" }, result: "No", type: "missionOutcome" });
  assert.deepEqual(Object.keys(mission.votes).sort(), ["v1", "v2"]);
  assert.deepEqual(Object.values(mission.votes).sort(), ["no", "yes"]);
});

test("room codes are 6 characters and avoid live codes", () => {
  const taken = new Set();
  for (let i = 0; i < 200; i++) {
    const code = generateRoomCode((c) => taken.has(c));
    assert.match(code, /^[A-Z0-9]{6}$/);
    assert.ok(!taken.has(code));
    taken.add(code);
  }
});

test("tokensMatch compares in constant time and rejects non-strings", () => {
  assert.equal(tokensMatch("abc", "abc"), true);
  assert.equal(tokensMatch("abc", "abd"), false);
  assert.equal(tokensMatch("abc", "ab"), false);
  assert.equal(tokensMatch("abc", undefined), false);
  assert.equal(tokensMatch(undefined, undefined), false);
});
