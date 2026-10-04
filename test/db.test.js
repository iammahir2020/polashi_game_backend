// Runs only when TEST_DATABASE_URL points at a local, disposable Postgres
// (it drops and recreates the polashi schema), for example:
//   docker run -d --name polashi-test-pg -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:54329/postgres npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createPool } = require("../db/pool");
const { migrate } = require("../db/migrate");
const { createGameLogger } = require("../GameLogger");
const { transform, importGames } = require("../scripts/import-firestore");
const { startServer, next, setupRoom, startGame, playRound } = require("./helpers");

const URL_ = process.env.TEST_DATABASE_URL;
const local = URL_ && ["localhost", "127.0.0.1"].includes(new URL(URL_).hostname);
const skip = !URL_ ? "TEST_DATABASE_URL not set" : !local ? "TEST_DATABASE_URL must be a local database" : false;
const quiet = { info() {}, warn() {}, error() {} };

// A pool that logs in as `role` with a throwaway test password.
function poolAs(role, password) {
  const url = new URL(URL_);
  url.username = role;
  url.password = password;
  return createPool(url.toString(), { log: quiet });
}

test("game logs in Postgres", { skip }, async (t) => {
  const admin = createPool(URL_, { log: quiet });
  t.after(() => admin.end());
  await admin.query("drop schema if exists polashi cascade");

  const errors = [];
  const log = { info() {}, warn() {}, error: (...a) => errors.push(a.join(" ")) };

  await t.test("migrations apply once and record themselves", async () => {
    assert.deepEqual(await migrate(admin, { log: quiet }), ["001_init.sql"]);
    assert.deepEqual(await migrate(admin, { log: quiet }), []);
    await admin.query("alter role polashi_app password 'test-app'");
    await admin.query("alter role polashi_readonly password 'test-ro'");
  });

  const app = poolAs("polashi_app", "test-app");
  const ro = poolAs("polashi_readonly", "test-ro");
  t.after(() => Promise.all([app.end(), ro.end()]));
  const logger = createGameLogger({ pool: app, log, serverVersion: "test-commit" });

  await t.test("a full game through the server is written as it happens", async (tt) => {
    const srv = await startServer({ logger });
    tt.after(() => srv.stop());
    const hostKey = crypto.randomUUID();
    const setup = await setupRoom(srv, 7);
    // Give the host a device key after the fact, as if sent on createRoom.
    srv.rooms[setup.roomCode].players[0].playerKey = hostKey;
    await startGame(srv, setup);

    await playRound(setup, { council: "no" });
    for (let i = 0; i < 3; i++) await playRound(setup);
    const over = next(setup.host.socket, "roomUpdated", (r) => r.gameStatus === "OVER");
    const room = srv.rooms[setup.roomCode];
    const mirJafor = room.players.find((p) => p.character.id === 1);
    const madan = room.players.find((p) => p.character.id === 8);
    setup.players.find((p) => p.id === mirJafor.id).socket.emit("attemptAssassination", {
      roomCode: setup.roomCode,
      targetId: madan.id,
    });
    await over;
    await logger.flush();
    assert.deepEqual(errors, []);

    const { rows: [game] } = await ro.query("select * from polashi.games where room_code = $1", [setup.roomCode]);
    assert.equal(game.status, "completed");
    assert.equal(game.end_reason, "assassin_hit");
    assert.equal(game.winner, "EIC");
    assert.equal(game.mission_results, "SSS");
    assert.equal(game.assassin_target_id, madan.id);
    assert.equal(game.assassin_hit, true);
    assert.equal(game.player_count, 7);
    assert.equal(game.server_version, "test-commit");
    assert.equal(game.game_number_in_series, 1);
    assert.ok(game.ended_at);
    assert.deepEqual(game.settings.selectedCharIds.length, 10);

    const { rows: players } = await ro.query(
      "select * from polashi.game_players where game_id = $1 order by seat", [game.id]);
    assert.equal(players.length, 7);
    assert.ok(players.every((p) => p.won === (p.team === "EIC")));
    assert.equal(players[0].player_key, hostKey);
    assert.equal(players[0].is_host, true);
    const { rows: [known] } = await ro.query("select * from polashi.players where player_key = $1", [hostKey]);
    assert.equal(known.display_name, "Host");

    const { rows: proposals } = await ro.query(
      "select * from polashi.proposals where game_id = $1 order by id", [game.id]);
    assert.deepEqual(
      proposals.map((p) => [p.round, p.attempt, p.approved, p.mission_result, p.sabotages]),
      [[1, 1, false, null, null], [1, 2, true, "S", 0], [2, 1, true, "S", 0], [3, 1, true, "S", 0]],
    );
    assert.ok(proposals.every((p) => p.proposed_at && p.team_ids.length));

    const { rows: [counts] } = await ro.query(
      `select (select count(*) from polashi.approval_votes a join polashi.proposals p on p.id = a.proposal_id
               where p.game_id = $1)::int as approvals,
              (select count(*) from polashi.approval_votes a join polashi.proposals p on p.id = a.proposal_id
               where p.game_id = $1 and not a.approve)::int as rejections,
              (select count(*) from polashi.mission_votes m join polashi.proposals p on p.id = m.proposal_id
               where p.game_id = $1)::int as mission_votes`,
      [game.id],
    );
    // 4 council votes by 7 players, 7 of them against; missions of 2, 3 and 3.
    assert.deepEqual(counts, { approvals: 28, rejections: 7, mission_votes: 8 });
  });

  await t.test("an unfinished game is closed as server_restart on the next start", async () => {
    const game = {};
    logger.gameStarted(game, {
      roomCode: "RESTRT",
      settings: {},
      players: [{ id: crypto.randomUUID(), name: "A", seat: 0, characterId: 5, team: "Nawabs", isHost: true }],
    });
    await logger.flush();
    assert.ok((await logger.abandonUnfinished()) >= 1);
    const { rows: [row] } = await ro.query("select status, end_reason from polashi.games where id = $1", [game.id]);
    assert.deepEqual(row, { status: "abandoned", end_reason: "server_restart" });
  });

  await t.test("a failed write is logged and doesn't stop the game's later writes", async () => {
    errors.length = 0;
    const game = {};
    const a = crypto.randomUUID();
    logger.gameStarted(game, {
      roomCode: "FAILED",
      settings: {},
      players: [{ id: a, name: "A", seat: 0, characterId: 1, team: "East India Company (EIC)" }],
    });
    logger.missionResolved(game, { votes: { [a]: "no" }, sabotages: 1, result: "F" }); // no approved team
    logger.investigation(game, { round: 3, investigatorId: a, targetId: a, shownTeam: "Not a team" });
    logger.gameEnded(game, { status: "reset", reason: "reset_by_host" });
    await logger.flush();
    assert.equal(errors.length, 2);
    const { rows: [row] } = await ro.query("select status from polashi.games where id = $1", [game.id]);
    assert.equal(row.status, "reset");
  });

  await t.test("imported Firestore games are written once, however often the import runs", async () => {
    const A = crypto.randomUUID(), B = crypto.randomUUID();
    const game = transform({
      id: "IMPORT-1", roomCode: "IMPORT", startTime: "2026-03-01T10:00:00Z", endTime: "2026-03-01T10:20:00Z",
      status: "COMPLETED", winner: "EIC (Red)",
      identities: {
        [A]: { name: "A", role: "মীর জাফর", team: "East India Company (EIC)", isActive: true },
        [B]: { name: "B", role: "মীর মদন", team: "Nawabs", isActive: true },
      },
      rounds: Object.fromEntries([1, 2, 3].map((n) => [`round_${n}`,
        { general: "B", team: ["A", "B"], votes: { [A]: "no", [B]: "yes" }, sabotages: 1, result: "Fail", timestamp: `2026-03-01T10:0${n}:00Z` }])),
    });
    assert.deepEqual(await importGames(admin, [game]), { added: 1, skipped: 0 });
    assert.deepEqual(await importGames(admin, [game]), { added: 0, skipped: 1 });
    const { rows: [row] } = await ro.query(
      `select g.source, g.status, g.end_reason, g.winner, g.mission_results,
              (select count(*)::int from polashi.proposals p where p.game_id = g.id) as proposals,
              (select count(*)::int from polashi.mission_votes m join polashi.proposals p on p.id = m.proposal_id
                where p.game_id = g.id and m.sabotage) as sabotages,
              (select array_agg(won order by seat) from polashi.game_players gp where gp.game_id = g.id) as won
       from polashi.games g where legacy_id = 'IMPORT-1'`);
    assert.deepEqual(row, { source: "firestore_import", status: "completed", end_reason: "three_fails", winner: "EIC",
      mission_results: "FFF", proposals: 3, sabotages: 3, won: [true, false] });
  });

  await t.test("the app role can't delete, change the schema or read the migration table", async () => {
    await assert.rejects(app.query("delete from polashi.games"), /permission denied/);
    await assert.rejects(app.query("create table polashi.x (id int)"), /permission denied/);
    await assert.rejects(app.query("select * from polashi.schema_migrations"), /permission denied/);
    await assert.rejects(app.query("select * from pg_catalog.pg_authid"), /permission denied/);
  });

  await t.test("the read-only role can read everything and write nothing", async () => {
    const { rows } = await ro.query("select count(*)::int as n from polashi.schema_migrations");
    assert.equal(rows[0].n, 1);
    await ro.query("select last_value from polashi.games_id_seq"); // pg_dump needs this
    await assert.rejects(ro.query("update polashi.games set winner = 'EIC'"), /permission denied/);
    await assert.rejects(ro.query("insert into polashi.players (player_key, display_name) values (gen_random_uuid(), 'x')"), /permission denied/);
  });
});
