const { NAWAB_TEAM, EIC_TEAM, WINNER_NAWABS, WINNER_EIC } = require("./game/constants");

// The game's team and winner labels as stored in the database.
const TEAM_CODES = { [NAWAB_TEAM]: "NAWABS", [EIC_TEAM]: "EIC" };
const WINNER_CODES = { [WINNER_NAWABS]: "NAWABS", [WINNER_EIC]: "EIC" };
const teamCode = (team) => TEAM_CODES[team] ?? null;

/**
 * Writes game logs to Postgres (schema in db/migrations).
 *
 * The server passes the same `game` object (one per game, kept on the room) to
 * every event. The logger keeps its own state on it: the database id, each
 * player's team, and a queue, so one game's writes run in order and a proposal
 * is never written before its game. A failed write is logged and never thrown:
 * play must not depend on the database.
 */
function createGameLogger({ pool, log = console, serverVersion = null }) {
  const pending = new Set();

  function enqueue(game, label, write) {
    const run = (game.chain || Promise.resolve())
      .then(() => write())
      .catch((err) => log.error(`Game log (${label}) failed:`, err && err.message));
    game.chain = run;
    pending.add(run);
    run.then(() => pending.delete(run));
    return run;
  }

  async function transaction(fn) {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query("begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => { broken = true; });
      throw err;
    } finally {
      client.release(broken);
    }
  }

  return {
    // players: [{ id, playerKey, name, seat, characterId, team, isHost, isObserver }]
    gameStarted(game, { roomCode, seriesId, gameNumber, settings, players }) {
      game.teams = new Map(players.map((p) => [p.id, teamCode(p.team)]));
      return enqueue(game, "gameStarted", () => transaction(async (db) => {
        const playing = players.filter((p) => !p.isObserver).length;
        const { rows } = await db.query(
          `insert into polashi.games
             (room_code, player_count, observer_count, settings, series_id, game_number_in_series, server_version)
           values ($1, $2, $3, $4, $5, $6, $7)
           returning id`,
          [roomCode, playing, players.length - playing, settings, seriesId ?? null, gameNumber ?? null, serverVersion],
        );
        const gameId = rows[0].id;

        // One device can sit in two seats (two tabs); the last name wins.
        const keyed = new Map(players.filter((p) => p.playerKey).map((p) => [p.playerKey, p.name]));
        if (keyed.size) {
          await db.query(
            `insert into polashi.players (player_key, display_name)
             select * from unnest($1::uuid[], $2::text[])
             on conflict (player_key) do update
               set display_name = excluded.display_name, last_seen = now()`,
            [[...keyed.keys()], [...keyed.values()]],
          );
        }

        await db.query(
          `insert into polashi.game_players
             (game_id, room_player_id, player_key, name, seat, character_id, team, is_host, is_observer)
           select $1, * from unnest($2::uuid[], $3::uuid[], $4::text[], $5::smallint[], $6::smallint[],
                                    $7::text[], $8::boolean[], $9::boolean[])`,
          [
            gameId,
            players.map((p) => p.id),
            players.map((p) => p.playerKey ?? null),
            players.map((p) => p.name),
            players.map((p) => p.seat),
            players.map((p) => p.characterId ?? null),
            players.map((p) => teamCode(p.team)),
            players.map((p) => !!p.isHost),
            players.map((p) => !!p.isObserver),
          ],
        );
        game.id = gameId;
      }));
    },

    // votes: { playerId: "yes" | "no" }
    proposalResolved(game, { round, attempt, generalId, teamIds, approved, votes, proposedAt }) {
      const eicOnTeam = teamIds.filter((id) => game.teams?.get(id) === "EIC").length;
      return enqueue(game, "proposalResolved", async () => {
        if (!game.id) return;
        const { rows } = await pool.query(
          `with p as (
             insert into polashi.proposals
               (game_id, round, attempt, general_id, team_ids, approved, eic_on_team, proposed_at)
             values ($1, $2, $3, $4, $5::uuid[], $6, $7, $8)
             returning id
           ), v as (
             insert into polashi.approval_votes (proposal_id, room_player_id, approve)
             select p.id, u.player_id, u.approve
             from p, unnest($9::uuid[], $10::boolean[]) as u(player_id, approve)
           )
           select id from p`,
          [
            game.id, round, attempt, generalId ?? null, teamIds, approved, eicOnTeam, proposedAt ?? null,
            Object.keys(votes), Object.values(votes).map((v) => v === "yes"),
          ],
        );
        // The next mission vote belongs to the last approved team.
        game.openProposalId = approved ? rows[0].id : null;
      });
    },

    // votes: { playerId: "yes" | "no" }, as counted; result: "S" | "F"
    missionResolved(game, { votes, sabotages, result }) {
      return enqueue(game, "missionResolved", async () => {
        if (!game.id) return;
        const proposalId = game.openProposalId;
        if (!proposalId) throw new Error("mission vote without an approved proposal");
        game.openProposalId = null;
        await pool.query(
          `with p as (
             update polashi.proposals set sabotages = $3, mission_result = $4
             where id = $1 and game_id = $2
             returning id
           )
           insert into polashi.mission_votes (proposal_id, room_player_id, sabotage)
           select p.id, u.player_id, u.sabotage
           from p, unnest($5::uuid[], $6::boolean[]) as u(player_id, sabotage)`,
          [proposalId, game.id, sabotages, result, Object.keys(votes), Object.values(votes).map((v) => v === "no")],
        );
      });
    },

    investigation(game, { round, investigatorId, targetId, shownTeam }) {
      return enqueue(game, "investigation", async () => {
        if (!game.id) return;
        await pool.query(
          `insert into polashi.investigations (game_id, round, investigator_id, target_id, shown_team)
           values ($1, $2, $3, $4, $5)`,
          [game.id, round, investigatorId, targetId, teamCode(shownTeam)],
        );
      });
    },

    // status: completed | reset | abandoned. players: [{ id, disconnects, reconnects, leftEarly, kicked }]
    gameEnded(game, { status, reason, winner, missionResults, assassinTargetId, assassinHit, players = [] }) {
      const winnerCode = WINNER_CODES[winner] ?? null;
      return enqueue(game, "gameEnded", () => {
        if (!game.id) return;
        return transaction(async (db) => {
          await db.query(
            `update polashi.games
             set status = $2, end_reason = $3, winner = $4, mission_results = $5,
                 assassin_target_id = $6, assassin_hit = $7, ended_at = now()
             where id = $1`,
            [game.id, status, reason, winnerCode, missionResults || null, assassinTargetId ?? null, assassinHit ?? null],
          );
          await db.query(
            `update polashi.game_players
             set won = case when $2::text is null or team is null then null else team = $2::text end
             where game_id = $1`,
            [game.id, winnerCode],
          );
          if (players.length) {
            await db.query(
              `update polashi.game_players gp
               set disconnects = u.disconnects, reconnects = u.reconnects,
                   left_early = u.left_early, kicked = u.kicked
               from unnest($2::uuid[], $3::smallint[], $4::smallint[], $5::boolean[], $6::boolean[])
                 as u(player_id, disconnects, reconnects, left_early, kicked)
               where gp.game_id = $1 and gp.room_player_id = u.player_id`,
              [
                game.id,
                players.map((p) => p.id),
                players.map((p) => Math.min(p.disconnects || 0, 32767)),
                players.map((p) => Math.min(p.reconnects || 0, 32767)),
                players.map((p) => !!p.leftEarly),
                players.map((p) => !!p.kicked),
              ],
            );
          }
        });
      });
    },

    // Games left in progress by an earlier run of the server can't finish now.
    async abandonUnfinished() {
      const { rowCount } = await pool.query(
        `update polashi.games
         set status = 'abandoned', end_reason = 'server_restart', ended_at = now()
         where status = 'in_progress'`,
      );
      return rowCount;
    },

    // Resolves once every queued write has finished (used on shutdown and in tests).
    async flush() {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}

module.exports = { createGameLogger };
