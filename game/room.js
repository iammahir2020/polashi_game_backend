const crypto = require("crypto");
const { fakeHistoricalNames } = require("./constants");

// Fisher-Yates shuffle (moved verbatim from server.js; used for the deck and intel order).
function shuffle(array) {
  let currentIndex = array.length, randomIndex;
  while (currentIndex !== 0) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex], array[currentIndex]];
  }
  return array;
}

// The "Secret Intel" names one player sees. The body is the original logic from
// broadcastRoomUpdate, unchanged.
function computeSecretIntel(room, p) {
  const myChar = p.character;
  let intelNames = [];

  // Logic to gather names for the "Secret Intel" list
  if (room.gameStarted && myChar && !room.disableSecretIntelligence) {
    room.players.forEach((other) => {
      if (other.id === p.id) return; // Skip myself

      if (!room.activePlayerIds?.includes(other.id)) return;

      // EIC Knowledge (Except Omi Chand)
      if (myChar.team === "East India Company (EIC)" && myChar.id !== 4) {
        if (other.character?.team === "East India Company (EIC)") {
          if (other.character.id === 4) {
            intelNames.push(`${other.name} (EIC - ${other.character.name})`);
          } else {
            intelNames.push(`${other.name} (EIC)`);
          }
        }
      }

      // Mir Madan Knowledge
      if (myChar.id === 8) {
        if (other.character?.team === "East India Company (EIC)" && other.character.id !== 2) {
          intelNames.push(`${other.name} (EIC)`);
        }
      }

      // Mohanlal Knowledge
      if (myChar.id === 9) {
        if (other.character?.id === 8 || other.character?.id === 3) {
          intelNames.push(`${other.name}`);
        }
      }

      // --- Red Herring Logic (For Standard Characters) ---
      const specialIds = [8, 9];
      const isStandardEIC = myChar.team === "East India Company (EIC)" && myChar.id !== 4;

      if (!isStandardEIC && !specialIds.includes(myChar.id) && intelNames.length === 0) {
        // Pick 2 names from the historical pool that AREN'T in the current character list 
        // to prevent confusion with active roles
        const activeCharNames = room.players.map(pl => pl.character?.name);
        const safeFakeNames = fakeHistoricalNames.filter(name => !activeCharNames.includes(name));

        const shuffledFake = safeFakeNames.sort(() => 0.5 - Math.random());
        intelNames.push(...shuffledFake.slice(0, 2));
      }
      intelNames = shuffle([...intelNames]);
    });
  }

  return intelNames;
}

// Server-only fields that must never reach a client.
const PRIVATE_ROOM_KEYS = new Set(["players", "voting", "currentLogId", "generalHistory", "lastActivity", "creatorIp"]);

// Votes as clients may see them. While a vote is open nobody sees anyone's
// choice, only who has voted (`true`), which the client already understands.
// Once a mission vote closes, choices are sent under shuffled anonymous keys so
// the tally works but no sabotage maps back to a player. Closed council votes
// stay per player, as before: they are public in this game.
function visibleVoting(voting) {
  if (!voting) return voting;
  const votes = voting.votes || {};
  let shownVotes;
  if (voting.active) {
    shownVotes = Object.fromEntries(Object.keys(votes).map((id) => [id, true]));
  } else if (voting.type === "missionOutcome") {
    const choices = shuffle(Object.values(votes));
    shownVotes = Object.fromEntries(choices.map((choice, i) => [`v${i + 1}`, choice]));
  } else {
    shownVotes = { ...votes };
  }
  return { active: voting.active, votes: shownVotes, result: voting.result, type: voting.type };
}

// Builds the views of one room for any number of viewers. Everything that is
// the same for all viewers is computed once; per viewer only the character
// visibility and the secret intel differ. Players never include socket ids or
// reconnect secrets; characters only for yourself, observers, or after the game.
function roomViewer(room) {
  const shared = {};
  for (const [key, value] of Object.entries(room)) {
    if (!PRIVATE_ROOM_KEYS.has(key)) shared[key] = value;
  }
  shared.proposedTeam = room.proposedTeam || [];
  if ("voting" in room) shared.voting = visibleVoting(room.voting);

  const basePlayers = room.players.map((other) => ({
    id: other.id,
    name: other.name,
    isGameMaster: !!other.isGameMaster,
    online: !!other.online,
    ...(other.isGeneral !== undefined ? { isGeneral: other.isGeneral } : {}),
    ...(other.isObserver !== undefined ? { isObserver: other.isObserver } : {}),
  }));
  const gameOver = room.gameStatus === "OVER";

  return function viewFor(viewer) {
    const isObserver = room.gameStarted && !room.activePlayerIds?.includes(viewer.id);
    const revealAll = gameOver || isObserver;
    const players = basePlayers.map((base, i) => {
      const other = room.players[i];
      return { ...base, character: revealAll || other.id === viewer.id ? other.character : null };
    });
    return { ...shared, players, secretIntel: computeSecretIntel(room, viewer) };
  };
}

// The room as one player is allowed to see it.
function personalizeRoom(room, viewer) {
  return roomViewer(room)(viewer);
}

// 6-character room code from a CSPRNG, unique among live rooms.
const ROOM_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function generateRoomCode(isTaken) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = "";
    for (let i = 0; i < 6; i++) code += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)];
    if (!isTaken(code)) return code;
  }
  throw new Error("Could not allocate a room code");
}

function generateReconnectToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function tokensMatch(expected, given) {
  if (typeof expected !== "string" || typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  shuffle,
  computeSecretIntel,
  roomViewer,
  personalizeRoom,
  visibleVoting,
  generateRoomCode,
  generateReconnectToken,
  tokensMatch,
};
