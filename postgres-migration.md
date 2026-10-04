# Moving game logs from Firestore to Postgres (Supabase)

Game logs move from Firestore to a Postgres database on Supabase's free plan, with a new data
model that records what the old logs missed. The game itself doesn't change: the server keeps game
state in memory and only writes logs.

Only two files touch Firestore today: `firebase-admin.js` (the connection) and `GameLogger.js`
(three methods called from `game/createGameServer.js`).

## Why the data model changes too

The Firestore logs have four problems that the move fixes:

1. `roundHistory` is wrong. It is written with `arrayUnion`, which drops repeated values, so
   Green, Red, Green, Green is stored as `["Green", "Red"]`.
2. Each round's `votes` are the mission votes, saved under the misleading name `councilVotes`.
   Team approval votes and rejected teams aren't logged at all.
3. The winner is stored as display text in two spellings (`EIC (Red)` and
   `East India Company (Red)`).
4. Games that end without a winner stay `IN_PROGRESS` forever: 45 of 113 real games.

---

## 1. Setup (done by hand)

1. Create a Supabase project in **East US (North Virginia)**, next to the Render service
   (Virginia), so each write takes about 1-2 ms. On the creation form:
   - Leave GitHub unconnected; migrations live in this repo (`db/migrations`).
   - **Untick "Enable Data API"** and **"Automatically expose new tables"**: the server talks to
     Postgres directly, so nothing needs the REST API.
   - Keep "Enable automatic RLS".
   - Keep the database password in a password manager. Symbols in it (`@ # / %` and so on) must be
     URL-encoded in the connection string; a letters-and-digits password avoids that.
2. Copy the **Session pooler** connection string (Connect, Direct tab), not the direct connection: free projects
   reach the direct connection only over IPv6.
3. Download the project's CA certificate (Database settings, SSL configuration) and save it as
   `db/prod-ca-2021.crt` (Supabase Root 2021 CA, valid until April 2031). The pooler's certificate is signed by Supabase's own authority, so the
   standard certificate store rejects it (checked: `SELF_SIGNED_CERT_IN_CHAIN`). It is a public
   certificate and is committed, so the server can verify the connection instead of skipping the
   check.
4. Run the migration once (`npm run migrate`, section 5) with that string.
5. Set passwords for the two roles the migration creates, in the SQL Editor (section 3), and add
   the `polashi_app` connection string to Render as `DATABASE_URL`.

In Database settings, also switch on **Enforce SSL on incoming connections**: with it off, the
pooler accepts unencrypted logins (checked). Network restrictions stay open, since the server,
local development and the GitHub workflow all connect from changing addresses; the strong
password and SSL protect the database instead. The shared pooler's defaults (pool size 15, 200
client connections) are far above the server's 5.

Checked on 2026-10-04: the connection works through the session pooler (port 5432, the mode
Supabase now offers on that port), the database is Postgres 17, and `postgres` can create roles.

## 2. Capacity on the free plan

The free plan gives 500 MB of database, a shared CPU, 500 MB of RAM and 5 GB of egress.

| | Estimate | Free plan |
|---|---|---|
| Storage per game (7 players, ~6 team proposals, with indexes) | 10-20 KB | about 450 MB usable, so 22,000-45,000 games |
| Writes per game | about 15, spread over 10-12 minutes | |
| Writes per second at the load-test pace (25 games/min) | about 6 | hundreds to thousands |
| Writes per second at the game server's ceiling (~1,000 live games) | about 20 | |
| Egress | only query results; logging is inbound | 5 GB |
| Connections | at most 5 from the server's pool | well under the pooler's limit |

At the real pace so far (113 games in 8 months), storage lasts over a century; at 100 games a day,
7-12 months. The database won't be the bottleneck; the game server's memory is. The storage figure
is an estimate: once live, measure it with `pg_total_relation_size` and update this table.

