const test = require("node:test");
const assert = require("node:assert/strict");
const { transform, isLoadTest } = require("../scripts/import-firestore");

const A = "a33d0e3a-75e6-4bef-b0a0-c708781eb417";
const B = "3e35ff1a-90a3-4913-8a3b-5e3f48c24a19";
const C = "30f115dc-8d84-4da5-a7b1-f63565e44a96";

// A Firestore game_logs document as the old logger wrote it.
function doc(overrides = {}) {
  return {
    id: "ROOM01-1774622188257",
    roomCode: "ROOM01",
    playerCount: 3,
    startTime: "2026-03-27T14:36:31.260Z",
    identities: {
      [A]: { name: "Asha", role: "নবাব সিরাজউদ্দৌলা", team: "Nawabs", isActive: true },
      [B]: { name: "Bilal", role: "মীর জাফর", team: "East India Company (EIC)", isActive: true },
      [C]: { name: "Chandra", role: "মীর মদন", team: "Nawabs", isActive: true },
    },
    roundHistory: ["Green", "Red"], // wrong in Firestore (arrayUnion); ignored
    rounds: {
      round_2: { general: "Asha", team: ["Asha", "Bilal"], votes: { [A]: "yes", [B]: "no" }, sabotages: 1, result: "Fail", timestamp: "2026-03-27T14:44:50.254Z" },
      round_1: { general: "Bilal", team: ["Asha", "Chandra"], votes: { [A]: "yes", [C]: "yes" }, sabotages: 0, result: "Success", timestamp: "2026-03-27T14:41:28.916Z" },
    },
    status: "IN_PROGRESS",
    ...overrides,
  };
}

test("an unfinished game becomes abandoned / legacy_unknown with its rounds in order", () => {
  const g = transform(doc());
  assert.deepEqual([g.status, g.endReason, g.winner, g.endedAt], ["abandoned", "legacy_unknown", null, null]);
  assert.equal(g.missionResults, "SF");
  assert.equal(g.legacyId, "ROOM01-1774622188257");
  assert.equal(g.playerCount, 3);
  assert.deepEqual(g.players.map((p) => [p.characterId, p.team, p.won]), [[5, "NAWABS", null], [1, "EIC", null], [8, "NAWABS", null]]);

  const [r1, r2] = g.rounds;
  assert.deepEqual([r1.round, r1.generalId, r1.teamIds, r1.eicOnTeam], [1, B, [A, C], 0]);
  assert.deepEqual([r2.round, r2.generalId, r2.teamIds, r2.eicOnTeam, r2.sabotages], [2, A, [A, B], 1, 1]);
  assert.deepEqual(r2.votes, [{ id: A, sabotage: false }, { id: B, sabotage: true }]);
});

test("both old winner spellings and the way the game ended are worked out", () => {
  const rounds = (results) => Object.fromEntries(results.map((r, i) => [`round_${i + 1}`,
    { general: "Asha", team: ["Asha"], votes: { [A]: "yes" }, sabotages: r === "Fail" ? 1 : 0, result: r }]));
  const done = (results, winner) => transform(doc({ status: "COMPLETED", winner, endTime: "2026-03-27T15:00:00Z", rounds: rounds(results) }));

  const threeFails = done(["Fail", "Fail", "Fail"], "EIC (Red)");
  assert.deepEqual([threeFails.status, threeFails.endReason, threeFails.winner, threeFails.missionResults], ["completed", "three_fails", "EIC", "FFF"]);
  assert.deepEqual(threeFails.players.map((p) => p.won), [false, true, false]);

  assert.equal(done(["Success", "Fail", "Success", "Success"], "East India Company (Red)").endReason, "assassin_hit");
  const nawabs = done(["Success", "Success", "Success"], "Nawabs (Green)");
  assert.deepEqual([nawabs.endReason, nawabs.winner], ["assassin_missed", "NAWABS"]);
});

test("anything it can't map stops the import instead of being stored wrong", () => {
  assert.throws(() => transform(doc({ status: "COMPLETED", winner: "Somebody" })), /unknown winner/);
  assert.throws(() => transform(doc({ status: "COMPLETED", winner: "Nawabs (Green)" })), /three results/);
  const badRole = doc();
  badRole.identities[A].role = "Robert Clive";
  assert.throws(() => transform(badRole), /unknown role/);
  const badName = doc();
  badName.rounds.round_1.team = ["Nobody"];
  assert.throws(() => transform(badName), /unknown player name/);
});

test("load-test games are recognised by their bot names", () => {
  assert.equal(isLoadTest(doc()), false);
  const bots = doc();
  bots.identities[A].name = "LoadBot 1-3";
  assert.equal(isLoadTest(bots), true);
});
