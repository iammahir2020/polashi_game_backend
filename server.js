const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

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

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;

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

const MISSION_REQUIREMENTS = [
  { players: 3, failsRequired: 1 }, // Round 1
  { players: 4, failsRequired: 1 }, // Round 2
  { players: 4, failsRequired: 1 }, // Round 3
  { players: 5, failsRequired: 2 }, // Round 4 (Special Rule: 2 fails needed)
  { players: 5, failsRequired: 1 }, // Round 5
];


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
    let intelNames = [];

    // Logic to gather names for the "Secret Intel" list
    if (room.gameStarted && myChar) {
      room.players.forEach((other) => {
        if (other.id === p.id) return; // Skip myself

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
      players: room.players.map((other) => ({
        ...other,
        character: other.id === p.id ? other.character : null,
      })),
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

  socket.on("closeRoom", ({ roomCode, requesterId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    // Validation: Only GM can dissolve
    const gm = room.players.find(p => p.id === requesterId && p.isGameMaster);
    if (!gm) return socket.emit("errorMessage", "Unauthorized: Only the Master can dissolve HQ.");

    // 1. Notify everyone in the room
    io.to(roomCode).emit("roomDissolved");

    const roomSockets = io.sockets.adapter.rooms.get(roomCode);
    if (roomSockets) {
      for (const socketId of roomSockets) {
        const s = io.sockets.sockets.get(socketId);
        if (s) s.leave(roomCode);
      }
    }

    // 2. Remove room from memory
    delete rooms[roomCode];
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

    // Initialize history if it doesn't exist
    if (!room.generalHistory) {
      room.generalHistory = [];
    }

    room.proposedTeam = [];

    // Filter out players who have already been General in this cycle
    let eligiblePlayers = room.players.filter(p => !room.generalHistory.includes(p.id));

    if (room.generalHistory.length === 0 && eligiblePlayers.length > 1) {
      eligiblePlayers = eligiblePlayers.filter(p => p.id !== requesterId);
    }

    // If everyone has been General, reset the cycle
    if (eligiblePlayers.length === 0) {
      room.generalHistory = [];
      eligiblePlayers = room.players;
    }

    // Pick a random player from the ELIGIBLE pool
    const randomIndex = Math.floor(Math.random() * eligiblePlayers.length);
    const newGeneral = eligiblePlayers[randomIndex];

    // Update history
    room.generalHistory.push(newGeneral.id);

    // Update the room state
    room.players.forEach((p) => {
      p.isGeneral = (p.id === newGeneral.id);
    });

    // 1. Send the data update
    broadcastRoomUpdate(roomCode);

    // 2. Trigger the animation for all clients
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
      if (!isTeamMember) {
        console.log(`Unauthorized vote attempt by ${playerId}`);
        return; // Exit if a spectator tries to vote during a secret mission
      }
    }

    room.voting.votes[playerId] = choice;

    const targetCount = room.voting.type === "teamApproval" 
      ? room.players.length 
      : (room.proposedTeam?.length || 0);

      if (Object.keys(room.voting.votes).length === targetCount) {
        const yesVotes = Object.values(room.voting.votes).filter(v => v === "yes").length;
        const noVotes = Object.values(room.voting.votes).filter(v => v === "no").length;
    
        if (room.voting.type === "teamApproval") {
          // Logic for Council Vote (Majority check)
          room.voting.result = (noVotes >= room.players.length / 2) ? "No" : "Yes";
        } else {
          // --- NEW: MISSION RESOLUTION LOGIC ---
          const config = MISSION_REQUIREMENTS[room.currentRound - 1];
          
          // Check if sabotages (noVotes) met the requirement for this specific round
          if (noVotes >= config.failsRequired) {
            room.voting.result = "No"; // Red Wins Round
            room.scoreRed++;
            room.roundHistory.push("Red");
          } else {
            room.voting.result = "Yes"; // Green Wins Round
            room.scoreGreen++;
            room.roundHistory.push("Green");
          }
    
          // Check for Overall Match Winner (Best of 3)
          if (room.scoreGreen === 3) {
            room.gameStatus = "OVER";
            room.winner = "Nawabs (Green)";
          } else if (room.scoreRed === 3) {
            room.gameStatus = "OVER";
            room.winner = "EIC (Red)";
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

  socket.on("startGame", ({ roomCode, requesterId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const gm = room.players.find(p => p.id === requesterId && p.isGameMaster);
    if (!gm) return socket.emit("errorMessage", "Only GM allowed");

    const playerCount = room.players.length;
    if (playerCount < 2) return socket.emit("errorMessage", "Minimum 2 players required");

    const mirJafar = CharacterList.find(c => c.id === 1);
    const mirMadan = CharacterList.find(c => c.id === 8);
    let gameDeck = [mirMadan, mirJafar];

    if (playerCount >= 5) {
      const teamDistributions = { 5: [3, 2], 6: [4, 2], 7: [4, 3], 8: [5, 3], 9: [6, 3], 10: [6, 4] };
      const [nawabTarget, eicTarget] = teamDistributions[playerCount];
      const nawabPool = shuffle(CharacterList.filter(c => c.team === "Nawabs" && c.id !== 8));
      const eicPool = shuffle(CharacterList.filter(c => c.team === "East India Company (EIC)" && c.id !== 1));
      for (let i = 0; i < nawabTarget - 1; i++) gameDeck.push(nawabPool.pop());
      for (let i = 0; i < eicTarget - 1; i++) gameDeck.push(eicPool.pop());
    } else {
      const remainingPool = shuffle(CharacterList.filter(c => c.id !== 1 && c.id !== 8));
      while (gameDeck.length < playerCount) gameDeck.push(remainingPool.pop());
    }

    let deck = shuffle([...gameDeck]);
    let assignments = new Array(playerCount).fill(null);
    let usedDeckIndices = new Set();

    room.players.forEach((player, pIdx) => {
      for (let dIdx = 0; dIdx < deck.length; dIdx++) {
        if (!usedDeckIndices.has(dIdx) && deck[dIdx].id !== player.lastCharacterId) {
          assignments[pIdx] = deck[dIdx];
          usedDeckIndices.add(dIdx);
          break;
        }
      }
    });

    room.players.forEach((player, pIdx) => {
      if (!assignments[pIdx]) {
        const remainingIdx = deck.findIndex((_, i) => !usedDeckIndices.has(i));
        assignments[pIdx] = deck[remainingIdx];
        usedDeckIndices.add(remainingIdx);
      }

      if (player.character) {
        player.lastCharacterId = player.character.id;
      }
      player.character = assignments[pIdx];
    });

    // NEW: Initialize Round and Score Tracking
    room.currentRound = 1;
    room.scoreGreen = 0;
    room.scoreRed = 0;
    room.roundHistory = []; // Tracks "Green" or "Red" for each round
    room.gameStatus = "ACTIVE";

    room.guptochorId = null;      // Current investigator
    room.nextGuptochorId = null;  // Target who will be investigator next round
    room.guptochorUsed = false;   // Prevents multiple uses per round

    room.gameStarted = true;
    room.locked = true;
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
    room.voting = null;
    room.generalHistory = [];
    room.proposedTeam = [];

    room.players.forEach(player => {
      if (player.character) {
        player.lastCharacterId = player.character.id;
      }
      player.character = null;
      player.isGeneral = false;
    });

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

// server.listen(PORT, '0.0.0.0', () => {
//   console.log(`Server running on port ${PORT}`);
// });
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});