"Unlimited API requests" and "50,000 monthly active users" cover Supabase's own API and Auth,
which this plan doesn't use. Supabase Auth could later replace the Firebase Auth idea for player
profiles (`plan.md`, item 4.1).

**The limit that matters:** free projects pause after 7 days without activity. Real play has gaps
longer than that (2 games from June to August). While paused, games still work but logging fails
until the project is restored from the dashboard, and a paused free project can only be restored
for 90 days; after that its data is gone. The game server can't keep it awake, because
Render's free plan puts the server to sleep after 15 idle minutes. Section 7 adds a scheduled job
that does.

## 3. Schema

Everything lives in its own schema, `polashi`. Supabase serves the `public` schema through its
REST API, which would expose player names and votes; `polashi` isn't exposed. Row Level Security
is still switched on for every table, and the server connects as a role that can only read and
write these tables.

Who sabotaged each mission **is** stored (`mission_votes`), for analysis and the admin panel
only. Players never see it: the server keeps sending mission votes to clients shuffled and
anonymous (`visibleVoting` in `game/room.js`), and no player-facing feature may read this table
without a separate decision.

Choices that follow Supabase's Postgres guidance (`supabase-postgres-best-practices`):

- Primary keys are `bigint generated always as identity`, not random UUIDs, which scatter index
  writes. The in-game player ids stay UUIDs, as they come from the server.
- Every foreign key column is indexed (covered by a primary key or its own index).
- `text` with check constraints instead of enums or `varchar(n)`; `timestamptz` throughout.
- The server connects as `polashi_app`, which can select, insert and update these tables and
  nothing else: no delete, no other schemas, no DDL. Migrations run as `postgres`.
- Backups and reading tools connect as `polashi_readonly`: `select` on the schema's tables and
  sequences, nothing else.

The tables, in short (`db/migrations/001_init.sql` is the exact version, with the check
constraints on `end_reason` and `mission_results`, and named indexes):

```sql
create schema polashi;

create table polashi.players (
  player_key   uuid primary key,          -- sent by the frontend, one per device
  display_name text not null,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);

create table polashi.games (
  id                    bigint generated always as identity primary key,
  room_code             text not null,
  started_at            timestamptz not null default now(),
  ended_at              timestamptz,
  status                text not null default 'in_progress'
                        check (status in ('in_progress', 'completed', 'abandoned', 'reset')),
  end_reason            text,             -- three_fails, assassin_hit, assassin_missed, reset_by_host,
                                          -- room_closed, room_emptied, swept_idle, server_restart, legacy_unknown
  winner                text check (winner in ('NAWABS', 'EIC')),
  player_count          smallint not null,
  observer_count        smallint not null default 0,
  settings              jsonb not null,   -- { selectedCharIds, disableSecretIntelligence, ... }
  mission_results       text,             -- e.g. 'SFSS'
  assassin_target_id    uuid,
  assassin_hit          boolean,
  series_id             uuid,             -- links rematches in one room
  game_number_in_series smallint,
  server_version        text,             -- git commit (RENDER_GIT_COMMIT)
  source                text not null default 'live' check (source in ('live', 'firestore_import')),
  legacy_id             text unique       -- Firestore document id, for imported games
);

create table polashi.game_players (
  game_id        bigint not null references polashi.games on delete cascade,
  room_player_id uuid not null,            -- the in-game player id
  player_key     uuid references polashi.players,
  name           text not null,
  seat           smallint not null,
  character_id   smallint,                 -- 1-10, null for observers
  team           text check (team in ('NAWABS', 'EIC')),
  is_host        boolean not null default false,
  is_observer    boolean not null default false,
  won            boolean,
  disconnects    smallint not null default 0,
  reconnects     smallint not null default 0,
  left_early     boolean not null default false,
  kicked         boolean not null default false,
  primary key (game_id, room_player_id)
);

create table polashi.proposals (
  id             bigint generated always as identity primary key,
  game_id        bigint not null references polashi.games on delete cascade,
  round          smallint not null,
  attempt        smallint,                 -- 1st, 2nd... proposal in the round; null for imported games
  general_id     uuid,
  team_ids       uuid[] not null,
  approved       boolean not null,
  eic_on_team    smallint not null,
  sabotages      smallint,                 -- set when the mission vote ends; kept alongside
                                           -- mission_votes so totals need no join
  mission_result text check (mission_result in ('S', 'F')),
  proposed_at    timestamptz,
  resolved_at    timestamptz not null default now()
);

create table polashi.approval_votes (
  proposal_id    bigint not null references polashi.proposals on delete cascade,
  room_player_id uuid not null,
  approve        boolean not null,
  primary key (proposal_id, room_player_id)
);

create table polashi.mission_votes (
  proposal_id    bigint not null references polashi.proposals on delete cascade,
  room_player_id uuid not null,
  sabotage       boolean not null,         -- the vote as counted: a Nawab's is always false
  primary key (proposal_id, room_player_id)
);

create table polashi.investigations (
  game_id         bigint not null references polashi.games on delete cascade,
  round           smallint not null,
  investigator_id uuid not null,
  target_id       uuid not null,
  shown_team      text not null check (shown_team in ('NAWABS', 'EIC')),
  at              timestamptz not null default now()
);

create index on polashi.games (started_at);
create index on polashi.games (status);
create index on polashi.game_players (player_key);
create index on polashi.proposals (game_id, round, attempt);
create index on polashi.game_players (lower(name));   -- name search in the admin panel
create index on polashi.investigations (game_id);

alter table polashi.players        enable row level security;
alter table polashi.games          enable row level security;
alter table polashi.game_players   enable row level security;
alter table polashi.proposals      enable row level security;
alter table polashi.approval_votes enable row level security;
alter table polashi.mission_votes  enable row level security;
alter table polashi.investigations enable row level security;
```

