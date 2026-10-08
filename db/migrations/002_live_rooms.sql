-- Live rooms, saved so a game survives a deploy or restart. See persist-rooms.md.
--
-- A separate schema from the game logs (`polashi`) on purpose: a saved room
-- holds every player's rejoin secret and hidden role, so only the game server
-- (polashi_app) may touch it. polashi_readonly gets nothing here, and the weekly
-- backup, which dumps only the `polashi` schema as polashi_readonly, never
-- contains it. Rows only live as long as their room: deleted when the room is
-- closed, emptied or swept as idle.

create schema if not exists polashi_live;
revoke all on schema polashi_live from public;

-- One row per running server process. A process refreshes its heartbeat every
-- few seconds; rooms owned by a process that has stopped refreshing can be
-- taken over by another one.
create table polashi_live.instances (
  id            text primary key,
  started_at    timestamptz not null default now(),
  heartbeat_at  timestamptz not null default now()
);

create table polashi_live.rooms (
  code           text primary key,
  state          jsonb not null,           -- game/roomState.js: { v, room }
  owner          text not null,            -- instances.id of the process holding the room
  released       boolean not null default false,  -- owner shut down and handed the room on
  last_activity  timestamptz not null,
  saved_at       timestamptz not null default now()
);
create index rooms_last_activity_idx on polashi_live.rooms (last_activity);

grant usage on schema polashi_live to polashi_app;
grant select, insert, update, delete on polashi_live.instances, polashi_live.rooms to polashi_app;

-- Supabase's API roles get nothing here, even if a default grant reached them.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema polashi_live from %I', r);
      execute format('revoke all on schema polashi_live from %I', r);
    end if;
  end loop;
end
$$;

alter table polashi_live.instances enable row level security;
alter table polashi_live.rooms enable row level security;
create policy polashi_app_all on polashi_live.instances for all to polashi_app using (true) with check (true);
create policy polashi_app_all on polashi_live.rooms for all to polashi_app using (true) with check (true);
