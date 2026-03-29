const mongoose = require('mongoose');

const gameLogSchema = new mongoose.Schema({
  logId: { type: String, unique: true }, // The unique ID you generate
  roomCode: String,
  startTime: { type: Date, default: Date.now },
  endTime: Date,
  playerCount: Number,
  winner: String,
  identities: {
    type: Map,
    of: new mongoose.Schema({
      name: String,
      role: String,
      team: String,
      isActive: Boolean
    }, { _id: false })
  },
  status: { type: String, enum: ['IN_PROGRESS', 'COMPLETED'], default: 'IN_PROGRESS' },
  rounds: {
    type: Map,
    of: new mongoose.Schema({
      general: String,
      team: [String],
      votes: mongoose.Schema.Types.Mixed, // Stores { playerId: "yes"/"no" }
      sabotages: Number,
      result: String,
      timestamp: { type: Date, default: Date.now }
    }, { _id: false })
  },
  roundHistory: [String]
});

module.exports = mongoose.model('GameLog', gameLogSchema);