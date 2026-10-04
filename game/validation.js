const { z } = require("zod");

// Display names: what other players see in the roster.
const NAME_MAX = 24;

// Characters that render as nothing or reorder text: zero-width spaces and
// joiners, word joiner, BOM, soft hyphen, bidi embeddings/overrides/isolates,
// plus every other control character.
const INVISIBLE_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;

// Cleans a player name: Unicode-normalized, invisible and direction-changing
// characters removed, whitespace collapsed, clipped to NAME_MAX code points.
// Returns "" when nothing printable is left.
function normalizeName(raw) {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .slice(0, 200)
    .normalize("NFKC")
    .replace(INVISIBLE_OR_BIDI, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, NAME_MAX).join("").trim();
}

// Two players may not share a name in a room (compared case-insensitively),
// since names are how players identify each other. A clash gets " 2", " 3"...
function uniqueName(name, takenNames) {
  const taken = new Set(takenNames.map((n) => String(n).toLocaleLowerCase()));
  if (!taken.has(name.toLocaleLowerCase())) return name;
  for (let i = 2; i < 100; i++) {
    const suffix = ` ${i}`;
    const base = Array.from(name).slice(0, NAME_MAX - suffix.length).join("").trim();
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return name;
}

const roomCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4,12}$/);
const id = z.string().min(1).max(64);
const shortText = z.string().max(200);
// The device id the frontend keeps for the game logs. Optional, and dropped
// rather than refused when malformed: it must never stop anyone from playing.
const playerKey = z.uuid().optional().catch(undefined);

// Payload schemas, one per event. Unknown keys are dropped. Fields such as
// requesterId/playerId are still accepted (the client sends them) but no
// longer trusted: the acting player always comes from the socket's session.
const schemas = {
  createRoom: z.object({ name: shortText, playerKey }),
  // Loose on purpose: a mistyped code should get "Room not found", not silence.
  joinRoom: z.object({ roomCode: z.string().max(64), name: shortText, playerKey }),
  reconnectPlayer: z.object({ roomCode, playerId: id, reconnectToken: z.string().max(128).optional() }),
  leaveRoom: z.object({ roomCode, playerId: id.optional() }),
  closeRoom: z.object({ roomCode }),
  investigatePlayer: z.object({ roomCode, targetPlayerId: id }),
  assignGeneral: z.object({ roomCode }),
  startVote: z.object({ roomCode }),
  startSecretVote: z.object({ roomCode }),
  castVote: z.object({ roomCode, choice: z.enum(["yes", "no"]) }),
  clearVote: z.object({ roomCode }),
  startGame: z.object({
    roomCode,
    activeIds: z.array(id).max(20),
    selectedCharIds: z.array(z.number().int().min(1).max(100)).max(20),
    disableSecretIntelligence: z.boolean().optional(),
  }),
  resetGame: z.object({ roomCode }),
  proposeTeam: z.object({ roomCode, playerIds: z.array(id).max(10) }),
  setRoomLock: z.object({ roomCode, locked: z.boolean() }),
  setDisableSecretIntelligence: z.object({ roomCode, disableSecretIntelligence: z.boolean() }),
  kickPlayer: z.object({ roomCode, targetPlayerId: id }),
  attemptAssassination: z.object({ roomCode, targetId: id }),
};

module.exports = { NAME_MAX, normalizeName, uniqueName, schemas };
