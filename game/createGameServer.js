const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");

const {
  CharacterList,
  MISSION_CONFIGS,
  TEAM_DISTRIBUTIONS,
  NAWAB_TEAM,
  EIC_TEAM,
  MIR_JAFOR_ID,
  MIR_MADAN_ID,
  WINNER_NAWABS,
  WINNER_EIC,
} = require("./constants");
const {
  shuffle,
  roomViewer,
  personalizeRoom,
  generateRoomCode,
  generateReconnectToken,
  tokensMatch,
} = require("./room");
const { normalizeName, uniqueName, schemas } = require("./validation");
const { clientIp, createBucket, createHttpLimiter } = require("./limits");

const DEFAULT_ORIGINS = [
  "https://the-great-polashi-game.vercel.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://localhost:4317",
];

const noopLogger = {
  logGameStart() {},
  logRoundResult() {},
  logGameOver() {},
};

/**
 * Builds the HTTP + Socket.IO game server without starting it.
 *
 * options:
 *   logger        game log sink ({ logGameStart, logRoundResult, logGameOver })
 *   allowedOrigins  browser origins allowed to connect ("*" allows all)
 *   maxPlayers    players per room (default 20)
 *   maxRooms      live rooms on this instance (default 1000)
 *   rateLimit     { capacity, refillPerSec } per socket
 *   ipRateLimit   { capacity, refillPerSec } shared by all sockets from one address
 *   maxConnections     open connections on this instance (default 5000, 0 = no cap)
 *   maxSocketsPerIp    open connections from one address (default 40, 0 = no cap)
 *   maxRoomsPerIp      live rooms created from one address (default 10, 0 = no cap)
 *   httpLimit     { max, windowMs } HTTP requests per address (default 120 a minute)
 *   roomIdleMs    delete rooms with nobody online after this long
 *   loneRoomIdleMs     delete unstarted rooms with at most one player and nobody
 *                      online after this long (default 10 minutes)
 *   roomMaxIdleMs delete any room untouched for this long
 *   sweepEveryMs  how often to sweep idle rooms
 *   configureApp(app)  hook to add extra HTTP routes
 *   log           { info, warn, error } (default console)
 */
