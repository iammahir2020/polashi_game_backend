// Copies the Firestore game logs into the Postgres tables. See
// postgres-migration.md, section 6. The export it reads came from
// scripts/export-firestore.js, removed with Firebase (in git history, PR #7).
//   node scripts/import-firestore.js <export.json>            dry run: checks and counts only
//   node scripts/import-firestore.js <export.json> --write    writes, using DATABASE_URL
// Safe to run twice: games already imported (same legacy_id) are skipped.
//
// What the old logs can't give: approval votes, rejected teams, seats (the
// seat order below is arbitrary), settings, assassination targets and player
// keys. Mission votes are imported as the old server counted them; before
// 2026-10-03 a Nawab's "no" counted as a sabotage.
const fs = require("fs");
const { CharacterList, NAWAB_TEAM, EIC_TEAM, WINNER_NAWABS, WINNER_EIC } = require("../game/constants");

const TEAM_CODES = { [NAWAB_TEAM]: "NAWABS", [EIC_TEAM]: "EIC" };
const WINNER_CODES = { [WINNER_NAWABS]: "NAWABS", [WINNER_EIC]: "EIC", "EIC (Red)": "EIC" };
const CHARACTER_IDS = new Map(CharacterList.map((c) => [c.name, c.id]));

const isLoadTest = (doc) => Object.values(doc.identities || {}).some((p) => /^LoadBot/.test(p.name || ""));

// Turns one Firestore document into the rows to insert. Throws on anything it
// can't map, so a surprise stops the import instead of being stored wrong.
function transform(doc) {
  const fail = (msg) => { throw new Error(`${doc.id}: ${msg}`); };
  const ids = Object.keys(doc.identities || {});
  if (!ids.length) fail("no players");
  const idByName = new Map(ids.map((id) => [doc.identities[id].name, id]));
  if (idByName.size !== ids.length) fail("two players share a name");

  const players = ids.map((id, seat) => {
    const p = doc.identities[id];
    const characterId = CHARACTER_IDS.get(p.role);
    const team = TEAM_CODES[p.team];
    if (!characterId) fail(`unknown role ${JSON.stringify(p.role)}`);
    if (!team) fail(`unknown team ${JSON.stringify(p.team)}`);
    return { id, name: p.name, seat, characterId, team, isObserver: p.isActive === false };
  });
  const teamOf = new Map(players.map((p) => [p.id, p.team]));
  const idOf = (name) => idByName.get(name) ?? fail(`unknown player name in a round`);

  const rounds = Object.entries(doc.rounds || {})
    .map(([key, r]) => {
      const round = Number(/^round_(\d+)$/.exec(key)?.[1]);
      if (!(round >= 1 && round <= 5)) fail(`odd round key ${key}`);
      if (r.result !== "Success" && r.result !== "Fail") fail(`odd result in ${key}`);
      const teamIds = (r.team || []).map(idOf);
      const votes = Object.entries(r.votes || {});
      for (const [id, vote] of votes) {
        if (!teamOf.has(id)) fail(`vote from an unknown player in ${key}`);
        if (vote !== "yes" && vote !== "no") fail(`odd vote ${JSON.stringify(vote)} in ${key}`);
      }
      return {
        round,
        generalId: r.general ? idOf(r.general) : null,
        teamIds,
        eicOnTeam: teamIds.filter((id) => teamOf.get(id) === "EIC").length,
        sabotages: r.sabotages,
        result: r.result === "Success" ? "S" : "F",
        resolvedAt: r.timestamp,
        votes: votes.map(([id, v]) => ({ id, sabotage: v === "no" })),
      };
    })
    .sort((a, b) => a.round - b.round);
  const missionResults = rounds.map((r) => r.result).join("");

  let game;
  if (doc.status === "COMPLETED") {
    const winner = WINNER_CODES[doc.winner] ?? fail(`unknown winner ${JSON.stringify(doc.winner)}`);
    const successes = rounds.filter((r) => r.result === "S").length;
    const fails = rounds.filter((r) => r.result === "F").length;
    let endReason;
    if (fails === 3 && winner === "EIC") endReason = "three_fails";
    else if (successes === 3) endReason = winner === "EIC" ? "assassin_hit" : "assassin_missed";
    else fail("completed without three results on one side");
    game = { status: "completed", endReason, winner, endedAt: doc.endTime ?? null };
  } else if (doc.status === "IN_PROGRESS") {
    game = { status: "abandoned", endReason: "legacy_unknown", winner: null, endedAt: null };
  } else {
    fail(`unknown status ${JSON.stringify(doc.status)}`);
  }

  return {
    legacyId: doc.id,
    roomCode: doc.roomCode,
    startedAt: doc.startTime,
    playerCount: players.filter((p) => !p.isObserver).length,
    observerCount: players.filter((p) => p.isObserver).length,
    missionResults,
    ...game,
    players: players.map((p) => ({ ...p, won: game.winner ? p.team === game.winner : null })),
    rounds,
  };
}

