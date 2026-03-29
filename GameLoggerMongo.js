const GameLog = require('./models/GameLog');

const GameLoggerMongo = {
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

      const newLog = new GameLog({
        logId: logId,
        roomCode: roomCode,
        playerCount: room.activePlayerIds.length,
        identities: playerMap,
        status: 'IN_PROGRESS',
        roundHistory: []
      });

      await newLog.save();
      console.log(`📝 Log Started: ${logId}`);
    } catch (e) { console.error("MongoDB LogStart Error:", e); }
  },

  async logRoundResult(logId, roundIndex, data) {
    if (!logId) return;
    try {
      const roundKey = `round_${roundIndex}`;
      const historyColor = data.result === "Success" ? "Green" : "Red";

      // MongoDB update using dot notation for dynamic keys
      await GameLog.findOneAndUpdate(
        { logId: logId },
        { 
          $set: {
            [`rounds.${roundKey}`]: {
              general: data.generalName,
              team: data.proposedTeamNames,
              votes: data.councilVotes,
              sabotages: data.sabotageCount,
              result: data.result,
              timestamp: new Date()
            }
          },
          $push: { roundHistory: historyColor }
        }
      );
      console.log(`📝 Log Updated: Round ${roundIndex}`);
    } catch (e) { console.error("MongoDB LogRound Error:", e); }
  },

  async logGameOver(logId, winner) {
    if (!logId) return;
    try {
      await GameLog.findOneAndUpdate(
        { logId: logId },
        { 
          $set: {
            endTime: new Date(),
            winner: winner,
            status: 'COMPLETED'
          }
        }
      );
      console.log(`📝 Log Finalized: ${logId}`);
    } catch (e) { console.error("MongoDB LogGameOver Error:", e); }
  }
};

module.exports = { GameLoggerMongo };