require('dotenv').config();
const express = require("express");
const mongoose = require('mongoose');
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { GameLogger } = require("./GameLogger"); 
// const { GameLoggerMongo } = require("./GameLoggerMongo");
const GameLog = require('./models/GameLog');

const app = express();

const allowedOrigin = process.env.CLIENT_URL || "*";

app.use(cors({
  origin: allowedOrigin,
  credentials: true
}));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigin,
    credentials: true
  }
});

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ Successfully connected to MongoDB Atlas"))
  .catch(err => console.error("❌ MongoDB connection error:", err));

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 20;

const rooms = {};

const CharacterList = [
  {
    id: 1,
    name: "মীর জাফর",
    description: "চতুর ও ধূর্ত কৌশলবিদ, বিশ্বাসঘাতকতার জন্য কুখ্যাত।",
    color: "Red",
    team: "East India Company (EIC)"
  },
  {
    id: 2,
    name: "রায় দুর্লভ",
    description: "ধনী বণিক, ষড়যন্ত্র ও প্রভাব বিস্তারে পারদর্শী।",
    color: "Red",
    team: "East India Company (EIC)"
  },
  {
    id: 3,
    name: "ঘসেটি বেগম",
    description: "ক্ষমতালোভী ও প্রভাবশালী, নীরবে ইস্ট ইন্ডিয়া কোম্পানিকে সমর্থনকারী।",
    color: "Red",
    team: "East India Company (EIC)"
  },
  {
    id: 4,
    name: "ওমিচাঁদ",
    description: "চালাক অর্থলোভী ব্যাংকার, গোপনে শত্রুপক্ষের সাথে আঁতাতকারী।",
    color: "Red",
    team: "East India Company (EIC)"
  },
  {
    id: 5,
    name: "নবাব সিরাজউদ্দৌলা",
    description: "সাহসী ও দৃঢ়চেতা শাসক, মাতৃভূমি রক্ষায় দৃঢ় প্রতিজ্ঞ।",
    color: "Green",
    team: "Nawabs"
  },
  {
    id: 6,
    name: "লুৎফুন্নিসা বেগম",
    description: "নবাবের বিশ্বস্ত সহধর্মিণী, রাজনীতি ও সিদ্ধান্তে প্রভাবশালী।",
    color: "Green",
    team: "Nawabs"
  },
  {
    id: 7,
    name: "সাঁ ফ্রাঁ",
    description: "বিদেশি সামরিক উপদেষ্টা, রণকৌশলে দক্ষ ও অভিজ্ঞ।",
    color: "Green",
    team: "Nawabs"
  },
  {
    id: 8,
    name: "মীর মদন",
    description: "নবাবের প্রতি অনুগত সাহসী সেনাপতি, যুদ্ধে অদম্য।",
    color: "Green",
    team: "Nawabs"
  },
  {
    id: 9,
    name: "মোহনলাল",
    description: "বিশ্বস্ত সহচর ও যুদ্ধে কৌশল নির্ধারণে গুরুত্বপূর্ণ ভূমিকা পালনকারী।",
    color: "Green",
    team: "Nawabs"
  },
  {
    id: 10,
    name: "দেবশী",
    description: "নবাবের অনুগত সভাসদ ও রাজদরবারের পরামর্শদাতা।",
    color: "Green",
    team: "Nawabs"
  }
];

const fakeHistoricalNames = [
  "জগত শেঠ", "উমিচাঁদ", "খাজা ওয়াজিদ", "রাজবল্লভ",
  "সিরাজুল ইসলাম", "বদর আলী", "শওকত জং", "মুর্শিদ কুলি খান"
];

