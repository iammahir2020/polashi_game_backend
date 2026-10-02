const { io: connectClient } = require("socket.io-client");
const { createGameServer } = require("../game/createGameServer");

// Starts a game server on a random port with a recording logger.
async function startServer(options = {}) {
  const calls = [];
  const logger = {
    logGameStart: (code, room) => { room.currentLogId = `log-${code}`; calls.push(["start", code]); },
    logRoundResult: (logId, round, data) => calls.push(["round", logId, round, data.result]),
    logGameOver: (logId, winner) => calls.push(["over", logId, winner]),
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

module.exports = { startServer, next, silence, setupRoom, startGame, ALL_CHARACTERS };
