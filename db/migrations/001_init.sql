-- Game logs: one row per game, its players, every team proposal with its
-- votes, and Guptochor investigations. See postgres-migration.md, section 3.
--
-- Everything lives in the `polashi` schema, which Supabase's Data API doesn't
-- serve. The game server connects as polashi_app (select, insert, update on
-- these tables, nothing else); backups and reading tools use polashi_readonly.
-- Both roles are created without a password; set them by hand once:
--   alter role polashi_app password '...';
--   alter role polashi_readonly password '...';

create schema if not exists polashi;
revoke all on schema polashi from public;

create table polashi.players (
  player_key   uuid primary key,          -- random id the frontend keeps per device
  display_name text not null,             -- the name used most recently
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
  end_reason            text check (end_reason in (
                          'three_fails', 'assassin_hit', 'assassin_missed', 'reset_by_host',
                          'room_closed', 'room_emptied', 'swept_idle', 'server_restart', 'legacy_unknown')),
  winner                text check (winner in ('NAWABS', 'EIC')),
  player_count          smallint not null,
  observer_count        smallint not null default 0,
  settings              jsonb not null,   -- { selectedCharIds, disableSecretIntelligence }
  mission_results       text check (mission_results ~ '^[SF]{0,5}$'),
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
  sabotages      smallint,                 -- set when the mission vote ends
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

-- Who sabotaged. For analysis and the admin panel only: players never see it.
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

create index games_started_at_idx on polashi.games (started_at);
create index games_in_progress_idx on polashi.games (id) where status = 'in_progress';
create index game_players_player_key_idx on polashi.game_players (player_key);
create index game_players_name_idx on polashi.game_players (lower(name));
create index proposals_game_round_idx on polashi.proposals (game_id, round, attempt);
create index investigations_game_idx on polashi.investigations (game_id);

-- Roles. Created only if missing, since roles are shared by every database
-- on the server.
do $$
begin
  if not exists (select from pg_roles where rolname = 'polashi_app') then
    create role polashi_app login;
  end if;
  if not exists (select from pg_roles where rolname = 'polashi_readonly') then
    create role polashi_readonly login;
  end if;
end
$$;

grant usage on schema polashi to polashi_app, polashi_readonly;

grant select, insert, update on
  polashi.players, polashi.games, polashi.game_players, polashi.proposals,
  polashi.approval_votes, polashi.mission_votes, polashi.investigations
  to polashi_app;

grant select on
  polashi.players, polashi.games, polashi.game_players, polashi.proposals,
  polashi.approval_votes, polashi.mission_votes, polashi.investigations,
  polashi.schema_migrations
  to polashi_readonly;
-- pg_dump reads the id sequences' positions too.
grant select on all sequences in schema polashi to polashi_readonly;

-- Supabase's API roles get nothing here, even if a default grant reached them.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema polashi from %I', r);
      execute format('revoke all on schema polashi from %I', r);
    end if;
  end loop;
end
$$;

-- Row Level Security on every table, with one policy per role. The app's
-- policy has no delete grant behind it, so it can't remove rows.
do $$
declare t text;
begin
  foreach t in array array['players', 'games', 'game_players', 'proposals',
                           'approval_votes', 'mission_votes', 'investigations'] loop
    execute format('alter table polashi.%I enable row level security', t);
    execute format('create policy polashi_app_all on polashi.%I for all to polashi_app using (true) with check (true)', t);
    execute format('create policy polashi_readonly_select on polashi.%I for select to polashi_readonly using (true)', t);
  end loop;
end
$$;

alter table polashi.schema_migrations enable row level security;
create policy polashi_readonly_select on polashi.schema_migrations for select to polashi_readonly using (true);