const MISSION_CONFIGS = {
  5: [
    { players: 2, failsRequired: 1 }, { players: 3, failsRequired: 1 },
    { players: 2, failsRequired: 1 }, { players: 3, failsRequired: 1 },
    { players: 3, failsRequired: 1 }
  ],
  6: [
    { players: 2, failsRequired: 1 }, { players: 3, failsRequired: 1 },
    { players: 4, failsRequired: 1 }, { players: 3, failsRequired: 1 },
    { players: 4, failsRequired: 1 }
  ],
  7: [
    { players: 2, failsRequired: 1 }, { players: 3, failsRequired: 1 },
    { players: 3, failsRequired: 1 }, { players: 4, failsRequired: 2 }, // Round 4: 2 fails needed
    { players: 4, failsRequired: 1 }
  ],
  8: [
    { players: 3, failsRequired: 1 }, { players: 4, failsRequired: 1 },
    { players: 4, failsRequired: 1 }, { players: 5, failsRequired: 2 }, // Round 4: 2 fails needed
    { players: 5, failsRequired: 1 }
  ],
  9: [
    { players: 3, failsRequired: 1 }, { players: 4, failsRequired: 1 },
    { players: 4, failsRequired: 1 }, { players: 5, failsRequired: 2 }, // Round 4: 2 fails needed
    { players: 5, failsRequired: 1 }
  ],
  10: [
    { players: 3, failsRequired: 1 }, { players: 4, failsRequired: 1 },
    { players: 4, failsRequired: 1 }, { players: 5, failsRequired: 2 }, // Round 4: 2 fails needed
    { players: 5, failsRequired: 1 }
  ]
};


// --- HELPERS ---

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