function createGameServer(options = {}) {
  const logger = options.logger || noopLogger;
  const log = options.log || console;
  const MAX_PLAYERS = options.maxPlayers || 20;
  const MAX_ROOMS = options.maxRooms || 1000;
  const RATE = { capacity: 30, refillPerSec: 15, ...(options.rateLimit || {}) };
  // Generous enough for a whole party on one Wi-Fi network (up to 20 players
  // share an address), small enough that one machine can't flood the server.
  const IP_RATE = { capacity: 120, refillPerSec: 40, ...(options.ipRateLimit || {}) };
  const MAX_CONNECTIONS = options.maxConnections ?? 5000;
  const MAX_SOCKETS_PER_IP = options.maxSocketsPerIp ?? 40;
  const MAX_ROOMS_PER_IP = options.maxRoomsPerIp ?? 10;
  const HTTP_LIMIT = { max: 120, windowMs: 60 * 1000, ...(options.httpLimit || {}) };
  const ROOM_IDLE_MS = options.roomIdleMs ?? 30 * 60 * 1000;
  const LONE_ROOM_IDLE_MS = options.loneRoomIdleMs ?? 10 * 60 * 1000;
  const ROOM_MAX_IDLE_MS = options.roomMaxIdleMs ?? 12 * 60 * 60 * 1000;
  const SWEEP_EVERY_MS = options.sweepEveryMs ?? 60 * 1000;

  const allowedOrigins = options.allowedOrigins || DEFAULT_ORIGINS;
  const allowAnyOrigin = allowedOrigins.includes("*");
  const isAllowedOrigin = (origin) => allowAnyOrigin || allowedOrigins.includes(origin);

  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    next();
  });
  const httpLimiter = createHttpLimiter({ ...HTTP_LIMIT, keyOf: (req) => clientIp(req).ip });
  app.use(httpLimiter.middleware);

  // Open connections per address, and one shared event bucket per address.
  const ipConnections = new Map();
  const ipBuckets = new Map();
  let loggedIpSource = false;

  // Refuses a new connection when the instance or the address is at its cap.
  // The Origin check stops other websites; it can't stop a script, which sends
  // any Origin it likes, so the caps are what keep one machine from opening
  // thousands of sockets and exhausting the instance's memory.
  function connectionAllowed(req) {
    if (MAX_CONNECTIONS && io.engine.clientsCount >= MAX_CONNECTIONS) return false;
    const { ip } = clientIp(req);
    if (MAX_SOCKETS_PER_IP && (ipConnections.get(ip) || 0) >= MAX_SOCKETS_PER_IP) return false;
    return true;
  }
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || isAllowedOrigin(origin)),
      credentials: true,
    }),
  );

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => cb(null, !origin || isAllowedOrigin(origin)),
      credentials: true,
    },
    // Socket.IO's CORS settings don't apply to the WebSocket upgrade, so check
    // the Origin header here too. Browsers always send it; a page on another
    // site can't open a socket to this server from a visitor's browser.
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      if (origin && !isAllowedOrigin(origin)) return cb("Origin not allowed", false);
      if (!connectionAllowed(req)) return cb("Too many connections", false);
      cb(null, true);
    },
    maxHttpBufferSize: 16 * 1024,
  });

  // Counted at the transport level, so a client that completes the handshake
  // but never joins the game still counts against its address.
  io.engine.on("connection", (rawSocket) => {
    const { ip, source } = clientIp(rawSocket.request);
    if (!loggedIpSource) {
      loggedIpSource = true;
      log.info(`Client addresses are read from: ${source}`);
    }
    ipConnections.set(ip, (ipConnections.get(ip) || 0) + 1);
    rawSocket.once("close", () => {
      const left = (ipConnections.get(ip) || 1) - 1;
      if (left > 0) {
        ipConnections.set(ip, left);
      } else {
        ipConnections.delete(ip);
        ipBuckets.delete(ip);
      }
    });
  });

  // No prototype: room codes come from clients and must never hit Object.prototype keys.
  const rooms = Object.create(null);

  // socket.id -> { current: { roomCode, playerId } | null, memberships: Map<"room|player", {...}> }
  const sessions = new Map();

  function sessionOf(socket) {
    let s = sessions.get(socket.id);
    if (!s) {
      s = { current: null, memberships: new Map() };
      sessions.set(socket.id, s);
    }
    return s;
  }

  function bindSession(socket, roomCode, playerId) {
    const s = sessionOf(socket);
    const entry = { roomCode, playerId };
    s.current = entry;
    s.memberships.set(`${roomCode}|${playerId}`, entry);
  }

  function unbindPlayer(socketId, roomCode, playerId) {
    const s = sessions.get(socketId);
    if (!s) return;
    s.memberships.delete(`${roomCode}|${playerId}`);
    if (s.current && s.current.roomCode === roomCode && s.current.playerId === playerId) {
      s.current = null;
    }
  }

  // The player this socket is acting as in `roomCode`, if any.
  function actorIn(socket, roomCode) {
    const s = sessions.get(socket.id);
    if (!s) return null;
    const room = rooms[roomCode];
    if (!room) return null;
    for (const m of s.memberships.values()) {
      if (m.roomCode !== roomCode) continue;
      const player = room.players.find((p) => p.id === m.playerId);
      if (player && player.socketId === socket.id) return { room, player };
    }
    return null;
  }

  function touch(room) {
    room.lastActivity = Date.now();
  }

  function broadcastRoomUpdate(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    const viewFor = roomViewer(room);
    room.players.forEach((p) => {
      if (p.socketId) io.to(p.socketId).emit("roomUpdated", viewFor(p));
    });
  }

  function sendJoined(socket, roomCode, player) {
    socket.emit("roomJoined", {
      roomCode,
      playerId: player.id,
      room: personalizeRoom(rooms[roomCode], player),
      reconnectToken: player.reconnectToken,
    });
  }

  function safeLog(fn, ...args) {
    try {
      Promise.resolve(fn.apply(logger, args)).catch((e) => log.error("Game log failed:", e && e.message));
    } catch (e) {
      log.error("Game log failed:", e && e.message);
    }
  }

  function isHost(player) {
    return !!(player && player.isGameMaster);
  }

  // --- Room cleanup ----------------------------------------------------------
  function sweepRooms(now = Date.now()) {
    for (const [code, room] of Object.entries(rooms)) {
      const idleFor = now - (room.lastActivity || 0);
      const anyoneOnline = room.players.some((p) => p.online);
      // A room nobody else ever joined, whose host has gone, is let go sooner,
      // so abandoned (or mass-created) rooms don't hold slots for half an hour.
      const lone = !room.gameStarted && room.players.length <= 1;
      const idleLimit = lone ? Math.min(LONE_ROOM_IDLE_MS, ROOM_IDLE_MS) : ROOM_IDLE_MS;
      if (idleFor > ROOM_MAX_IDLE_MS || (!anyoneOnline && idleFor > idleLimit)) {
        for (const p of room.players) if (p.socketId) unbindPlayer(p.socketId, code, p.id);
        delete rooms[code];
      }
    }
  }
  const sweepTimer = SWEEP_EVERY_MS > 0 ? setInterval(sweepRooms, SWEEP_EVERY_MS) : null;
  if (sweepTimer) sweepTimer.unref();

  // --- HTTP -------------------------------------------------------------------
  app.get("/", (_, res) => {
    res.json({ status: "AAALL IS WELL", rooms: Object.keys(rooms).length });
  });
  if (options.configureApp) options.configureApp(app);

  // --- Sockets ------------------------------------------------------------------
  io.on("connection", (socket) => {
    const { ip } = clientIp(socket.request);
    const takeSocketToken = createBucket(RATE);
    if (!ipBuckets.has(ip)) ipBuckets.set(ip, createBucket(IP_RATE));
    const takeIpToken = ipBuckets.get(ip);
    let warnedAt = 0;

    // Each socket has its own budget, and all sockets from one address share a
    // second one, so opening more sockets doesn't buy a faster flood.
    function allowEvent() {
      if (takeSocketToken() && takeIpToken()) return true;
      const now = Date.now();
      if (now - warnedAt > 5000) {
        warnedAt = now;
        socket.emit("errorMessage", "Too many actions. Please slow down.");
      }
      return false;
    }

    // Registers a handler that is rate limited, validated and crash-proof.
    function on(event, schema, handler) {
      socket.on(event, (payload) => {
        if (!allowEvent()) return;
        let data = payload;
        if (schema) {
          const parsed = schema.safeParse(payload);
          if (!parsed.success) return;
          data = parsed.data;
        }
        try {
          handler(data);
        } catch (err) {
          log.error(`Handler "${event}" failed:`, err && err.stack ? err.stack : err);
        }
      });
    }

    on("getCharacterList", null, () => {
      socket.emit("characterListUpdate", CharacterList);
    });

    on("createRoom", schemas.createRoom, ({ name }) => {
      const cleanName = normalizeName(name);
      if (!cleanName) return socket.emit("errorMessage", "Please enter a name.");
      const liveRooms = Object.values(rooms);
      if (liveRooms.length >= MAX_ROOMS) {
        return socket.emit("errorMessage", "The server is full right now. Please try again later.");
      }
      // One address can't take every room slot on the server.
      if (MAX_ROOMS_PER_IP && liveRooms.filter((r) => r.creatorIp === ip).length >= MAX_ROOMS_PER_IP) {
        return socket.emit("errorMessage", "Too many rooms have been opened from your network. Close one or try again later.");
      }

      const roomCode = generateRoomCode((code) => !!rooms[code]);
      const id = crypto.randomUUID();

      rooms[roomCode] = {
        players: [{
          id,
          name: cleanName,
          socketId: socket.id,
          isGameMaster: true,
          online: true,
          character: null,
          reconnectToken: generateReconnectToken(),
        }],
        activePlayerIds: [],
        locked: false,
        gameStarted: false,
        guptochorId: null,
        guptochorUsed: false,
        nextGuptochorId: null,
        disableSecretIntelligence: false,
        lastActivity: Date.now(),
        creatorIp: ip, // server-only, for the per-address room cap
      };

      socket.join(roomCode);
      bindSession(socket, roomCode, id);
      sendJoined(socket, roomCode, rooms[roomCode].players[0]);
    });

    on("joinRoom", schemas.joinRoom, ({ roomCode: rawCode, name }) => {
      const roomCode = rawCode.trim().toUpperCase();
      const room = rooms[roomCode];
      if (!room) return socket.emit("errorMessage", "Room not found");
      if (room.locked) return socket.emit("errorMessage", "Room is locked");
      if (room.players.length >= MAX_PLAYERS) return socket.emit("errorMessage", "Room full");

      const cleanName = normalizeName(name);
      if (!cleanName) return socket.emit("errorMessage", "Please enter a name.");

      const id = crypto.randomUUID();
      const player = {
        id,
        name: uniqueName(cleanName, room.players.map((p) => p.name)),
        socketId: socket.id,
        isGameMaster: false,
        online: true,
        character: null,
        reconnectToken: generateReconnectToken(),
      };
      room.players.push(player);
      touch(room);

      socket.join(roomCode);
      bindSession(socket, roomCode, id);
      broadcastRoomUpdate(roomCode);
      sendJoined(socket, roomCode, player);
    });

    on("closeRoom", schemas.closeRoom, ({ roomCode }) => {
      const actor = actorIn(socket, roomCode);
      if (!actor) return;
      if (!isHost(actor.player)) {
        return socket.emit("errorMessage", "Unauthorized: Only the Master can dissolve HQ.");
      }
      const room = actor.room;

      // 1. Broadcast to everyone in the room FIRST
      io.to(roomCode).emit("roomDissolved");

      // 2. Use a tiny delay before deleting memory and kicking sockets
      // This ensures the "roomDissolved" packet actually leaves the server buffer
      setTimeout(() => {
        const roomSockets = io.sockets.adapter.rooms.get(roomCode);
        if (roomSockets) {
          roomSockets.forEach((socketId) => {
            const clientSocket = io.sockets.sockets.get(socketId);
            if (clientSocket) clientSocket.leave(roomCode);
          });
        }
        for (const p of room.players) if (p.socketId) unbindPlayer(p.socketId, roomCode, p.id);
        if (rooms[roomCode] === room) delete rooms[roomCode];
        log.info(`HQ Dissolved: Room ${roomCode} deleted.`);
      }, 100);
    });

    on("investigatePlayer", schemas.investigatePlayer, ({ roomCode, targetPlayerId }) => {
      const actor = actorIn(socket, roomCode);
      if (!actor) return;
      const { room, player: requester } = actor;
      if (!room.gameStarted || room.guptochorId !== requester.id || room.guptochorUsed) return;
      if (targetPlayerId === requester.id) return;

      const target = room.players.find((p) => p.id === targetPlayerId);
      if (!target || !target.character) return;

      room.guptochorUsed = true;
      room.nextGuptochorId = targetPlayerId;
      touch(room);

      socket.emit("guptochorResult", {
        targetName: target.name,
        alliance: target.character.team,
      });

      io.to(roomCode).emit("notification", {
        message: `🕵️‍♂️ Intelligence Alert: ${requester.name} has deployed a Guptochor to investigate ${target.name}!`,
        type: "info",
        requesterId: requester.id, // Send these so frontend can filter
        targetId: targetPlayerId,
      });

      broadcastRoomUpdate(roomCode);
    });

    on("reconnectPlayer", schemas.reconnectPlayer, ({ roomCode, playerId, reconnectToken }) => {
      const room = rooms[roomCode];
      if (!room) {
        socket.emit("errorMessage", "Room no longer exists");
        socket.emit("roomDissolved");
        return;
      }

      const player = room.players.find((p) => p.id === playerId);
      // A seat can only be reclaimed with its secret, which only its owner ever received.
      if (!player || !tokensMatch(player.reconnectToken, reconnectToken)) {
        return socket.emit("errorMessage", "Player not found in room");
      }

      if (player.socketId && player.socketId !== socket.id) {
        unbindPlayer(player.socketId, roomCode, player.id);
      }
      player.socketId = socket.id;
      player.online = true;
      touch(room);

      socket.join(roomCode);
      bindSession(socket, roomCode, player.id);

      // Send a confirmation to the reconnected player so their UI switches
      sendJoined(socket, roomCode, player);

      // Notify others that the player is back online
      broadcastRoomUpdate(roomCode);
    });

    on("assignGeneral", schemas.assignGeneral, ({ roomCode }) => {
      const actor = actorIn(socket, roomCode);
      if (!actor) return;
      const { room, player: gm } = actor;
      if (!isHost(gm)) return socket.emit("errorMessage", "Only the GM can appoint a General.");
      if (!room.gameStarted || !room.activePlayerIds || room.activePlayerIds.length === 0) return;

      if (!room.generalHistory) { room.generalHistory = []; }
      room.proposedTeam = [];
      // Only pick General from ACTIVE players
      let eligiblePlayers = room.players.filter(p => room.activePlayerIds.includes(p.id) && !room.generalHistory.includes(p.id));
      if (room.generalHistory.length === 0 && eligiblePlayers.length > 1) { eligiblePlayers = eligiblePlayers.filter(p => p.id !== gm.id); }
      if (eligiblePlayers.length === 0) {
        room.generalHistory = [];
        eligiblePlayers = room.players.filter(p => room.activePlayerIds.includes(p.id));
      }
      if (eligiblePlayers.length === 0) return;
      const randomIndex = Math.floor(Math.random() * eligiblePlayers.length);
      const newGeneral = eligiblePlayers[randomIndex];
      room.generalHistory.push(newGeneral.id);
      room.players.forEach((p) => { p.isGeneral = (p.id === newGeneral.id); });
      touch(room);
      broadcastRoomUpdate(roomCode);
      io.to(roomCode).emit("triggerGeneralAnimation", { name: newGeneral.name });
    });

    on("startVote", schemas.startVote, ({ roomCode }) => {
      const actor = actorIn(socket, roomCode);
      if (!actor) return;
      const { room, player } = actor;
      // The host (Command Console) or the current General (after picking a team) may call a vote.
      if (!isHost(player) && !player.isGeneral) return;
      if (!room.gameStarted || room.gameStatus !== "ACTIVE") return;

      room.voting = { active: true, votes: {}, result: null, type: "teamApproval" };
      touch(room);
      broadcastRoomUpdate(roomCode);
    });

    on("startSecretVote", schemas.startSecretVote, ({ roomCode }) => {
      const actor = actorIn(socket, roomCode);
      if (!actor) return;
      const { room, player } = actor;
      if (!isHost(player)) return;
      // Only after the council approved the proposed team.
      const v = room.voting;
      if (!room.gameStarted || room.gameStatus !== "ACTIVE") return;
      if (!v || v.type !== "teamApproval" || v.active || v.result !== "Yes") return;

      room.voting = { active: true, votes: {}, result: null, type: "missionOutcome" };
      touch(room);
      broadcastRoomUpdate(roomCode);
    });

    on("castVote", schemas.castVote, ({ roomCode, choice }) => {
      const actor = actorIn(socket, roomCode);
      if (!actor) return;
      const { room } = actor;
      const playerId = actor.player.id;
      if (!room.voting || !room.voting.active) return;

      if (room.voting.type === "teamApproval") {
        if (!room.activePlayerIds.includes(playerId)) return;
      } else {
        const isTeamMember = room.proposedTeam?.includes(playerId);
        if (!isTeamMember) return;
      }

      // Nawabs can't sabotage: a Nawab's mission vote always counts as a
      // success, whatever was sent. The client shows them the choice and
      // converts it too, but only the server's count can be trusted.
      const isNawabOnMission = room.voting.type === "missionOutcome" && actor.player.character?.team === NAWAB_TEAM;
      room.voting.votes[playerId] = isNawabOnMission ? "yes" : choice;
      touch(room);

      // Voting target count based on ACTIVE players or team size
      const targetCount = room.voting.type === "teamApproval"
        ? room.activePlayerIds.length
        : (room.proposedTeam?.length || 0);

      if (Object.keys(room.voting.votes).length === targetCount) {
        const noVotes = Object.values(room.voting.votes).filter(v => v === "no").length;

        if (room.voting.type === "teamApproval") {
          room.voting.result = (noVotes >= room.activePlayerIds.length / 2) ? "No" : "Yes";
        } else {
          // Lookup requirement from the MISSION_CONFIGS table
          const config = MISSION_CONFIGS[room.activePlayerIds.length][room.currentRound - 1];
          let roundResultText = "Success";
          if (noVotes >= config.failsRequired) {
            roundResultText = "Fail";
            room.voting.result = "No";
            room.scoreRed++;
            room.roundHistory.push("Red");
          } else {
            roundResultText = "Success";
            room.voting.result = "Yes";
            room.scoreGreen++;
            room.roundHistory.push("Green");
          }

          safeLog(logger.logRoundResult, room.currentLogId, room.currentRound, {
            generalName: room.players.find(p => p.isGeneral)?.name,
            proposedTeamNames: room.players.filter(p => room.proposedTeam.includes(p.id)).map(p => p.name),
            councilVotes: room.voting.votes,
            sabotageCount: noVotes,
            result: roundResultText,
          });

          if (room.scoreGreen === 3) {
            room.gameStatus = "MIR_JAFOR_TURN";
            const mirJafor = room.players.find(p => p.character?.id === MIR_JAFOR_ID);
            io.to(roomCode).emit("notification", {
              message: `🚨 Critical Alert: The Nawabs have the lead, but ${mirJafor?.name || "Mir Jafor"} is attempting a final betrayal!`,
              type: "warning",
            });
          } else if (room.scoreRed === 3) {
            room.gameStatus = "OVER";
            room.winner = WINNER_EIC;
            safeLog(logger.logGameOver, room.currentLogId, room.winner);
          } else {
            if (room.currentRound === 2) {
              const r2General = room.players.find(p => p.isGeneral);
              room.guptochorId = r2General ? r2General.id : null;
            } else if (room.currentRound > 2) {
              room.guptochorId = room.nextGuptochorId || null;
            }
            room.guptochorUsed = false;
            room.nextGuptochorId = null;
            room.currentRound++;
          }
        }
        room.voting.active = false;
      }
      broadcastRoomUpdate(roomCode);
    });

    on("clearVote", schemas.clearVote, ({ roomCode }) => {
      const actor = actorIn(socket, roomCode);
      if (!actor || !isHost(actor.player)) return;
      actor.room.voting = null;
      touch(actor.room);
      broadcastRoomUpdate(roomCode);
    });

    on("startGame", schemas.startGame, ({ roomCode, activeIds, selectedCharIds, disableSecretIntelligence }) => {
      const actor = actorIn(socket, roomCode);
      if (!actor) return;
      const { room, player: gm } = actor;
      if (!isHost(gm)) return socket.emit("errorMessage", "Only GM allowed");
      if (room.gameStarted) return;

      const uniqueActive = [...new Set(activeIds)];
      // Validate active player count (5-10)
      const playerCount = uniqueActive.length;
      if (playerCount < 5 || playerCount > 10) return socket.emit("errorMessage", "Battalion must be between 5 and 10 players.");
      if (!uniqueActive.every((pid) => room.players.some((p) => p.id === pid))) {
        return socket.emit("errorMessage", "Battalion contains players who are not in this room.");
      }

      const selectedCharacters = [...new Set(selectedCharIds)].map(cid =>
        CharacterList.find(c => c.id === cid)
      ).filter(Boolean);

      const [nawabTarget, eicTarget] = TEAM_DISTRIBUTIONS[playerCount];
      const nawabChoices = selectedCharacters.filter(c => c.team === NAWAB_TEAM && c.id !== MIR_MADAN_ID);
      const eicChoices = selectedCharacters.filter(c => c.team === EIC_TEAM && c.id !== MIR_JAFOR_ID);
      const hasCore = selectedCharacters.some(c => c.id === MIR_JAFOR_ID) && selectedCharacters.some(c => c.id === MIR_MADAN_ID);
      if (!hasCore || nawabChoices.length < nawabTarget - 1 || eicChoices.length < eicTarget - 1) {
        return socket.emit("errorMessage", "Select enough characters for both sides before starting.");
      }

      room.disableSecretIntelligence = !!disableSecretIntelligence;
      room.activePlayerIds = uniqueActive;

      const mirJafar = selectedCharacters.find(c => c.id === MIR_JAFOR_ID);
      const mirMadan = selectedCharacters.find(c => c.id === MIR_MADAN_ID);
      let gameDeck = [mirMadan, mirJafar];

      const nawabPool = shuffle(nawabChoices);
      const eicPool = shuffle(eicChoices);

      for (let i = 0; i < nawabTarget - 1; i++) gameDeck.push(nawabPool.pop());
      for (let i = 0; i < eicTarget - 1; i++) gameDeck.push(eicPool.pop());

      let deck = shuffle([...gameDeck]);
      let deckIdx = 0;

      // Assign characters ONLY to active players; others are observers
      room.players.forEach((player) => {
        if (uniqueActive.includes(player.id)) {
          player.character = deck[deckIdx++];
          player.isObserver = false;
        } else {
          player.character = null;
          player.isObserver = true;
        }
      });

      room.currentRound = 1;
      room.scoreGreen = 0;
      room.scoreRed = 0;
      room.roundHistory = [];
      room.gameStatus = "ACTIVE";
      room.guptochorId = null;
      room.nextGuptochorId = null;
      room.guptochorUsed = false;
      room.gameStarted = true;
      room.locked = true;
      touch(room);

      safeLog(logger.logGameStart, roomCode, room);

      broadcastRoomUpdate(roomCode);
    });

    on("resetGame", schemas.resetGame, ({ roomCode }) => {
      const actor = actorIn(socket, roomCode);
      if (!actor) return;
      const { room, player: gm } = actor;
      if (!isHost(gm)) return socket.emit("errorMessage", "Only the GM can reset the game.");
      room.gameStarted = false;
      room.locked = false;
      room.voting = null;
      room.generalHistory = [];
      room.gameStatus = "WAITING";
      room.proposedTeam = [];
      room.activePlayerIds = []; // Clear active list on reset
      room.disableSecretIntelligence = false;
      room.players.forEach(player => {
        player.character = null;
        player.isGeneral = false;
      });
      touch(room);
      broadcastRoomUpdate(roomCode);
    });

    on("proposeTeam", schemas.proposeTeam, ({ roomCode, playerIds }) => {
      const actor = actorIn(socket, roomCode);
      if (!actor) return;
      const { room, player } = actor;
      // Only the current General picks the team, between votes.
      if (!player.isGeneral || !room.gameStarted || room.gameStatus !== "ACTIVE") return;
      if (room.voting && room.voting.active) return;

      const team = [...new Set(playerIds)];
      if (team.length !== playerIds.length) return;
      if (!team.every((pid) => room.activePlayerIds.includes(pid))) return;
      const req = MISSION_CONFIGS[room.activePlayerIds.length]?.[(room.currentRound || 1) - 1];
      if (!req || team.length > req.players) return;

      room.proposedTeam = team; // Array of player IDs
      touch(room);
      broadcastRoomUpdate(roomCode);
    });

    on("setRoomLock", schemas.setRoomLock, ({ roomCode, locked }) => {
      const actor = actorIn(socket, roomCode);
      if (!actor) return;
      if (!isHost(actor.player)) return socket.emit("errorMessage", "Only GM allowed");

      actor.room.locked = locked;
      touch(actor.room);
      broadcastRoomUpdate(roomCode);
    });

    on("setDisableSecretIntelligence", schemas.setDisableSecretIntelligence, ({ roomCode, disableSecretIntelligence }) => {
      const actor = actorIn(socket, roomCode);
      if (!actor) return;
      const { room, player } = actor;
      if (!isHost(player)) return socket.emit("errorMessage", "Only GM allowed");
      if (room.gameStarted) return socket.emit("errorMessage", "Secret Intel setting can only be changed before the game starts.");

      room.disableSecretIntelligence = !!disableSecretIntelligence;
      touch(room);
      broadcastRoomUpdate(roomCode);
    });

    on("leaveRoom", schemas.leaveRoom, ({ roomCode }) => {
      // Players can only remove themselves.
      const actor = actorIn(socket, roomCode);
      if (!actor) return;
      const { room, player } = actor;

      const index = room.players.findIndex(p => p.id === player.id);
      if (index === -1) return;
      const wasGM = room.players[index].isGameMaster;
      room.players.splice(index, 1);
      unbindPlayer(socket.id, roomCode, player.id);
      socket.leave(roomCode);

      if (room.players.length === 0) {
        delete rooms[roomCode];
        return;
      }

      if (wasGM) room.players[0].isGameMaster = true;
      touch(room);

      broadcastRoomUpdate(roomCode);
    });

    on("kickPlayer", schemas.kickPlayer, ({ roomCode, targetPlayerId }) => {
      const actor = actorIn(socket, roomCode);
      if (!actor) return;
      const { room, player: gm } = actor;
      if (!isHost(gm)) return socket.emit("errorMessage", "Only GM allowed");
      if (targetPlayerId === gm.id) return;

      const targetIndex = room.players.findIndex(p => p.id === targetPlayerId);
      if (targetIndex === -1) return;

      const target = room.players[targetIndex];
      if (target.socketId) {
        io.sockets.sockets.get(target.socketId)?.leave(roomCode);
        unbindPlayer(target.socketId, roomCode, target.id);
      }

      room.players.splice(targetIndex, 1);
      touch(room);
      broadcastRoomUpdate(roomCode);
    });

    on("attemptAssassination", schemas.attemptAssassination, ({ roomCode, targetId }) => {
      const actor = actorIn(socket, roomCode);
      if (!actor) return;
      const { room, player } = actor;
      // Only Mir Jafor, only in the final betrayal phase, only at an active player.
      if (room.gameStatus !== "MIR_JAFOR_TURN") return;
      if (player.character?.id !== MIR_JAFOR_ID) return;
      if (!room.activePlayerIds.includes(targetId)) return;
      const targetPlayer = room.players.find(p => p.id === targetId);
      if (!targetPlayer) return;

      room.winner = targetPlayer.character?.id === MIR_MADAN_ID ? WINNER_EIC : WINNER_NAWABS;
      room.gameStatus = "OVER";
      touch(room);

      safeLog(logger.logGameOver, room.currentLogId, room.winner);

      broadcastRoomUpdate(roomCode);
    });

    socket.on("disconnect", () => {
      const s = sessions.get(socket.id);
      sessions.delete(socket.id);
      if (!s) return;
      for (const { roomCode, playerId } of s.memberships.values()) {
        const room = rooms[roomCode];
        const player = room && room.players.find((p) => p.id === playerId && p.socketId === socket.id);
        if (player) {
          player.online = false;
          broadcastRoomUpdate(roomCode);
        }
      }
    });
  });

  function close() {
    if (sweepTimer) clearInterval(sweepTimer);
    httpLimiter.stop();
    io.close();
    return new Promise((resolve) => httpServer.close(() => resolve()));
  }

  return { app, httpServer, io, rooms, sweepRooms, close };
}

module.exports = { createGameServer, DEFAULT_ORIGINS };
