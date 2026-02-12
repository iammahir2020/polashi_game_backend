const { db, admin } = require('./firebase-admin'); // Use require

const GameLogger = {
  async logGameStart(roomCode, room) {
    try {
      const playerMap = {};
      room.players.forEach(p => {
        playerMap[p.id] = {
          name: p.name,
          role: p.character?.name,
          team: p.character?.team,
          isActive: room.activePlayerIds.includes(p.id)
        };
      });

      const logId = `${roomCode}-${Date.now()}`;
      room.currentLogId = logId; 

      await db.collection('game_logs').doc(logId).set({
        roomCode: roomCode,
        startTime: admin.firestore.FieldValue.serverTimestamp(),
        playerCount: room.activePlayerIds.length,
        identities: playerMap,
        status: 'IN_PROGRESS',
        roundHistory: []
      });
    } catch (e) { console.error("LogStart Error:", e); }
  },

  async logRoundResult(logId, roundIndex, data) {
    if (!logId) return;
    try {
      const roundKey = `round_${roundIndex}`;
      await db.collection('game_logs').doc(logId).update({
        [`rounds.${roundKey}`]: {
          general: data.generalName,
          team: data.proposedTeamNames,
          votes: data.councilVotes, 
          sabotages: data.sabotageCount,
          result: data.result, 
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        },
        roundHistory: admin.firestore.FieldValue.arrayUnion(data.result === "Success" ? "Green" : "Red")
      });
    } catch (e) { console.error("LogRound Error:", e); }
  },

  async logGameOver(logId, winner) {
    if (!logId) return;
    try {
      await db.collection('game_logs').doc(logId).update({
        endTime: admin.firestore.FieldValue.serverTimestamp(),
        winner: winner,
        status: 'COMPLETED'
      });
    } catch (e) { console.error("LogGameOver Error:", e); }
  }
};

module.exports = { GameLogger }; // Use module.exports