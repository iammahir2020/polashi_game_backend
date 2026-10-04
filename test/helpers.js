const { io: connectClient } = require("socket.io-client");
const { createGameServer } = require("../game/createGameServer");
const { MISSION_CONFIGS } = require("../game/constants");

// Starts a game server on a random port with a recording logger.
async function startServer(options = {}) {
  // Every game log event, as [event, data]; each game's object gets a number
  // so tests can tell games apart.
  const calls = [];
  let games = 0;
  const record = (event) => (game, data) => {
    if (event === "gameStarted") game.n = ++games;
    calls.push([event, { game: game.n, ...data }]);
  };
  const logger = {
    gameStarted: record("gameStarted"),
    proposalResolved: record("proposalResolved"),
    missionResolved: record("missionResolved"),
    investigation: record("investigation"),
    gameEnded: record("gameEnded"),
  };
  const quietLog = { info() {}, warn() {}, error() {} };
  const server = createGameServer({ logger, log: quietLog, sweepEveryMs: 0, ...options });
  await new Promise((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = server.httpServer.address();
  const url = `http://127.0.0.1:${port}`;
  const clients = [];

  async function client(extra = {}) {
    const socket = connectClient(url, { transports: ["websocket"], reconnection: false, forceNew: true, ...extra });
    clients.push(socket);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    return socket;
  }

  async function stop() {
    clients.forEach((c) => c.close());
    await server.close();
  }

  return { ...server, url, calls, client, stop };
}

// Resolves with the next `event` payload matching `pred`.
function next(socket, event, pred = () => true, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for ${event}`));
    }, ms);
    function handler(data) {
      if (pred(data)) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(data);
      }
    }
    socket.on(event, handler);
  });
}

// Resolves true if no matching event arrives within `ms`.
function silence(socket, event, pred = () => true, ms = 300) {
  return next(socket, event, pred, ms).then(() => false, () => true);
}

// Creates a room and joins `count - 1` more players. Returns players with their sockets.
async function setupRoom(srv, count, names) {
  const players = [];
  const host = await srv.client();
  const created = next(host, "roomJoined");
  host.emit("createRoom", { name: names?.[0] ?? "Host" });
  const hostJoined = await created;
  players.push({ socket: host, id: hostJoined.playerId, token: hostJoined.reconnectToken, name: names?.[0] ?? "Host" });
  const roomCode = hostJoined.roomCode;
  for (let i = 1; i < count; i++) {
    const s = await srv.client();
    const joined = next(s, "roomJoined");
    const name = names?.[i] ?? `Player ${i}`;
    s.emit("joinRoom", { roomCode, name });
    const data = await joined;
    players.push({ socket: s, id: data.playerId, token: data.reconnectToken, name });
  }
  return { roomCode, players, host: players[0] };
}

const ALL_CHARACTERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

async function startGame(srv, setup, opts = {}) {
  const { roomCode, players, host } = setup;
  const started = next(host.socket, "roomUpdated", (r) => r.gameStarted);
  host.socket.emit("startGame", {
    roomCode,
    activeIds: players.map((p) => p.id),
    requesterId: host.id,
    selectedCharIds: opts.selectedCharIds || ALL_CHARACTERS,
    disableSecretIntelligence: false,
  });
  return started;
}

// Plays one round the way the UI does: host appoints a General, the General
// proposes a team and calls the council vote, everyone votes, the host calls the
// secret vote, the team votes. `teamOrder` (player ids) decides who is picked
// first; by default the battalion in seating order.
async function playRound(setup, { council = "yes", mission = "yes", teamOrder } = {}) {
  const { roomCode, players, host } = setup;
  let update = next(host.socket, "roomUpdated", (r) => r.players.some((p) => p.isGeneral));
  host.socket.emit("assignGeneral", { roomCode, requesterId: host.id });
  let room = await update;
  const generalId = room.players.find((p) => p.isGeneral).id;
  const general = players.find((p) => p.id === generalId);
  const size = MISSION_CONFIGS[room.activePlayerIds.length][room.currentRound - 1].players;
  const team = (teamOrder || room.activePlayerIds).slice(0, size);

  for (let i = 1; i <= team.length; i++) {
    update = next(host.socket, "roomUpdated", (r) => r.proposedTeam.length === i);
    general.socket.emit("proposeTeam", { roomCode, playerIds: team.slice(0, i) });
    await update;
  }

  update = next(host.socket, "roomUpdated", (r) => r.voting && r.voting.active && r.voting.type === "teamApproval");
  general.socket.emit("startVote", { roomCode, requesterId: general.id });
  await update;

  update = next(host.socket, "roomUpdated", (r) => r.voting && !r.voting.active);
  players.forEach((p) => p.socket.emit("castVote", { roomCode, playerId: p.id, choice: council }));
  room = await update;
  if (room.voting.result !== "Yes") return { room, team };

  update = next(host.socket, "roomUpdated", (r) => r.voting && r.voting.active && r.voting.type === "missionOutcome");
  host.socket.emit("startSecretVote", { roomCode, requesterId: host.id });
  await update;

  update = next(host.socket, "roomUpdated", (r) => r.voting && !r.voting.active);
  players.filter((p) => team.includes(p.id)).forEach((p) =>
    p.socket.emit("castVote", { roomCode, playerId: p.id, choice: mission }),
  );
  room = await update;
  return { room, team };
}

module.exports = { startServer, next, silence, setupRoom, startGame, playRound, ALL_CHARACTERS };
