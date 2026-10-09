// Every message the server sends players, by code.
//
// The client shows these in English or Bangla. So that older clients keep
// working, each one still carries its English text:
//   errorMessage:  socket.emit("errorMessage", <English text>, { code, params? })
//                  older clients read only the first argument
//   notification:  { message: <English text>, code, params, type, ... }
//                  older clients read only `message`
// Newer clients look the code up ("server.<CODE>" / "notify.<CODE>" in the
// frontend's src/i18n/en.ts) and fill in `params`. The codes are part of the
// protocol: rename one in both repos or not at all. A code the client doesn't
// know is shown as the English text.

const ERRORS = {
  RATE_LIMITED: "Too many actions. Please slow down.",
  SERVER_UPDATING: "The server is updating. Please try again in a few seconds.",
  NAME_REQUIRED: "Please enter a name.",
  SERVER_FULL: "The server is full right now. Please try again later.",
  TOO_MANY_ROOMS: "Too many rooms have been opened from your network. Close one or try again later.",
  CREATE_FAILED: "Could not create a room. Please try again.",
  ROOM_NOT_FOUND: "Room not found",
  ROOM_LOCKED: "Room is locked",
  ROOM_FULL: "Room full",
  NOT_HOST_CLOSE: "Unauthorized: Only the Master can dissolve HQ.",
  ROOM_GONE: "Room no longer exists",
  PLAYER_NOT_FOUND: "Player not found in room",
  NOT_HOST_GENERAL: "Only the GM can appoint a General.",
  NOT_HOST: "Only GM allowed",
  BAD_BATTALION_SIZE: "Battalion must be between 5 and 10 players.",
  BAD_BATTALION_PLAYERS: "Battalion contains players who are not in this room.",
  CHARACTERS_INCOMPLETE: "Select enough characters for both sides before starting.",
  NOT_HOST_RESET: "Only the GM can reset the game.",
  INTEL_LOCKED: "Secret Intel setting can only be changed before the game starts.",
};

const NOTIFICATIONS = {
  GUPTOCHOR_DEPLOYED: ({ requester, target }) =>
    `🕵️‍♂️ Intelligence Alert: ${requester} has deployed a Guptochor to investigate ${target}!`,
  MIR_JAFOR_TURN: ({ name }) =>
    `🚨 Critical Alert: The Nawabs have the lead, but ${name} is attempting a final betrayal!`,
};

// Sends one of ERRORS to one socket.
function sendError(socket, code) {
  if (!ERRORS[code]) throw new Error(`Unknown error code: ${code}`);
  socket.emit("errorMessage", ERRORS[code], { code });
}

// The payload of a "notification": the English text, its code and the values
// that fill it, plus any extra fields (type, ids).
function notification(code, params, extra = {}) {
  if (!NOTIFICATIONS[code]) throw new Error(`Unknown notification code: ${code}`);
  return { message: NOTIFICATIONS[code](params), code, params, ...extra };
}

module.exports = { ERRORS, NOTIFICATIONS, sendError, notification };