The same migration (`db/migrations/001_init.sql`) sets up the two roles, without passwords:

- `polashi_app`: `select, insert, update` on each table, and a `for all` policy per table.
- `polashi_readonly`: `select` on each table (including `schema_migrations`) and on the id
  sequences, which `pg_dump` reads, and a `for select` policy per table.
- `anon`, `authenticated` and `service_role` lose any access to the schema, in case a Supabase
  default grant reached it.

Grants name each table rather than using default privileges, so a later migration grants its
new tables explicitly. Passwords are set once by hand in the SQL Editor and never committed:

```sql
alter role polashi_app password '...';
alter role polashi_readonly password '...';
```

Three connection strings, then: the local `.env` keeps the `postgres` one for migrations and the
import, Render gets the `polashi_app` one, and the backup workflow the `polashi_readonly` one.
Through the pooler the user names are `polashi_app.<project-ref>` and
`polashi_readonly.<project-ref>`, the same pattern as `postgres.<project-ref>`.

### Reading the data: the admin panel

The tables are split by what they describe (games, players in a game, proposals, votes), which is
the usual shape for this kind of data: each fact is stored once, new features add tables or
columns without reshaping old ones, and any question is a join away.

Speed isn't a concern at this size. Every lookup an admin panel makes (one game with its players,
proposals and votes; one player's games; the most recent games) goes through an index, and takes a
millisecond or two even at 100,000 games. Whole-table summaries (win rate by player count,
character win rates) scan the `games` or `game_players` table, which at thousands of games is
also milliseconds. If summaries over hundreds of thousands of games ever get slow, they can move to
a materialized view refreshed on a schedule, without changing the tables.

How the panel reads it:

- **Start with Supabase's dashboard.** The Table Editor and SQL Editor already show everything,
  for free, behind your Supabase login.
- **A custom panel** reads through the backend, never straight from the browser: admin-only routes
  on this server (behind a long `ADMIN_TOKEN`) that connect as `polashi_readonly`. The database
  password never reaches a browser, and a bug in the panel can't change data.