function broadcastRoomUpdate(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.players.forEach((p) => {
    const myChar = p.character;
    const isObserver = room.gameStarted && !room.activePlayerIds?.includes(p.id);
    let intelNames = [];

    // Logic to gather names for the "Secret Intel" list
    if (room.gameStarted && myChar) {
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

    const personalizedRoom = {
      ...room,
      proposedTeam: room.proposedTeam || [],
      players: room.players.map((other) => {
        const shouldReveal = room.gameStatus === "OVER" || other.id === p.id || isObserver;
        return {
          ...other,
          character: shouldReveal ? other.character : null,
        }
      }),
      // Add the secret intel specifically for this player
      secretIntel: intelNames
    };

    io.to(p.socketId).emit("roomUpdated", personalizedRoom);
  });
}

app.get("/", (_, res) => {
  res.json({ status: "AAALL IS WELL", rooms: Object.keys(rooms).length });
});

// --- SOCKET LOGIC ---

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("getCharacterList", () => {
    socket.emit("characterListUpdate", CharacterList);
  });

  socket.on("createRoom", ({ name }) => {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const id = uuidv4();

    rooms[roomCode] = {
      players: [{
        id,
        name,
        socketId: socket.id,
        isGameMaster: true,
        online: true,
        character: null
      }],
      activePlayerIds: [],
      locked: false,
      gameStarted: false,
      turnIndex: 0,
      guptochorId: null,
      guptochorUsed: false,
      nextGuptochorId: null,
    };

    socket.join(roomCode);
    socket.emit("roomJoined", { roomCode, playerId: id, room: rooms[roomCode] });
  });

  socket.on("joinRoom", ({ roomCode, name }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit("errorMessage", "Room not found");
    if (room.locked) return socket.emit("errorMessage", "Room is locked");
    if (room.players.length >= MAX_PLAYERS) return socket.emit("errorMessage", "Room full");

    const id = uuidv4();
    room.players.push({
      id,
      name,
      socketId: socket.id,
      isGameMaster: false,
      online: true,
      character: null
    });

    socket.join(roomCode);
    broadcastRoomUpdate(roomCode);
    socket.emit("roomJoined", { roomCode, playerId: id, room: rooms[roomCode] });
  });

  // socket.on("closeRoom", ({ roomCode, requesterId }) => {
  //   const room = rooms[roomCode];
  //   if (!room) return;

  //   // Validation: Only GM can dissolve
  //   const gm = room.players.find(p => p.id === requesterId && p.isGameMaster);
  //   if (!gm) return socket.emit("errorMessage", "Unauthorized: Only the Master can dissolve HQ.");

  //   // 1. Notify everyone in the room
  //   io.to(roomCode).emit("roomDissolved");

  //   const roomSockets = io.sockets.adapter.rooms.get(roomCode);
  //   if (roomSockets) {
  //     for (const socketId of roomSockets) {
  //       const s = io.sockets.sockets.get(socketId);
  //       if (s) s.leave(roomCode);
  //     }
  //   }

  //   // 2. Remove room from memory
  //   delete rooms[roomCode];
  // });

  socket.on("closeRoom", ({ roomCode, requesterId }) => {
  
    const room = rooms[roomCode];
    if (!room) return;
  
    const gm = room.players.find(p => p.id === requesterId && p.isGameMaster);
    if (!gm) {
      return socket.emit("errorMessage", "Unauthorized: Only the Master can dissolve HQ.");
    }
  
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
      delete rooms[roomCode];
      console.log(`HQ Dissolved: Room ${roomCode} deleted.`);
    }, 100); 
  });

  socket.on("investigatePlayer", ({ roomCode, targetPlayerId, requesterId }) => {
    const room = rooms[roomCode];
    if (!room || room.guptochorId !== requesterId || room.guptochorUsed) return;

    const target = room.players.find(p => p.id === targetPlayerId);
    const requester = room.players.find(p => p.id === requesterId);
    if (!target || !target.character) return;

    room.guptochorUsed = true;
    room.nextGuptochorId = targetPlayerId; 

    socket.emit("guptochorResult", {
      targetName: target.name,
      alliance: target.character.team
    });

    io.to(roomCode).emit("notification", {
      message: `🕵️‍♂️ Intelligence Alert: ${requester.name} has deployed a Guptochor to investigate ${target.name}!`,
      type: "info",
      requesterId: requesterId, // Send these so frontend can filter
      targetId: targetPlayerId
    });

    broadcastRoomUpdate(roomCode);
  });

  socket.on("reconnectPlayer", ({ roomCode, playerId }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit("errorMessage", "Room no longer exists");
      socket.emit("roomDissolved");
      return;
    }

    const player = room.players.find(p => p.id === playerId);
    if (!player) return socket.emit("errorMessage", "Player not found in room");

    player.socketId = socket.id;
    player.online = true;

    socket.join(roomCode);

    // FIX: Send a confirmation to the reconnected player so their UI switches
    socket.emit("roomJoined", {
      roomCode,
      playerId,
      room
    });

    // Notify others that the player is back online
    broadcastRoomUpdate(roomCode);
  });

  socket.on("assignGeneral", ({ roomCode, requesterId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const gm = room.players.find(p => p.id === requesterId && p.isGameMaster);
    if (!gm) return socket.emit("errorMessage", "Only the GM can appoint a General.");
    if (!room.generalHistory) { room.generalHistory = []; }
    room.proposedTeam = [];
    // New change: Only pick General from ACTIVE players
    let eligiblePlayers = room.players.filter(p => room.activePlayerIds.includes(p.id) && !room.generalHistory.includes(p.id));
    if (room.generalHistory.length === 0 && eligiblePlayers.length > 1) { eligiblePlayers = eligiblePlayers.filter(p => p.id !== requesterId); }
    if (eligiblePlayers.length === 0) {
      room.generalHistory = [];
      eligiblePlayers = room.players.filter(p => room.activePlayerIds.includes(p.id));
    }
    const randomIndex = Math.floor(Math.random() * eligiblePlayers.length);
    const newGeneral = eligiblePlayers[randomIndex];
    room.generalHistory.push(newGeneral.id);
    room.players.forEach((p) => { p.isGeneral = (p.id === newGeneral.id); });
    broadcastRoomUpdate(roomCode);
    io.to(roomCode).emit("triggerGeneralAnimation", { name: newGeneral.name });
  });

  socket.on("startVote", ({ roomCode, requesterId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    // const gm = room.players.find(p => p.id === requesterId && p.isGameMaster);
    // if (!gm) return;

    room.voting = { active: true, votes: {}, result: null, type: "teamApproval" };
    broadcastRoomUpdate(roomCode);
  });

  socket.on("startSecretVote", ({ roomCode, requesterId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const gm = room.players.find(p => p.id === requesterId && p.isGameMaster);
    if (!gm) return;

    room.voting = { active: true, votes: {}, result: null, type: "missionOutcome" };
    broadcastRoomUpdate(roomCode);
  });

  socket.on("castVote", ({ roomCode, playerId, choice }) => {
    const room = rooms[roomCode];
    if (!room || !room.voting || !room.voting.active) return;

    if (room.voting.type !== "teamApproval") {
      const isTeamMember = room.proposedTeam?.includes(playerId);
      if (!isTeamMember) return;
    }

    room.voting.votes[playerId] = choice;

    // New change: Voting target count now based on ACTIVE players or team size
    const targetCount = room.voting.type === "teamApproval" 
      ? room.activePlayerIds.length 
      : (room.proposedTeam?.length || 0);

      if (Object.keys(room.voting.votes).length === targetCount) {
        const yesVotes = Object.values(room.voting.votes).filter(v => v === "yes").length;
        const noVotes = Object.values(room.voting.votes).filter(v => v === "no").length;
    
        if (room.voting.type === "teamApproval") {
          room.voting.result = (noVotes >= room.activePlayerIds.length / 2) ? "No" : "Yes";
        } else {
          // New change: Lookup requirement from the new MISSION_CONFIGS table
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

          GameLogger.logRoundResult(room.currentLogId, room.currentRound, {
            generalName: room.players.find(p => p.isGeneral)?.name,
            proposedTeamNames: room.players.filter(p => room.proposedTeam.includes(p.id)).map(p => p.name),
            councilVotes: room.voting.votes,
            sabotageCount: noVotes,
            result: roundResultText
          });

          // GameLoggerMongo.logRoundResult(room.currentLogId, room.currentRound, {
          //   generalName: room.players.find(p => p.isGeneral)?.name,
          //   proposedTeamNames: room.players.filter(p => room.proposedTeam.includes(p.id)).map(p => p.name),
          //   councilVotes: room.voting.votes,
          //   sabotageCount: noVotes,
          //   result: roundResultText
          // });
    
          if (room.scoreGreen === 3) {
            room.gameStatus = "MIR_JAFOR_TURN";
            const mirJafor = room.players.find(p => p.character?.id === 1);
            io.to(roomCode).emit("notification", {
              message: `🚨 Critical Alert: The Nawabs have the lead, but ${mirJafor?.name || "Mir Jafor"} is attempting a final betrayal!`,
              type: "warning"
            });
          } else if (room.scoreRed === 3) {
            room.gameStatus = "OVER";
            room.winner = "EIC (Red)";

            GameLogger.logGameOver(room.currentLogId, room.winner);
            // GameLoggerMongo.logGameOver(room.currentLogId, room.winner);
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

  socket.on("clearVote", ({ roomCode, requesterId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const gm = room.players.find(p => p.id === requesterId && p.isGameMaster);
    if (!gm) return;

    room.voting = null;
    broadcastRoomUpdate(roomCode);
  });

  socket.on("startGame", ({ roomCode, activeIds, requesterId, selectedCharIds }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const gm = room.players.find(p => p.id === requesterId && p.isGameMaster);
    if (!gm) return socket.emit("errorMessage", "Only GM allowed");

    // New change: Validate active player count (5-10)
    const playerCount = activeIds.length;
    if (playerCount < 5 || playerCount > 10) return socket.emit("errorMessage", "Battalion must be between 5 and 10 players.");

    room.activePlayerIds = activeIds;

    const selectedCharacters = selectedCharIds.map(id => 
      CharacterList.find(c => c.id === id)
    ).filter(Boolean);

    const mirJafar = selectedCharacters.find(c => c.id === 1);
    const mirMadan = selectedCharacters.find(c => c.id === 8);
    let gameDeck = [mirMadan, mirJafar];

    // New change: Using your specific requested team distributions
    const teamDistributions = { 5: [3, 2], 6: [4, 2], 7: [4, 3], 8: [5, 3], 9: [6, 3], 10: [6, 4] };
    const [nawabTarget, eicTarget] = teamDistributions[playerCount];
    
    const nawabPool = shuffle(selectedCharacters.filter(c => c.team === "Nawabs" && c.id !== 8));
    const eicPool = shuffle(selectedCharacters.filter(c => c.team === "East India Company (EIC)" && c.id !== 1));
    
    for (let i = 0; i < nawabTarget - 1; i++) gameDeck.push(nawabPool.pop());
    for (let i = 0; i < eicTarget - 1; i++) gameDeck.push(eicPool.pop());

    let deck = shuffle([...gameDeck]);
    let deckIdx = 0;

    // New change: Assign characters ONLY to active players; others are observers
    room.players.forEach((player) => {
      if (activeIds.includes(player.id)) {
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

    GameLogger.logGameStart(roomCode, room);
    // GameLoggerMongo.logGameStart(roomCode, room);

    broadcastRoomUpdate(roomCode);
  });

  socket.on("resetGame", ({ roomCode, requesterId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const gm = room.players.find(p => p.id === requesterId && p.isGameMaster);
    if (!gm) return socket.emit("errorMessage", "Only the GM can reset the game.");
    room.gameStarted = false;
    room.locked = false;
    room.turnIndex = 0;
    room.voting = null;
    room.generalHistory = [];
    room.gameStatus = "WAITING";
    room.proposedTeam = [];
    room.activePlayerIds = []; // New change: Clear active list on reset
    room.players.forEach(player => {
      player.character = null;
      player.isGeneral = false;
    });
    broadcastRoomUpdate(roomCode);
  });

  socket.on("proposeTeam", ({ roomCode, playerIds }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.proposedTeam = playerIds; 
    broadcastRoomUpdate(roomCode);
  });

  socket.on("proposeTeam", ({ roomCode, playerIds }) => {
    const room = rooms[roomCode];
    if (!room) return;
    
    room.proposedTeam = playerIds; // Array of player IDs
    broadcastRoomUpdate(roomCode);
  });

  socket.on("setRoomLock", ({ roomCode, locked, requesterId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const gm = room.players.find(p => p.id === requesterId && p.isGameMaster);
    if (!gm) return socket.emit("errorMessage", "Only GM allowed");

    room.locked = locked;
    broadcastRoomUpdate(roomCode);
  });

  socket.on("leaveRoom", ({ roomCode, playerId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const index = room.players.findIndex(p => p.id === playerId);
    if (index !== -1) {
      const wasGM = room.players[index].isGameMaster;
      room.players.splice(index, 1);

      if (room.players.length === 0) {
        delete rooms[roomCode];
        return;
      }

      if (wasGM) room.players[0].isGameMaster = true;
      room.turnIndex %= room.players.length;

      broadcastRoomUpdate(roomCode);
      socket.leave(roomCode);
    }
  });

  socket.on("kickPlayer", ({ roomCode, targetPlayerId, requesterId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const gm = room.players.find(p => p.id === requesterId && p.isGameMaster);
    if (!gm) return socket.emit("errorMessage", "Only GM allowed");

    const targetIndex = room.players.findIndex(p => p.id === targetPlayerId);
    if (targetIndex === -1) return;

    const targetSocketId = room.players[targetIndex].socketId;
    io.to(targetSocketId).emit("kicked");

    room.players.splice(targetIndex, 1);
    room.turnIndex %= room.players.length;
    broadcastRoomUpdate(roomCode);
  });

  socket.on("attemptAssassination", ({ roomCode, targetId, requesterId }) => {
    const room = rooms[roomCode];
    const targetPlayer = room.players.find(p => p.id === targetId);
    
    if (targetPlayer.character?.name === "মীর মদন") {
        room.winner = "East India Company (Red)";
        room.gameStatus = "OVER";
    } else {
        room.winner = "Nawabs (Green)";
        room.gameStatus = "OVER";
    }

    GameLogger.logGameOver(room.currentLogId, room.winner);
    // GameLoggerMongo.logGameOver(room.currentLogId, room.winner);
    
    io.to(roomCode).emit("roomUpdated", room);
});

  socket.on("disconnect", () => {
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const player = room.players.find(p => p.socketId === socket.id);
      if (player) {
        player.online = false;
        broadcastRoomUpdate(roomCode);
      }
    }
  });
});

app.get("/api/analytics/win-rates", async (req, res) => {
  try {
    const stats = await GameLog.aggregate([
      { $match: { status: "COMPLETED" } },
      {
        $group: {
          _id: null,
          totalGames: { $sum: 1 },
          nawabWins: { 
            $sum: { $cond: [{ $regexMatch: { input: "$winner", regex: /Nawab/i } }, 1, 0] } 
          },
          eicWins: { 
            $sum: { $cond: [{ $regexMatch: { input: "$winner", regex: /EIC/i } }, 1, 0] } 
          }
        }
      },
      {
        $project: {
          _id: 0,
          totalGames: 1,
          nawabWins: 1,
          eicWins: 1,
          nawabWinPercentage: { 
            $multiply: [{ $divide: ["$nawabWins", "$totalGames"] }, 100] 
          },
          eicWinPercentage: { 
            $multiply: [{ $divide: ["$eicWins", "$totalGames"] }, 100] 
          }
        }
      }
    ]);
    res.json(stats[0] || { totalGames: 0, nawabWins: 0, eicWins: 0 });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch win rates" });
  }
});

app.get("/api/analytics/recent-games", async (req, res) => {
  try {
    const games = await GameLog.find({ status: "COMPLETED" })
      .sort({ endTime: -1 })
      .limit(10)
      .select("roomCode winner playerCount startTime endTime");
    
    res.json(games);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch recent games" });
  }
});

app.get("/api/analytics/test", async (req, res) => {
  console.log("Test Request Received");
  try {
    // Just fetch the last 1 log to see if connection works
    const count = await GameLog.countDocuments();
    const lastLog = await GameLog.findOne().sort({ startTime: -1 });
    
    res.json({
      success: true,
      totalLogs: count,
      latestLogId: lastLog ? lastLog.logId : "No logs found"
    });
  } catch (err) {
    console.error("Test Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/analytics/all-players", async (req, res) => {
  console.log("Analytics Request: Fetching all unique players...");
  try {
    const players = await GameLog.aggregate([
      // 1. Only look at completed games
      { $match: { status: "COMPLETED" } },
      
      // 2. Convert identities Map to Array
      { $project: { identities: { $objectToArray: "$identities" } } },
      
      // 3. Flatten the array of players
      { $unwind: "$identities" },
      
      // 4. Group by name to get unique names
      {
        $group: {
          _id: "$identities.v.name"
        }
      },
      
      // 5. Sort alphabetically
      { $sort: { _id: 1 } }
    ]);
    
    // Map the result to a clean array of strings
    const playerNames = players.map(p => p._id);
    
    res.json(playerNames);
  } catch (err) {
    console.error("Analytics Error:", err);
    res.status(500).json({ error: "Failed to fetch players" });
  }
});

// server.listen(PORT, '0.0.0.0', () => {
//   console.log(`Server running on port ${PORT}`);
// });
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});