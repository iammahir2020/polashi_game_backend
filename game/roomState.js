// Converts a live room to plain JSON for the database and back, so a room can
// outlive the process that holds it (a deploy, a restart, the free plan going
// to sleep). See persist-rooms.md.
//
// Almost everything in a room is already plain data and is copied as it is, so
// a field added to rooms later is saved without changes here. The exceptions:
//   - socketId / online only mean something to the process that set them:
//     saved as null / false, and each player sets them again on reconnecting.
//   - creatorIp isn't saved: the database holds no IP addresses. The per-address
//     room cap starts counting afresh after a restart.
//   - playerStats is a Map: saved as [id, stats] pairs.
//   - gameLog belongs to GameLogger: only its database ids and the players'
//     teams are saved; its queue of pending writes is not.
//   - voting.startedAt is a Date: saved as an ISO string.

const VERSION = 1;

function serializeRoom(room) {
  const out = {};
  for (const [key, value] of Object.entries(room)) {
    if (key === "creatorIp") continue;
    if (key === "players") {
      out.players = value.map(({ socketId, online, awaitingRestore, ...p }) => ({ ...p, socketId: null, online: false }));
    } else if (key === "playerStats") {
      out.playerStats = value ? [...value] : value;
    } else if (key === "gameLog") {
      out.gameLog = value
        ? {
            id: value.id ?? null,
            openProposalId: value.openProposalId ?? null,
            teams: value.teams ? [...value.teams] : null,
          }
        : value;
    } else if (key === "voting") {
      out.voting = value && value.startedAt instanceof Date
        ? { ...value, startedAt: value.startedAt.toISOString() }
        : value;
    } else {
      out[key] = value;
    }
  }
  // A deep copy, taken now: the room keeps changing after this returns.
  return JSON.parse(JSON.stringify({ v: VERSION, room: out }));
}

function deserializeRoom(saved) {
  if (!saved || saved.v !== VERSION || !saved.room || !Array.isArray(saved.room.players)) {
    throw new Error("Unrecognised saved room");
  }
  const room = { ...saved.room };
  // Every player is offline until they reconnect. The first reconnect after a
  // restore isn't counted in their stats: the restart caused it, not them.
  room.players = room.players.map((p) => ({ ...p, socketId: null, online: false, awaitingRestore: true }));
  if (Array.isArray(room.playerStats)) room.playerStats = new Map(room.playerStats);
  if (room.gameLog) {
    const { id, openProposalId, teams } = room.gameLog;
    room.gameLog = {};
    if (id != null) room.gameLog.id = id;
    if (openProposalId != null) room.gameLog.openProposalId = openProposalId;
    if (Array.isArray(teams)) room.gameLog.teams = new Map(teams);
  }
  if (room.voting && typeof room.voting.startedAt === "string") {
    room.voting = { ...room.voting, startedAt: new Date(room.voting.startedAt) };
  }
  return room;
}

module.exports = { serializeRoom, deserializeRoom };