- **Saved views** for the common screens (`polashi.game_summary`, `polashi.player_stats`), created
  `with (security_invoker = true)` so they follow the reading role's permissions, as Supabase
  recommends. The panel's queries stay short, and the screens' logic lives in one place.

## 4. When each row is written

Each event is written as it happens (Postgres has no per-write cost), so a server restart mid-game
loses nothing already played.

| Moment (`game/createGameServer.js`) | Write |
|---|---|
| `startGame` | `games` row and one `game_players` row per player; the game id is kept on the room |
| Team vote ends (`castVote`, `teamApproval`) | `proposals` row and its `approval_votes` |
| Mission vote ends (`castVote`, `missionOutcome`) | `mission_votes` for the team, and `sabotages` and `mission_result` on that proposal |
| `investigatePlayer` | `investigations` row |
| Third failed mission, or `attemptAssassination` | `games`: `completed`, `end_reason`, `winner`, assassination target and hit; `won` for each player |
| `resetGame` before the game is over | `games`: `reset` |
| `closeRoom`, the last player leaving, or `sweepRooms` mid-game | `games`: `abandoned`, with the reason |
| Server start (`server.js`) | every game still `in_progress` becomes `abandoned` / `server_restart` |

Disconnects, reconnects, leaving and kicks are counted on the room and written when the game ends.
On SIGTERM (every Render deploy) the server waits up to 8 seconds for queued writes before exiting;
games still in progress are closed by the next instance's start-up step.

## 5. Code changes

- **`db/pool.js`**: a `pg` pool from `DATABASE_URL`, at most 5 connections, verifying the server
  with `db/prod-ca-2021.crt` (local databases connect without TLS). `pg` sends unnamed statements,
  which the pooler handles in either mode. Without `DATABASE_URL` the server runs and logs nothing.
- **`db/migrations/001_init.sql`** (section 3) and **`db/migrate.js`** (`npm run migrate`): applies
  numbered SQL files in order and records them in a `polashi.schema_migrations` table. Later schema
  changes are new files (`002_...sql`).
- **`GameLogger.js`**, rewritten for Postgres with event methods: `gameStarted`,
  `proposalResolved`, `missionResolved`, `investigation`, `gameEnded`. Writes for one game run one
  after another, so a proposal is never written before its game. Rows that arrive together (the
  players of a game, the votes on a proposal) go in one multi-row insert. A failed write is logged
  and never interrupts play, as now (`safeLog`).
- **`game/createGameServer.js`**: the calls from section 4, a `seriesId` and game counter on the
  room for rematches, the per-player connection counters, and the `server_restart` clean-up at
  start.
- **`game/validation.js`**: an optional `playerKey` (uuid) on `createRoom` and `joinRoom`. A
  malformed key is dropped, never refused, so it can't stop anyone from playing.
- **Frontend** (`polashi_game_frontend`, branch `feat/player-key`): `getPlayerKey()` in
  `src/services/sessionStore.ts` makes a random UUID once per device, keeps it in `localStorage`
  (it survives leaving a room), and `socket.ts` sends it on `createRoom` and `joinRoom`. The key is
  not a secret and proves nothing: anyone can send any key, so stats built on it are a convenience,
  not an identity. The two can deploy in either order: the old server ignores the extra field.
- **Tests**:
  - The recording logger in `test/helpers.js` gets the new methods, so the game-flow tests can
    check the exact events for a full game, a rejected team, a reset and an abandoned room.
  - Database tests (`test/db.test.js`) run only when `TEST_DATABASE_URL` points at a local
    Postgres, which they wipe, so `npm test` still needs nothing external. They apply the
    migration, play a full game through the server as `polashi_app`, and check what each role can
    and can't do.

## 6. Importing the Firestore games