// Writes one game in one transaction. Returns false when it was already imported.
async function insertGame(client, g) {
  await client.query("begin");
  try {
    const { rows } = await client.query(
      `insert into polashi.games
         (room_code, started_at, ended_at, status, end_reason, winner, player_count, observer_count,
          settings, mission_results, source, legacy_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, '{}', $9, 'firestore_import', $10)
       on conflict (legacy_id) do nothing
       returning id`,
      [g.roomCode, g.startedAt, g.endedAt, g.status, g.endReason, g.winner, g.playerCount,
        g.observerCount, g.missionResults || null, g.legacyId],
    );
    if (!rows.length) {
      await client.query("rollback");
      return false;
    }
    const gameId = rows[0].id;
    await client.query(
      `insert into polashi.game_players
         (game_id, room_player_id, name, seat, character_id, team, is_observer, won)
       select $1, * from unnest($2::uuid[], $3::text[], $4::smallint[], $5::smallint[], $6::text[],
                                $7::boolean[], $8::boolean[])`,
      [gameId, ...["id", "name", "seat", "characterId", "team", "isObserver", "won"].map((k) => g.players.map((p) => p[k]))],
    );
    for (const r of g.rounds) {
      await client.query(
        `with p as (
           insert into polashi.proposals
             (game_id, round, general_id, team_ids, approved, eic_on_team, sabotages, mission_result, resolved_at)
           values ($1, $2, $3, $4::uuid[], true, $5, $6, $7, $8)
           returning id
         )
         insert into polashi.mission_votes (proposal_id, room_player_id, sabotage)
         select p.id, u.player_id, u.sabotage from p, unnest($9::uuid[], $10::boolean[]) as u(player_id, sabotage)`,
        [gameId, r.round, r.generalId, r.teamIds, r.eicOnTeam, r.sabotages, r.result, r.resolvedAt,
          r.votes.map((v) => v.id), r.votes.map((v) => v.sabotage)],
      );
    }
    await client.query("commit");
    return true;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw new Error(`${g.legacyId}: ${err.message}`);
  }
}

async function importGames(pool, games) {
  const client = await pool.connect();
  let added = 0;
  try {
    for (const g of games) if (await insertGame(client, g)) added++;
  } finally {
    client.release();
  }
  return { added, skipped: games.length - added };
}

function summarize(games) {
  const by = (f) => games.reduce((m, g) => ((m[f(g)] = (m[f(g)] || 0) + 1), m), {});
  return {
    games: games.length,
    status: by((g) => g.status),
    winner: by((g) => g.winner ?? "none"),
    endReason: by((g) => g.endReason),
    proposals: games.reduce((n, g) => n + g.rounds.length, 0),
    missionVotes: games.reduce((n, g) => n + g.rounds.reduce((m, r) => m + r.votes.length, 0), 0),
    nawabSabotages: games.reduce((n, g) => {
      const team = new Map(g.players.map((p) => [p.id, p.team]));
      return n + g.rounds.reduce((m, r) => m + r.votes.filter((v) => v.sabotage && team.get(v.id) === "NAWABS").length, 0);
    }, 0),
  };
}

if (require.main === module) {
  require("dotenv").config({ quiet: true });
  const [file, flag] = process.argv.slice(2);
  if (!file) {
    console.error("Usage: node scripts/import-firestore.js <export.json> [--write]");
    process.exit(1);
  }
  const { docs } = JSON.parse(fs.readFileSync(file, "utf8"));
  const real = docs.filter((d) => !isLoadTest(d));
  const games = real.map(transform);
  console.log(`${docs.length} documents, ${docs.length - real.length} load-test games skipped.`);
  console.log(JSON.stringify(summarize(games), null, 2));
  if (flag !== "--write") {
    console.log("Dry run: nothing written. Add --write to import.");
  } else {
    const { createPool } = require("../db/pool");
    const pool = createPool(process.env.DATABASE_URL);
    importGames(pool, games)
      .then(({ added, skipped }) => console.log(`Imported ${added} games; ${skipped} were already there.`))
      .catch((err) => {
        console.error("Import stopped:", err.message);
        process.exitCode = 1;
      })
      .finally(() => pool.end());
  }
}

module.exports = { transform, importGames, isLoadTest, summarize };
