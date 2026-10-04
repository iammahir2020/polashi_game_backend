# Feature plan

Ideas for making the game more fun to play and to come back to, in the order they should be built.
Each item notes which repo it touches: **backend** is this repo, **frontend** is
[polashi_game_frontend](https://github.com/iammahir2020/polashi_game_frontend).

## What the game has today

- 5-10 players; Nawabs against the East India Company over up to five missions (`MISSION_CONFIGS`)
- 10 characters, the Guptochor investigation after round 2, and Mir Jafor's final strike at
  Mir Madan when the Nawabs reach three wins
- Observer mode, reconnecting to your seat with a token, Bangla UI, installable as a PWA

What it lacks: any limit on rejected teams, a way to talk or react inside the game, phase timers, a
quick rematch, a look back at the game once it ends, and anything that carries over from one game
to the next.

People return to a party game for their friends and the stories from each game. Every item below
serves that. Streak nags, loot boxes and similar tricks are deliberately left out.

---

## Phase 1: the end of the game

The reveal and the argument afterwards are the best part of a deduction game, and today the game
ends on a winner and a list of roles. These three items work well together, need no accounts, and
are mostly frontend work.

### 1.1 Round-by-round replay

When the game ends, show every round: the General, the team they proposed, how each player voted
on it, how many sabotages the mission had, and the result, with every role revealed.

- **Backend:** each proposal and mission is written to Postgres as it resolves
  (`proposalResolved` and `missionResolved` in `GameLogger.js`), but the room keeps nothing once
  the next vote replaces `room.voting`. Add `room.roundLog` (one entry per
  council vote, including rejected teams) in `castVote`, clear it in `startGame` and `resetGame`,
  and send it through `roomViewer` in `game/room.js` only once `gameStatus === "OVER"`.
- **Rule to keep:** mission votes stay anonymous to players even after the game, as they are now
  (`visibleVoting` shuffles them). The replay shows the sabotage count, never who sabotaged. The
  database does record who sabotaged (`mission_votes`, see `postgres-migration.md`), for the admin
  panel only.
- **Frontend:** a timeline in `GameResultOverlay`.
- **Tests:** the log is hidden during the game, appears once it ends, holds counts only for mission
  votes, and is cleared on reset.

### 1.2 Awards

Two or three titles, worked out from `roundLog` when the game ends, for example:

| Award | Given to |
|---|---|
| Master of Deceit | The Company player who was sent on the most missions |
| Sharp Eye | The Nawab who voted against the most teams that had a traitor on them |
| Blind Trust | The player who approved the most teams that had a traitor on them |

They can be computed in the frontend from the replay data; nothing extra needs storing.

### 1.3 One-tap rematch and a running score

- A "Play again" button for the host that starts a new game with the same players and the same
  character choices, so they don't go back through the lobby. `resetGame` already keeps the room;
  this is `resetGame` followed by `startGame` with the previous settings.
- A score for the evening kept on the room, shown in the header: "Tonight: Nawabs 3 - Company 2".
  The room already has `seriesId` and `gamesStarted` (written to the game logs as `series_id` and
  `game_number_in_series`); add the two win counts next to them. `resetGame` keeps them; closing
  the room ends them.

---

## Phase 2: tension during the game

### 2.1 A limit on rejected teams

Today a team can be rejected any number of times at no cost. Count rejections in a row on the
room; when it reaches 5, the Company wins (Avalon's rule). Show the count next to the round
tracker so every vote against carries weight.

- **Backend:** the counter goes in `castVote` (it goes back to zero when a team is approved),
  with a new winner reason for the end screen and the game log.
- **Frontend:** the counter in `RoundTracker`, and a warning when one rejection is left.
- Make it a lobby setting, on by default, so groups used to the current rules can switch it off.

### 2.2 Optional phase timers

Host-set time limits for proposing a team, discussion and voting, so one player who has gone quiet
can't hold everyone up. The server owns the deadline (`room.phaseEndsAt`) and decides what happens
when it passes, for example a player who hasn't voted counts as approving. Off by default.

### 2.3 Reactions and naming suspects

Groups playing remotely have no way to talk inside the game. Add:

- Emoji reactions that appear briefly on the player's card
- An "I suspect X" marker that each player can place on one other player and change at any time

Both are fixed choices, not free text, so there is nothing to moderate. They need rate limiting
like every other event (the per-socket and per-address limits already cover new events).

---

## Phase 3: replay value

### 3.1 Optional roles

Extra characters the host can switch on in the lobby, leaving the current set as the default. For
example:

- A Nawab who learns who Mir Jafor is but must not be found out
- A Company player whom the Guptochor's investigation shows as loyal to the Nawabs

Historical figures like Jagat Seth or Robert Clive fit the setting. Each role needs its rules in
`startGame`, any secret information in `personalizeRoom`, and a line in How to Play.

### 3.2 Rule variants

Host toggles such as two Guptochor investigations a game, or the investigation passing from player
to player (Avalon's Lady of the Lake). Group them under one "Variants" section of the lobby so the
default setup stays simple.

---

## Phase 4: bringing players back

### 4.1 Profiles and stats

Win rate on each side, how often a player's Mir Jafor finds Mir Madan, longest winning streak.

- Since 2026-10-04 each device sends a random `playerKey`, stored with every game
  (`polashi.players`, `polashi.game_players.player_key`). That is enough for "stats on this
  device" with no sign-in, and every stat above is one query over `game_players` and `games`.
- The key proves nothing (anyone can send any key) and is lost with the browser's storage. For
  profiles that follow a person across devices, add sign-in, for example Supabase Auth with
  anonymous sign-in first, upgraded to Google later, and link the device keys to the account.
- The 113 games imported from Firestore have no `player_key`, so they count only towards overall
  statistics, not any player's.
- Needs a privacy note: player names are already kept indefinitely; stats shown back to players
  make that more visible.

### 4.2 Shareable result card

An image after each game, sized for WhatsApp and Facebook ("I was Mir Jafor and fooled 6 Nawabs"),
with a link to the site. Drawn in the browser; no backend work.

### 4.3 QR code and invite link

A QR code and a link that open straight into a room, so nobody types a room code. The most useful
of these when everyone is in the same room. Frontend only, using the existing `joinRoom`.

---

## Later: bots

Needing five players is the biggest barrier for anyone who wants to play right now. Bots that fill
empty seats, even simple ones that vote by fixed rules, would let a group of 3 or 4 learn the
game. Bots that bluff convincingly are a much bigger project. The bots from the capacity tests
show the server needs no changes to host them.

---

## Order of work

| Step | Items | Repos | Size |
|---|---|---|---|
| 1 | 1.1 Replay, 1.2 Awards, 1.3 Rematch and score | backend + frontend | Small to medium |
| 2 | 2.1 Rejection limit | backend + frontend | Small |
| 3 | 2.3 Reactions and suspects | backend + frontend | Medium |
| 4 | 2.2 Phase timers | backend + frontend | Medium |
| 5 | 4.2 Result card, 4.3 QR invite | frontend | Small |
| 6 | 3.1 Optional roles, 3.2 Variants | backend + frontend | Medium per role |
| 7 | 4.1 Profiles and stats | backend + frontend (+ Supabase Auth for cross-device) | Medium to large |
| 8 | Bots | backend | Large |