Two scripts, run from a machine with the `FIREBASE_*` and `postgres` credentials in `.env`. The
export script was removed with Firebase in step 3; it is in the git history (PR #7) if it is ever
needed again.

1. `node scripts/export-firestore.js` reads the whole `game_logs` collection (read-only) into
   `exports/game_logs-<date>.json`. The folder is gitignored, since the file holds player names.
2. `node scripts/import-firestore.js <file>` checks every document and prints the counts (a dry
   run); with `--write` it imports, one transaction per game.

How the old documents map:

- Skips the 334 load-test games (players named `LoadBot ...`).
- Bangla role names become character ids; both winner spellings become `NAWABS` / `EIC`.
- `COMPLETED` games get their end reason from the rounds: three fails is `three_fails`, three
  successes is `assassin_hit` (Company won) or `assassin_missed` (Nawabs won).
- `IN_PROGRESS` games become `abandoned` / `legacy_unknown`.
- Each logged round becomes an approved proposal with its sabotage count, and its per-player
  votes (the Firestore field `votes`, which holds the mission votes) become `mission_votes`, as
  the server counted them then. Before 2026-10-03 a Nawab's "no" counted as a sabotage; the data
  has none.
- Names map to player ids through the game's `identities` (names are unique inside a room).
- `legacy_id` holds the Firestore document id, so running the import twice adds nothing.
- Anything the script can't map (an unknown role, winner or name) stops it, rather than being
  stored wrong.

Can't be recovered for old games: approval votes, rejected teams, seats (the imported seat order
is arbitrary), settings, assassination targets and `player_key`.

**Done on 2026-10-04:** exported 447 documents and imported 113 games: 68 completed (29 won by the
Nawabs, 39 by the Company) and 45 abandoned, with 812 players, 304 proposals and 1,013 mission
votes, from 2026-02-08 to 2026-10-02. These match the counts taken before the move.

## 7. Keeping the project awake, and backups

A GitHub Actions workflow (`.github/workflows/db-keepalive.yml`), run on a schedule every 3 days
and by hand:

1. Runs a small query (`select count(*) from polashi.games`) so the project never reaches 7 idle
   days.
2. Every Sunday (or when run by hand), takes a `pg_dump` of the `polashi` schema, encrypts it with
   a passphrase, and keeps it as a workflow artifact for 90 days. The free plan has no backups you
   can download yourself. Both steps connect as `polashi_readonly`, through the official
   `postgres:17` image, with the certificate verified.

**The repository is public**, so anyone can download its workflow artifacts. The dump holds player
names, so it is encrypted (`gpg --symmetric`, AES-256) before upload, and the passphrase lives only
in a GitHub secret. The workflow needs two secrets: `BACKUP_DATABASE_URL` (the `polashi_readonly`
string) and `BACKUP_PASSPHRASE`. To restore: download the artifact,
`gpg -d polashi-<date>.dump.gpg > polashi.dump`, then `pg_restore`.

GitHub switches off scheduled workflows in a public repository after 60 days without any activity
in it. If the repository goes quiet for two months, the workflow has to be switched back on in the
Actions tab, or the project will pause again. The workflow's own runs don't count as activity.

## 8. Rollout

Each step is its own PR or task, in order.

1. **Postgres logger and `playerKey`.** Schema, migration runner, new logger, server hooks, tests,
   the keep-awake workflow, and the frontend's `playerKey`. Before deploying: run the migration,
   set the two role passwords, add `DATABASE_URL` to Render and the GitHub secrets. From this
   deploy on, logs go to Postgres only.
2. **Import.** Export Firestore, run the import, check the numbers in section 6.
3. **Remove Firebase.** (Code part done 2026-10-04.) Delete `firebase-admin.js`, the `firebase-admin` dependency and the
   `FIREBASE_*` variables on Render. Leave the Firestore project untouched for a month as a
   backup, then delete it and revoke the service-account key, including the key file in the
   `palassy-game` folder.
Switching directly is simpler than writing to both databases for a while; Firestore stays as the
backup during the month in step 3.

## Decisions

- The frontend `playerKey` ships with step 1 (decided 2026-10-04).
- Player names are kept indefinitely (decided 2026-10-04).
