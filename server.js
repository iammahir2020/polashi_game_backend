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


// --- HELPERS ---

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
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
      });
    }

    const personalizedRoom = {
      ...room,
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
      turnIndex: 0
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
  
    // 2. Remove room from memory
    delete rooms[roomCode];
  });

  socket.on("reconnectPlayer", ({ roomCode, playerId }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit("errorMessage", "Room no longer exists");

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

    const randomIndex = Math.floor(Math.random() * room.players.length);
    const newGeneral = room.players[randomIndex];
    
    room.players.forEach((p, idx) => {
      p.isGeneral = (idx === randomIndex);
    });

    // 1. Send the data update
    broadcastRoomUpdate(roomCode);
    
    // 2. Explicitly trigger the animation event for all clients
    io.to(roomCode).emit("triggerGeneralAnimation", { name: newGeneral.name });
  });

  socket.on("startVote", ({ roomCode, requesterId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const gm = room.players.find(p => p.id === requesterId && p.isGameMaster);
    if (!gm) return;

    room.voting = { active: true, votes: {}, result: null };
    broadcastRoomUpdate(roomCode);
  });

  socket.on("castVote", ({ roomCode, playerId, choice }) => {
    const room = rooms[roomCode];
    if (!room || !room.voting || !room.voting.active) return;

    room.voting.votes[playerId] = choice;

    const totalPlayers = room.players.length;
    const votesCount = Object.keys(room.voting.votes).length;

    if (votesCount === totalPlayers) {
      const yesVotes = Object.values(room.voting.votes).filter(v => v === "yes").length;
      const noVotes = Object.values(room.voting.votes).filter(v => v === "no").length;

      room.voting.result = (noVotes >= totalPlayers / 2) ? "No" : "Yes";
      room.voting.active = false;
    }
    broadcastRoomUpdate(roomCode);
  });

  socket.on("clearVote", ({ roomCode, requesterId }) => {
    const room = rooms[roomCode];
    if (!room) return;
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
  
    // Mandatory Characters
    const mirJafar = CharacterList.find(c => c.id === 1);
    const mirMadan = CharacterList.find(c => c.id === 8);
    
    let gameDeck = [mirMadan, mirJafar];
  
    // Logic for 5-10 players (Strict Team Balancing)
    if (playerCount >= 5) {
      const teamDistributions = {
        5: [3, 2], 6: [4, 2], 7: [4, 3], 8: [5, 3], 9: [6, 3], 10: [6, 4]
      };
      const [nawabTarget, eicTarget] = teamDistributions[playerCount];
  
      const nawabPool = shuffle(CharacterList.filter(c => c.team === "Nawabs" && c.id !== 8));
      const eicPool = shuffle(CharacterList.filter(c => c.team === "East India Company (EIC)" && c.id !== 1));
  
      // Fill Nawabs (already have 1)
      for (let i = 0; i < nawabTarget - 1; i++) gameDeck.push(nawabPool.pop());
      // Fill EIC (already have 1)
      for (let i = 0; i < eicTarget - 1; i++) gameDeck.push(eicPool.pop());
  
    } 
    // Logic for 2-4 players (Mandatory first, then Random)
    else {
      const remainingPool = shuffle(CharacterList.filter(c => c.id !== 1 && c.id !== 8));
      
      // For exactly 2 players, the deck is already full with the 2 mandatory ones.
      // For 3 or 4, we add 1 or 2 more random characters.
      while (gameDeck.length < playerCount) {
        gameDeck.push(remainingPool.pop());
      }
    }
  
    // Final shuffle so Mir Jafar/Madan aren't always the first two players
    const finalShuffledDeck = shuffle(gameDeck);
  
    room.players.forEach((player, index) => {
      player.character = finalShuffledDeck[index];
    });
  
    room.gameStarted = true;
    room.locked = true; 
    broadcastRoomUpdate(roomCode);
  });

  // socket.on("assignGeneral", ({ roomCode, requesterId }) => {
  //   const room = rooms[roomCode];
  //   if (!room) return;

  //   // 1. Validation: Only GM can do this
  //   const gm = room.players.find(p => p.id === requesterId && p.isGameMaster);
  //   if (!gm) return socket.emit("errorMessage", "Only the GM can appoint a General.");

  //   // 2. Logic: Pick a random player
  //   const randomIndex = Math.floor(Math.random() * room.players.length);
    
  //   // 3. Clear existing general (if any) and set the new one
  //   room.players.forEach((p, idx) => {
  //     p.isGeneral = (idx === randomIndex);
  //   });

  //   broadcastRoomUpdate(roomCode);
  // });

  socket.on("resetGame", ({ roomCode, requesterId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const gm = room.players.find(p => p.id === requesterId && p.isGameMaster);
    if (!gm) return socket.emit("errorMessage", "Only the GM can reset the game.");

    room.gameStarted = false;
    room.locked = false;
    room.turnIndex = 0;
    room.voting = null;

    room.players.forEach(player => {
      player.character = null;
      player.isGeneral = false;
    });

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